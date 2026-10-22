// Builds data/donchian-alerts.json: Donchian 20/10 breakout trades (long and short) for the top 50
// non-stablecoin coins, on the 4H and Daily timeframes. Same rules as the TradingView Pine script and the
// in-app chart markers:
//   long  entry: a candle CLOSES above the highest high of the previous 20 candles
//   long  exit : while long, a candle closes below the lowest low of the previous 10 candles
//   short entry: a candle closes below the lowest low of the previous 20 candles
//   short exit : while short, a candle closes above the highest high of the previous 10 candles
// Long and short are tracked independently, one open trade per side. Only CLOSED candles are used, so a
// signal never appears and then disappears while a candle is still forming.
//
// DATA SOURCE: CoinDCX public futures candles, same endpoint and pacing as screen.js (that is what is
// known to work from GitHub's servers). Coins CoinDCX does not list as a USDT perp are skipped and
// reported in the output. The top-50 list comes from CoinGecko and is cached in data/top50.json (refreshed
// once a day, and reused if CoinGecko is unavailable).
//
// Besides the confirmed (closed-candle) trades, the candle that is still forming is checked against the
// same rules and reported separately as "forming" signals: an entry or exit that the live price is
// triggering right now but that is not confirmed until the candle closes (it can disappear again).
//
// Meant to be triggered every ~5 minutes (cron-job.org -> workflow_dispatch, see the workflow). Every run
// scans both timeframes (like screen.js does). The file is only rewritten when the signals changed, so
// most runs commit nothing. Set SKIP_IF_CURRENT=1 to skip a timeframe whose latest closed candle was
// already scanned (a cheaper mode that exits in about a second between candle closes).
//
// Node 20+ (built-in fetch). Run: node scripts/donchian-alerts.js [--force]
const fs = require('fs');
const path = require('path');

const ENTRY_LEN = 20;
const EXIT_LEN = 10;
const TOP_N = 50;
const HOUR = 3600e3, DAY = 86400e3;

// keepClosedMs: how long a CLOSED trade stays in the list after its exit. Open trades always stay.
const TIMEFRAMES = [
  { label: '4H', resolution: '4h', periodMs: 4 * HOUR, historyDays: 60, keepClosedMs: 2 * DAY },
  { label: '1D', resolution: '1d', periodMs: DAY, historyDays: 300, keepClosedMs: 7 * DAY },
];

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'donchian-alerts.json');
const TOP50_FILE = path.join(DATA_DIR, 'top50.json');
const TOP50_MAX_AGE_MS = 24 * HOUR;

const COINDCX_API_BASE = 'https://api.coindcx.com';
const COINDCX_PUBLIC_BASE = 'https://public.coindcx.com';
const ACTIVE_INSTRUMENTS_URL = `${COINDCX_API_BASE}/exchange/v1/derivatives/futures/data/active_instruments`;
const FUTURES_CANDLES_URL = `${COINDCX_PUBLIC_BASE}/market_data/candlesticks`;
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false';
const COINGECKO_STABLES = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=stablecoins&order=market_cap_desc&per_page=250&page=1&sparkline=false';

// Stablecoins plus pegged / tokenized assets that are not ordinary coins. Used on top of CoinGecko's own
// stablecoin category so a stablecoin that category misses is still excluded.
const EXCLUDED_SYMBOLS = new Set([
  'usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'usdp', 'pyusd', 'gusd', 'usdd', 'frax', 'lusd', 'susd',
  'eurs', 'eurt', 'usdj', 'busd', 'usdx', 'usd1', 'usdtb', 'eurc', 'usds', 'usdg', 'rlusd', 'usdf', 'u',
  'bfusd', 'usdgo', 'ousd', 'gho', 'usdy', 'usyc', 'buidl', 'eursafo', 'figr_heloc', 'xaut', 'paxg',
]);

const FORCE = process.argv.includes('--force') || process.env.FORCE === '1';
const SKIP_IF_CURRENT = process.env.SKIP_IF_CURRENT === '1' && !FORCE;

// ---------------- fetch helpers (same pacing approach as screen.js) ----------------
const CONCURRENCY = 3;
const MIN_REQUEST_GAP_MS = 300;
const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_GAP_MS;
  if (wait > 0) await sleep(wait);
}
async function fetchWithTimeout(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } }); }
  finally { clearTimeout(t); }
}
async function fetchJSON(url, { paced = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (paced) await throttle();
    try {
      const res = await fetchWithTimeout(url);
      const raw = await res.text();
      if (res.status === 429) { lastErr = new Error(`HTTP 429 for ${url}`); await sleep(Math.min(15000, 1000 * 2 ** attempt) + Math.random() * 300); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url} :: ${raw.slice(0, 200)}`);
      if (!raw) throw new Error(`Empty body for ${url}`);
      return JSON.parse(raw);
    } catch (e) {
      lastErr = e;
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      break;
    }
  }
  throw lastErr;
}

// ---------------- universe: top 50 non-stablecoins that CoinDCX lists as USDT perps ----------------
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function pairFor(symbol, instruments) {
  const S = symbol.toUpperCase();
  for (const [pair, mult] of [[`B-${S}_USDT`, 1], [`B-1000${S}_USDT`, 1000]]) {
    if (instruments.has(pair)) return { pair, mult };
  }
  return null;
}

async function loadUniverse(instruments) {
  const cached = readJSON(TOP50_FILE);
  const fresh = cached && cached.updated && Date.now() - Date.parse(cached.updated) < TOP50_MAX_AGE_MS;
  if (fresh && !FORCE) { console.log('using cached top 50 (' + cached.updated + ')'); return cached; }
  try {
    const markets = await fetchJSON(COINGECKO_MARKETS, { paced: false });
    let stableIds = new Set();
    try { stableIds = new Set((await fetchJSON(COINGECKO_STABLES, { paced: false })).map((c) => c.id)); }
    catch (e) { console.warn('stablecoin category fetch failed, using the built-in list only: ' + e.message); }
    const coins = markets
      .filter((c) => !stableIds.has(c.id) && !EXCLUDED_SYMBOLS.has(String(c.symbol).toLowerCase()))
      .slice(0, TOP_N)
      .map((c, i) => ({ rank: i + 1, cgRank: c.market_cap_rank, symbol: String(c.symbol).toUpperCase(), name: c.name }));
    if (coins.length < 30) throw new Error('top list too short: ' + coins.length);
    const out = { updated: new Date().toISOString(), coins: [], skipped: [] };
    for (const c of coins) {
      const m = pairFor(c.symbol, instruments);
      if (m) out.coins.push({ ...c, pair: m.pair, mult: m.mult });
      else out.skipped.push({ rank: c.rank, symbol: c.symbol, name: c.name, reason: 'no CoinDCX USDT perp' });
    }
    fs.writeFileSync(TOP50_FILE, JSON.stringify(out));
    console.log(`top 50 refreshed: ${out.coins.length} scannable, ${out.skipped.length} skipped`);
    return out;
  } catch (e) {
    if (cached) { console.warn('CoinGecko failed (' + e.message + '), reusing cached top 50'); return cached; }
    throw e;
  }
}

// ---------------- candles ----------------
async function getCandles(pair, tf) {
  const toSec = Math.floor(Date.now() / 1000);
  const qs = new URLSearchParams({ pair, resolution: tf.resolution, from: String(toSec - tf.historyDays * 86400), to: String(toSec), pcode: 'f' });
  const body = await fetchJSON(`${FUTURES_CANDLES_URL}?${qs}`);
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
  if (!rows) throw new Error('unexpected candlesticks response');
  const now = Date.now();
  const all = [...rows].sort((a, b) => a.time - b.time)
    .map((k) => ({ t: Number(k.time), high: parseFloat(k.high), low: parseFloat(k.low), close: parseFloat(k.close) }))
    .filter((k) => Number.isFinite(k.close));
  const closed = all.filter((k) => k.t + tf.periodMs <= now);
  const forming = all.find((k) => k.t + tf.periodMs > now && k.t <= now) || null; // the candle still open
  return { closed, forming };
}

// ---------------- Donchian 20/10 state machine (same rules as the Pine script) ----------------
function walk(candles, side) {
  const trades = [];
  let open = null;
  for (let i = ENTRY_LEN; i < candles.length; i++) {
    const c = candles[i];
    let hiE = -Infinity, loE = Infinity, hiX = -Infinity, loX = Infinity;
    for (let j = i - ENTRY_LEN; j < i; j++) { if (candles[j].high > hiE) hiE = candles[j].high; if (candles[j].low < loE) loE = candles[j].low; }
    for (let j = i - EXIT_LEN; j < i; j++) { if (candles[j].high > hiX) hiX = candles[j].high; if (candles[j].low < loX) loX = candles[j].low; }
    if (!open) {
      const hit = side === 'long' ? c.close > hiE : c.close < loE;
      if (hit) open = { side, entryTime: c.t, entryClose: c.close, entryLevel: side === 'long' ? hiE : loE };
    } else {
      const out = side === 'long' ? c.close < loX : c.close > hiX;
      if (out) {
        const pct = (side === 'long' ? c.close - open.entryClose : open.entryClose - c.close) / open.entryClose * 100;
        trades.push({ ...open, status: 'closed', exitTime: c.t, exitClose: c.close, exitLevel: side === 'long' ? loX : hiX, resultPct: pct });
        open = null;
      }
    }
  }
  if (open) trades.push({ ...open, status: 'open' });
  return trades;
}

// Checks the still-open candle against the same rules, given the confirmed state from walk().
// Returns an array of {kind:'entry'|'exit', side, ...} signals the live price is triggering right now.
function formingSignals(closed, forming, trades, periodMs) {
  const out = [];
  if (!forming || closed.length < ENTRY_LEN) return out;
  const prior = (n) => closed.slice(-n);
  const hiE = Math.max(...prior(ENTRY_LEN).map((c) => c.high)), loE = Math.min(...prior(ENTRY_LEN).map((c) => c.low));
  const hiX = Math.max(...prior(EXIT_LEN).map((c) => c.high)), loX = Math.min(...prior(EXIT_LEN).map((c) => c.low));
  for (const side of ['long', 'short']) {
    const open = trades.find((t) => t.side === side && t.status === 'open');
    const px = forming.close;
    if (!open) {
      if (side === 'long' ? px > hiE : px < loE) out.push({ kind: 'entry', side, price: px, level: side === 'long' ? hiE : loE });
    } else if (side === 'long' ? px < loX : px > hiX) {
      const pct = (side === 'long' ? px - open.entryClose : open.entryClose - px) / open.entryClose * 100;
      out.push({ kind: 'exit', side, price: px, level: side === 'long' ? loX : hiX, entryTime: open.entryTime, entryClose: open.entryClose, resultPct: pct });
    }
  }
  return out.map((o) => ({ ...o, candleTime: forming.t, closesAt: forming.t + periodMs }));
}

const round = (v, d = 6) => (Number.isFinite(v) ? +v.toPrecision(d + 3) : null);

function scanCoin(coin, data, tf) {
  const candles = data.closed;
  if (candles.length < ENTRY_LEN + 2) return { trades: [], forming: [], lastT: null };
  const last = candles[candles.length - 1];
  const keepFrom = Date.now() - tf.keepClosedMs;
  const trades = [];
  const walked = [];
  for (const side of ['long', 'short']) {
    for (const t of walk(candles, side)) {
      walked.push(t);
      if (t.status === 'closed' && t.exitTime < keepFrom) continue;
      const unreal = t.status === 'open' ? (side === 'long' ? last.close - t.entryClose : t.entryClose - last.close) / t.entryClose * 100 : null;
      trades.push({
        symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side, status: t.status,
        entryTime: t.entryTime, entryClose: round(t.entryClose), entryLevel: round(t.entryLevel),
        exitTime: t.exitTime || null, exitClose: round(t.exitClose), exitLevel: round(t.exitLevel),
        resultPct: t.status === 'closed' ? +t.resultPct.toFixed(2) : null,
        lastClose: round(last.close), lastTime: last.t,
        unrealizedPct: unreal == null ? null : +unreal.toFixed(2),
      });
    }
  }
  const forming = formingSignals(candles, data.forming, walked, tf.periodMs).map((f) => ({
    symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side: f.side, kind: f.kind,
    candleTime: f.candleTime, closesAt: f.closesAt, price: round(f.price), level: round(f.level),
    entryTime: f.entryTime || null, entryClose: round(f.entryClose), resultPct: f.resultPct == null ? null : +f.resultPct.toFixed(2),
  }));
  return { trades, forming, lastT: last.t };
}

async function pool(items, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const item = items[i++]; await worker(item); }
  }));
}

// ---------------- main ----------------
async function main() {
  const prev = readJSON(OUT);
  const now = Date.now();

  // Which timeframes have a newly closed candle since the last scan? Expected = open time of the last fully closed candle.
  const due = TIMEFRAMES.filter((tf) => {
    const expected = Math.floor(now / tf.periodMs) * tf.periodMs - tf.periodMs;
    tf.expected = expected;
    const asOf = prev && prev.timeframes && prev.timeframes[tf.label] && prev.timeframes[tf.label].asOf;
    return !SKIP_IF_CURRENT || !asOf || asOf < expected;
  });
  if (!due.length) { console.log('no new 4H/1D candle since the last scan, nothing to do (SKIP_IF_CURRENT)'); return; }
  console.log('scanning: ' + due.map((t) => t.label).join(', '));

  const instruments = new Set(await fetchJSON(ACTIVE_INSTRUMENTS_URL));
  const universe = await loadUniverse(instruments);
  if (!universe.coins.length) throw new Error('no scannable coins');

  const next = {
    updated: new Date().toISOString(),
    rules: { entry: ENTRY_LEN, exit: EXIT_LEN },
    universe: { source: 'CoinGecko top 50 excluding stablecoins; candles from CoinDCX USDT perps', updated: universe.updated, scanned: universe.coins.length, skipped: universe.skipped },
    timeframes: { ...((prev && prev.timeframes) || {}) },
  };

  for (const tf of due) {
    const trades = [];
    const forming = [];
    const failed = [];
    let atExpected = 0;
    await pool(universe.coins, async (coin) => {
      try {
        const res = scanCoin(coin, await getCandles(coin.pair, tf), tf);
        trades.push(...res.trades);
        forming.push(...res.forming);
        if (res.lastT === tf.expected) atExpected++;
      } catch (e) { failed.push(coin.symbol); console.warn(`${tf.label} ${coin.symbol}: ${e.message}`); }
    });
    if (failed.length >= universe.coins.length) throw new Error(`${tf.label}: every coin failed`);
    trades.sort((a, b) => (b.exitTime || b.entryTime) - (a.exitTime || a.entryTime));
    forming.sort((a, b) => a.symbol.localeCompare(b.symbol));
    // Only mark this candle as scanned once most coins actually have it, otherwise try again on the next run.
    const complete = atExpected >= Math.ceil(universe.coins.length * 0.8);
    const prevAsOf = prev && prev.timeframes && prev.timeframes[tf.label] ? prev.timeframes[tf.label].asOf : null;
    next.timeframes[tf.label] = { asOf: complete ? tf.expected : prevAsOf, candleTime: tf.expected, scanned: universe.coins.length - failed.length, failed, trades, forming, formingAt: new Date().toISOString() };
    console.log(`${tf.label}: ${trades.length} trades (${trades.filter((t) => t.status === 'open').length} open), ${forming.length} forming, ${failed.length} failed, candle ${new Date(tf.expected).toISOString()} on ${atExpected}/${universe.coins.length} coins`);
  }

  // Forming signals carry a live price that drifts every run; compare only WHICH signals exist so the file
  // (and git history) change when a signal appears or disappears, not on every price tick.
  const strip = (o) => JSON.stringify({
    ...o, updated: null, universe: o.universe && { ...o.universe, updated: null },
    timeframes: Object.fromEntries(Object.entries(o.timeframes || {}).map(([k, v]) => [k, {
      ...v, formingAt: null, forming: (v.forming || []).map((f) => [f.symbol, f.side, f.kind, f.candleTime]),
    }])),
  });
  if (prev && strip(prev) === strip(next)) { console.log('no change in signals, file not rewritten'); return; }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(next));
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
