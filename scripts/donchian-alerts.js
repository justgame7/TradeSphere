// Builds data/donchian-alerts.json: Donchian 20/10 and 55/20 breakout trades, plus Ichimoku breakout trades, (long and short) for the top 50
// non-stablecoin coins, on the 1H, 4H, Daily and Weekly timeframes. Same rules as the TradingView Pine script and the
// in-app chart markers:
//   long  entry: a candle CLOSES above the highest high of the previous N candles
//   long  exit : while long, a candle closes below the lowest low of the previous M candles
//   short entry: a candle closes below the lowest low of the previous N candles
//   short exit : while short, a candle closes above the highest high of the previous M candles
// with N/M = 20/10 and 55/20 (SYSTEMS). Each trade and forming signal carries its `system`.
// Long and short are tracked independently, one open trade per side. Only CLOSED candles are used, so a
// signal never appears and then disappears while a candle is still forming.
//
// DATA SOURCE: CoinDCX public futures candles, same endpoint and pacing as scripts/screen.js (that is what is
// known to work from GitHub's servers). Coins CoinDCX does not list as a USDT perp are skipped and
// reported in the output. The top-50 list comes from CoinGecko and is cached in data/top50.json (refreshed
// once a day, and reused if CoinGecko is unavailable).
//
// Besides the confirmed (closed-candle) trades, the candle that is still forming is checked against the
// same rules and reported separately as "forming" signals: an entry or exit that the live price is
// triggering right now but that is not confirmed until the candle closes (it can disappear again).
//
// Meant to be triggered every ~5 minutes (cron-job.org -> workflow_dispatch, see the workflow). Every run
// scans both timeframes (like scripts/screen.js does). The file is only rewritten when the signals changed, so
// most runs commit nothing. Set SKIP_IF_CURRENT=1 to skip a timeframe whose latest closed candle was
// already scanned (a cheaper mode that exits in about a second between candle closes).
//
// Node 20+ (built-in fetch). Run: node scripts/donchian-alerts.js [--force]
const fs = require('fs');
const path = require('path');

// Two turtle-style systems, both evaluated on the same candles: entry lookback / exit lookback.
const ALL_SYSTEMS = [
  { key: '20/10', entry: 20, exit: 10 },
  { key: '55/20', entry: 55, exit: 20 },
];
// 55/20 is switched off: its signals came late with a wide stop and it had the weakest results in the summary report.
// To bring it back, remove '55/20' from this list (the app and the report read the same `rules.systems` list).
const DISABLED_SYSTEMS = ['55/20'];
const SYSTEMS = ALL_SYSTEMS.filter((x) => !DISABLED_SYSTEMS.includes(x.key));
// The universe is the first 100 scannable coins. Donchian only uses the first 50 of them; Ichimoku, CHoCH, BOS and the retracement list
// cover all 100, and the app trims them back to 50 when Settings says so (each coin carries its rank in `universe.ranks`).
const TOP_N = 100;
const DONCHIAN_TOP = 50;
const HOUR = 3600e3, DAY = 86400e3;

// keepClosedMs: how long a CLOSED trade stays in the list after its exit. Open trades always stay.
const TIMEFRAMES = [
  { label: '1H', resolution: '1h', periodMs: HOUR, historyDays: 14, keepClosedMs: 1 * DAY },
  { label: '4H', resolution: '4h', periodMs: 4 * HOUR, historyDays: 60, keepClosedMs: 2 * DAY },
  { label: '1D', resolution: '1d', periodMs: DAY, historyDays: 300, keepClosedMs: 7 * DAY },
  // Weekly candles open on Monday 00:00 UTC (epoch day 0 was a Thursday, so Monday is 4 days after it).
  { label: '1W', resolution: '1w', periodMs: 7 * DAY, offsetMs: 4 * DAY, historyDays: 1100, keepClosedMs: 28 * DAY },
];

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, 'donchian-alerts.json');
// Compact trade history for the app's Summary report (every trade of the walk, not only the recent ones in OUT).
const HIST_OUT = path.join(DATA_DIR, 'alerts-history.json');
const TOP50_FILE = path.join(DATA_DIR, 'top50.json');
const TOP50_MAX_AGE_MS = 24 * HOUR;
const DETECT_GRACE_MS = 60 * 60e3; // a closed-candle signal first seen within an hour of its close counts as newly detected

const COINDCX_API_BASE = 'https://api.coindcx.com';
const COINDCX_PUBLIC_BASE = 'https://public.coindcx.com';
const ACTIVE_INSTRUMENTS_URL = `${COINDCX_API_BASE}/exchange/v1/derivatives/futures/data/active_instruments`;
const FUTURES_CANDLES_URL = `${COINDCX_PUBLIC_BASE}/market_data/candlesticks`;
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false';
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

// ---------------- fetch helpers (same pacing approach as scripts/screen.js) ----------------
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

// ---------------- universe: the first 100 non-stablecoins (by market cap) that CoinDCX lists as USDT perps ----------------
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
  // v: 3 = "100 scannable coins" (coins without a CoinDCX perp are skipped and replaced by the next ones). Each coin gets `u`, its place in the list.
  const withU = (u) => { u.coins.forEach((c, i) => { c.u = i + 1; }); return u; };
  const fresh = cached && cached.v === 3 && cached.updated && Date.now() - Date.parse(cached.updated) < TOP50_MAX_AGE_MS;
  if (fresh && !FORCE) { console.log('using cached top ' + TOP_N + ' (' + cached.updated + ')'); return withU(cached); }
  try {
    const markets = await fetchJSON(COINGECKO_MARKETS, { paced: false });
    let stableIds = new Set();
    try { stableIds = new Set((await fetchJSON(COINGECKO_STABLES, { paced: false })).map((c) => c.id)); }
    catch (e) { console.warn('stablecoin category fetch failed, using the built-in list only: ' + e.message); }
    // Walk the market-cap ranking (stablecoins removed) and keep going until TOP_N coins that CoinDCX actually lists
    // are collected. A coin with no CoinDCX USDT perp is skipped (and reported) and the next coin takes its place,
    // so 50 coins are scanned, not 50 minus the unlisted ones.
    const ranked = markets
      .filter((c) => !stableIds.has(c.id) && !EXCLUDED_SYMBOLS.has(String(c.symbol).toLowerCase()))
      .map((c, i) => ({ rank: i + 1, cgRank: c.market_cap_rank, symbol: String(c.symbol).toUpperCase(), name: c.name }));
    const out = { v: 3, updated: new Date().toISOString(), coins: [], skipped: [] };
    for (const c of ranked) {
      if (out.coins.length >= TOP_N) break;
      const m = pairFor(c.symbol, instruments);
      if (m) out.coins.push({ ...c, pair: m.pair, mult: m.mult });
      else out.skipped.push({ rank: c.rank, symbol: c.symbol, name: c.name, reason: 'no CoinDCX USDT perp' });
    }
    if (out.coins.length < 30) throw new Error('too few scannable coins: ' + out.coins.length);
    withU(out);
    fs.writeFileSync(TOP50_FILE, JSON.stringify(out));
    console.log(`top list refreshed: ${out.coins.length} scannable (down to rank ${out.coins[out.coins.length - 1].rank}), ${out.skipped.length} skipped`);
    return out;
  } catch (e) {
    if (cached) { console.warn('CoinGecko failed (' + e.message + '), reusing the cached list'); return withU(cached); }
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
function walk(candles, side, sys) {
  const ENTRY_LEN = sys.entry, EXIT_LEN = sys.exit;
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
function formingSignals(closed, forming, trades, periodMs, sys) {
  const ENTRY_LEN = sys.entry, EXIT_LEN = sys.exit;
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

// ---------------- Ichimoku breakout (same maths as screen.js / screener.html: 9 / 26 / 52, cloud shifted 26) ----------------
// Entry (long): the close breaks above the cloud with the Chikou span clear of it and the trend filter on:
//   PK (price breakout): previous close below the cloud top, this close above it
//   CK (Chikou breakout): the Chikou span crosses above the cloud (previous close below the Chikou-bar cloud top, this close above it)
//   both also need: close above the cloud top AND above the cloud top at the Chikou bar, Tenkan > Kijun, future Senkou A > B
// Short is the mirror image. Either trigger enters; the trade records which one fired (PK, CK or CK+PK).
// Exit: the close goes beyond Kijun (long: closes below Kijun, short: closes above it).
// The volume gate used by the screener is not applied: these are the top 50 coins, all liquid.
const ICHI = { tenkan: 9, kijun: 26, senkouB: 52 };
const ICHI_MIN_BARS = 2 * ICHI.kijun + ICHI.senkouB + 10; // 114, same minimum as the screener
// Initial stop loss, fixed when the trade is taken: a long is entered after the close breaks above the cloud top, so the
// stop sits 0.5 x ATR(14) below the cloud bottom; a short is the mirror (0.5 x ATR above the cloud top). A close beyond
// it exits the trade, as does the Kijun rule below, whichever comes first.
const ICHI_SL_ATR = 0.5;

// Wilder ATR for every bar (NaN until there are enough candles); the last value equals atrWilder().
function atrSeries(c, len = 14) {
  const out = new Array(c.length).fill(NaN);
  if (c.length <= len) return out;
  const tr = [NaN];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  let v = 0;
  for (let i = 1; i <= len; i++) v += tr[i];
  v /= len; out[len] = v;
  for (let i = len + 1; i < c.length; i++) { v = (v * (len - 1) + tr[i]) / len; out[i] = v; }
  return out;
}
const ichiStopLoss = (S, i, side, sig) => (side === 'long' ? sig.cloud.bottom - ICHI_SL_ATR * S.atr[i] : sig.cloud.top + ICHI_SL_ATR * S.atr[i]);

function ichiSeries(c) {
  const n = c.length;
  const mid = (len, i) => {
    if (i - len + 1 < 0) return NaN;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) { if (c[j].high > hh) hh = c[j].high; if (c[j].low < ll) ll = c[j].low; }
    return (hh + ll) / 2;
  };
  const tenkan = [], kijun = [], sA = [], sB = [];
  for (let i = 0; i < n; i++) {
    tenkan[i] = mid(ICHI.tenkan, i); kijun[i] = mid(ICHI.kijun, i);
    sA[i] = (Number.isNaN(tenkan[i]) || Number.isNaN(kijun[i])) ? NaN : (tenkan[i] + kijun[i]) / 2;
    sB[i] = mid(ICHI.senkouB, i);
  }
  const cloudAt = (idx) => (idx < 0 ? { top: NaN, bottom: NaN } : { top: Math.max(sA[idx], sB[idx]), bottom: Math.min(sA[idx], sB[idx]) });
  return { c, tenkan, kijun, sA, sB, atr: atrSeries(c), cloudBar: (t) => cloudAt(t - ICHI.kijun), cloudChikou: (t) => cloudAt(t - 2 * ICHI.kijun) };
}

// Breakout signals at bar i, or null while there is not enough history for every line.
function ichiSignalAt(S, i) {
  if (i < 1) return null;
  const price = S.c[i].close, prev = S.c[i - 1].close;
  const cloud = S.cloudBar(i), cloudPrev = S.cloudBar(i - 1), chk = S.cloudChikou(i), chkPrev = S.cloudChikou(i - 1);
  const tenkan = S.tenkan[i], kijun = S.kijun[i], futA = S.sA[i], futB = S.sB[i];
  const vals = [cloud.top, cloud.bottom, cloudPrev.top, cloudPrev.bottom, chk.top, chk.bottom, chkPrev.top, chkPrev.bottom, tenkan, kijun, futA, futB];
  if (!vals.every((v) => !Number.isNaN(v))) return null;
  const longTrend = tenkan > kijun && futA > futB, shortTrend = tenkan < kijun && futB > futA;
  const ckLong = prev < chkPrev.top && price > chk.top && price > cloud.top && longTrend;
  const pkLong = prev < cloudPrev.top && price > cloud.top && price > chk.top && longTrend;
  const ckShort = prev > chkPrev.bottom && price < chk.bottom && price < cloud.bottom && shortTrend;
  const pkShort = prev > cloudPrev.bottom && price < cloud.bottom && price < chk.bottom && shortTrend;
  return { price, kijun, cloud, chk, ckLong, pkLong, ckShort, pkShort };
}
const ichiTrigger = (ck, pk) => (ck && pk ? 'CK+PK' : ck ? 'CK' : 'PK');
// Level that was broken: the Chikou-bar cloud edge for a pure CK breakout, otherwise the cloud edge (as the screener reports it).
const ichiLevel = (sig, side, ck, pk) => (ck && !pk ? (side === 'long' ? sig.chk.top : sig.chk.bottom) : (side === 'long' ? sig.cloud.top : sig.cloud.bottom));

function walkIchimoku(S, side) {
  const trades = [];
  let open = null;
  for (let i = 1; i < S.c.length; i++) {
    const sig = ichiSignalAt(S, i);
    if (!sig) continue;
    const c = S.c[i];
    if (!open) {
      const ck = side === 'long' ? sig.ckLong : sig.ckShort, pk = side === 'long' ? sig.pkLong : sig.pkShort;
      if (ck || pk) open = { side, entryTime: c.t, entryClose: c.close, entryLevel: ichiLevel(sig, side, ck, pk), trigger: ichiTrigger(ck, pk), sl: ichiStopLoss(S, i, side, sig) };
    } else {
      const hitSL = side === 'long' ? c.close < open.sl : c.close > open.sl;
      const hitK = side === 'long' ? c.close < sig.kijun : c.close > sig.kijun;
      if (hitSL || hitK) {
        const pct = (side === 'long' ? c.close - open.entryClose : open.entryClose - c.close) / open.entryClose * 100;
        trades.push({ ...open, status: 'closed', exitTime: c.t, exitClose: c.close, exitLevel: hitSL ? open.sl : sig.kijun, exitReason: hitSL ? 'stop' : 'kijun', resultPct: pct });
        open = null;
      }
    }
  }
  if (open) trades.push({ ...open, status: 'open' });
  return trades;
}

// The still-open candle appended as the last bar: is it triggering an Ichimoku entry or exit right now?
function formingIchimoku(closed, forming, trades, periodMs) {
  if (!forming || closed.length + 1 < ICHI_MIN_BARS) return [];
  const S = ichiSeries([...closed, forming]);
  const i = S.c.length - 1;
  const sig = ichiSignalAt(S, i);
  if (!sig) return [];
  const out = [];
  for (const side of ['long', 'short']) {
    const open = trades.find((t) => t.side === side && t.status === 'open');
    if (!open) {
      const ck = side === 'long' ? sig.ckLong : sig.ckShort, pk = side === 'long' ? sig.pkLong : sig.pkShort;
      if (ck || pk) out.push({ kind: 'entry', side, price: sig.price, level: ichiLevel(sig, side, ck, pk), trigger: ichiTrigger(ck, pk), sl: ichiStopLoss(S, i, side, sig) });
    } else {
      const hitSL = side === 'long' ? sig.price < open.sl : sig.price > open.sl;
      const hitK = side === 'long' ? sig.price < sig.kijun : sig.price > sig.kijun;
      if (hitSL || hitK) {
        const pct = (side === 'long' ? sig.price - open.entryClose : open.entryClose - sig.price) / open.entryClose * 100;
        out.push({ kind: 'exit', side, price: sig.price, level: hitSL ? open.sl : sig.kijun, exitReason: hitSL ? 'stop' : 'kijun', entryTime: open.entryTime, entryClose: open.entryClose, resultPct: pct });
      }
    }
  }
  return out.map((o) => ({ ...o, candleTime: forming.t, closesAt: forming.t + periodMs }));
}

// ---------------- Bullish CHoCH and Bullish BOS (long only, 4H and Daily) ----------------
// Same swing and bias definitions as the app's Market Structure card: a swing high / low is a strict fractal (3 candles each side,
// confirmed 3 candles later); bias is Bullish when the last two swing highs AND lows are rising, Bearish when both are falling.
//   Bullish CHoCH: the first CLOSE above the last swing high while the bias is Bearish (the downtrend's structure breaks).
//   Bullish BOS:   the first CLOSE above the last swing high while the bias is Bullish (the uptrend continues).
// Entry: the close of that candle. Stop loss: the last swing low at entry (fixed, checked on closes). A swing level only counts the
// first time it is broken. Exit modes (chosen per timeframe from the backtests, 50 coins, ~3 years):
//   'struct'  trailing stop = the newest confirmed swing low formed after entry (never lowered)
//   'trail'   a close below the lowest low of the previous 10 candles (or below the stop loss)
// Filters (BOS only): ema200 = the entry close must be above the 200-period EMA; riskCap = skip when the stop is more than N% below entry.
// Backtest per trade: CHoCH Daily +10.1% (4H +1.0%), BOS Daily +10.0% with the EMA200 filter (4H +1.1% with the 5% stop cap).
// Weekly was added on request: the backtest was negative there (CHoCH about -28%, BOS about -14% per trade, only 16 to 23 trades), and the
// 200-period EMA filter cannot be used because a coin has fewer than 200 weekly candles.
const STRUCT_STRATS = [
  { key: 'CHoCH', kind: 'choch', tfs: { '4H': { mode: 'trail' }, '1D': { mode: 'struct' }, '1W': { mode: 'struct' } } },
  { key: 'BOS', kind: 'bos', tfs: { '4H': { mode: 'trail', riskCap: 5 }, '1D': { mode: 'struct', ema200: true }, '1W': { mode: 'struct' } } },
];
const CHOCH_SPAN = 3, CHOCH_TRAIL = 10, CHOCH_MIN_BARS = 60;
// How long a CLOSED CHoCH / BOS trade stays in the alerts file. Temporarily 60 days on Daily for analysis; delete this entry to go back
// to the timeframe default (7 days on Daily). The app reads the same value from the file, nothing else needs to change.
const STRUCT_KEEP_CLOSED_MS = { '1D': 60 * DAY };

function emaSeries200(c) {
  const k = 2 / 201, out = new Array(c.length).fill(NaN);
  let v = c[0].close;
  for (let i = 0; i < c.length; i++) { v = i ? c[i].close * k + v * (1 - k) : c[i].close; out[i] = i >= 200 ? v : NaN; }
  return out;
}

function structRun(c, kind, opt) {
  const n = c.length, sh = [], sl = [], broken = new Set(), trades = [], need = kind === 'bos' ? 'Bullish' : 'Bearish', mode = opt.mode;
  const ema = opt.ema200 ? emaSeries200(c) : null;
  let pos = null;
  const bias = () => {
    if (sh.length < 2 || sl.length < 2) return 'Range';
    const h1 = sh[sh.length - 2].p, h2 = sh[sh.length - 1].p, l1 = sl[sl.length - 2].p, l2 = sl[sl.length - 1].p;
    return h2 > h1 && l2 > l1 ? 'Bullish' : (h2 < h1 && l2 < l1 ? 'Bearish' : 'Range');
  };
  const trailLow = (i) => { let l = Infinity; for (let j = i - CHOCH_TRAIL; j < i; j++) if (c[j].low < l) l = c[j].low; return l; };
  const stopFor = (i) => (mode === 'struct' ? pos.stop : Math.max(pos.stop0, trailLow(i)));
  for (let i = 2 * CHOCH_SPAN + 20; i < n; i++) {
    const p = i - CHOCH_SPAN;
    let isH = true, isL = true;
    for (let j = p - CHOCH_SPAN; j <= p + CHOCH_SPAN; j++) { if (j === p) continue; if (c[j].high >= c[p].high) isH = false; if (c[j].low <= c[p].low) isL = false; }
    if (isH) sh.push({ idx: p, p: c[p].high });
    if (isL) sl.push({ idx: p, p: c[p].low });
    const k = c[i];
    if (pos) {
      if (mode === 'struct') for (let j = sl.length - 1; j >= 0; j--) { if (sl[j].idx <= pos.i) break; if (sl[j].p > pos.stop) pos.stop = sl[j].p; }
      const stop = stopFor(i);
      if (k.close < stop) {
        trades.push({ entryTime: pos.t, entryClose: pos.e, entryLevel: pos.level, sl: pos.stop0, status: 'closed', exitTime: k.t, exitClose: k.close, exitLevel: stop,
          exitReason: stop > pos.stop0 + 1e-12 ? 'trail' : 'stop', resultPct: (k.close - pos.e) / pos.e * 100 });
        pos = null;
      }
      continue;
    }
    if (!sh.length || !sl.length) continue;
    const lastH = sh[sh.length - 1], lastL = sl[sl.length - 1];
    let fire = k.close > lastH.p && !broken.has('H' + lastH.idx) && bias() === need;
    if (k.close > lastH.p) broken.add('H' + lastH.idx);
    if (k.close < lastL.p) broken.add('L' + lastL.idx);
    if (fire && lastL.p < k.close) {
      if (ema && !(k.close > ema[i])) fire = false;
      if (opt.riskCap && (k.close - lastL.p) / k.close * 100 > opt.riskCap) fire = false;
      if (fire) pos = { e: k.close, t: k.t, i, level: lastH.p, stop0: lastL.p, stop: lastL.p };
    }
  }
  const open = pos ? { entryTime: pos.t, entryClose: pos.e, entryLevel: pos.level, sl: pos.stop0, status: 'open', stop: stopFor(n) } : null;
  return { trades, open, sh, sl, broken, bias, need, emaLast: ema ? ema[n - 1] : NaN };
}

// The still-open candle: is it already closing above the last swing high in the right structure (entry), or below the stop of an open trade (exit)?
function structForming(run, forming, periodMs, opt) {
  if (!forming) return [];
  const px = forming.close, out = [];
  if (run.open) {
    if (px < run.open.stop) {
      out.push({ kind: 'exit', side: 'long', price: px, level: run.open.stop, exitReason: run.open.stop > run.open.sl + 1e-12 ? 'trail' : 'stop',
        entryTime: run.open.entryTime, entryClose: run.open.entryClose, resultPct: (px - run.open.entryClose) / run.open.entryClose * 100 });
    }
  } else if (run.sh.length && run.sl.length) {
    const lastH = run.sh[run.sh.length - 1], lastL = run.sl[run.sl.length - 1];
    let ok = px > lastH.p && !run.broken.has('H' + lastH.idx) && run.bias() === run.need && lastL.p < px;
    if (ok && opt.ema200 && !(px > run.emaLast)) ok = false;
    if (ok && opt.riskCap && (px - lastL.p) / px * 100 > opt.riskCap) ok = false;
    if (ok) out.push({ kind: 'entry', side: 'long', price: px, level: lastH.p, sl: lastL.p });
  }
  return out.map((o) => ({ ...o, candleTime: forming.t, closesAt: forming.t + periodMs }));
}

// ---------------- Retracement zone reference (not a strategy: no trades, just the swing levels) ----------------
// Same maths as the 50% / 61.8% retracement screen in screener.html and screen.js:
//   - swing points: a pivot high/low must be strictly beyond the wicks of the 3 candles on each side (RZ_SPAN)
//   - latest leg = most recent swing high <-> most recent swing low; low first = up-leg (a pullback is in progress),
//     high first = down-leg (a bounce is in progress)
//   - levels: 50% = midpoint, 61.8% = high - 0.618 x range (up-leg) or low + 0.618 x range (down-leg)
// The page checks the LIVE price against these levels ("in the zone" = within 1% of a level), so only the levels are
// stored. A leg smaller than RZ_MIN_LEG_ATR x ATR(14) is ignored, as it is noise. Closed candles only.
const RZ_SPAN = 3;
const RZ_MIN_LEG_ATR = 3;
const ATR_LEN = 14;

function atrWilder(c, len = ATR_LEN) {
  if (c.length <= len) return NaN;
  const tr = [];
  for (let i = 1; i < c.length; i++) tr.push(Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)));
  let v = tr.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = len; i < tr.length; i++) v = (v * (len - 1) + tr[i]) / len;
  return v;
}

function retraceLeg(c) {
  const n = c.length;
  if (n < RZ_SPAN * 2 + ATR_LEN + 2) return null;
  let lastHigh = null, lastLow = null;
  for (let i = RZ_SPAN; i < n - RZ_SPAN; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - RZ_SPAN; j <= i + RZ_SPAN; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isHigh = false;
      if (c[j].low <= c[i].low) isLow = false;
    }
    if (isHigh) lastHigh = { idx: i, price: c[i].high };
    if (isLow) lastLow = { idx: i, price: c[i].low };
  }
  if (!lastHigh || !lastLow || lastHigh.idx === lastLow.idx) return null;
  const range = lastHigh.price - lastLow.price;
  const atr = atrWilder(c);
  if (!(range > 0) || !Number.isFinite(atr) || range < RZ_MIN_LEG_ATR * atr) return null;
  const dir = lastLow.idx < lastHigh.idx ? 'bullish' : 'bearish';
  return {
    dir, high: lastHigh.price, low: lastLow.price, highTime: c[lastHigh.idx].t, lowTime: c[lastLow.idx].t,
    l50: (lastHigh.price + lastLow.price) / 2,
    l618: dir === 'bullish' ? lastHigh.price - 0.618 * range : lastLow.price + 0.618 * range,
    atr, lastClose: c[n - 1].close,
  };
}

const round = (v, d = 6) => (Number.isFinite(v) ? +v.toPrecision(d + 3) : null);

// The exit level that applies to the NEXT close of an open trade (the trailing stop): the lowest low (long) or highest
// high (short) of the last `exit` closed candles for Donchian, Kijun for Ichimoku. The chart view in the page shows it.
function stopNow(candles, side, sys) {
  const w = candles.slice(-sys.exit);
  return side === 'long' ? Math.min(...w.map((c) => c.low)) : Math.max(...w.map((c) => c.high));
}

function scanCoin(coin, data, tf) {
  const candles = data.closed;
  const minNeeded = Math.min(...SYSTEMS.map((x) => x.entry)) + 2;
  if (candles.length < minNeeded) return { trades: [], forming: [], retrace: null, hist: [], lastT: null };
  const last = candles[candles.length - 1];
  const keepFrom = Date.now() - tf.keepClosedMs;
  const trades = [];
  const forming = [];
  const hist = [];
  // [system, symbol, side (1 long, -1 short), entryTime, exitTime (0 while open), result % (null while open), exit reason (1 exit rule, 2 stop loss), entry close (open trades only)]
  const addHist = (system, t, side) => hist.push([system, coin.symbol, side === 'long' ? 1 : -1, t.entryTime, t.exitTime || 0, t.status === 'closed' ? +t.resultPct.toFixed(2) : null, t.status === 'closed' ? (t.exitReason === 'stop' ? 2 : 1) : 0, t.status === 'open' ? round(t.entryClose) : null]);
  for (const sys of (coin.u <= DONCHIAN_TOP ? SYSTEMS : [])) {   // Donchian stays on the top 50 only
    if (candles.length < sys.entry + 2) continue; // not enough history for this system yet (e.g. a young coin on weekly)
    const walked = [];
    for (const side of ['long', 'short']) {
      for (const t of walk(candles, side, sys)) {
        walked.push(t);
        addHist(sys.key, t, side);
        if (t.status === 'closed' && t.exitTime < keepFrom) continue;
        const unreal = t.status === 'open' ? (side === 'long' ? last.close - t.entryClose : t.entryClose - last.close) / t.entryClose * 100 : null;
        trades.push({
          system: sys.key, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side, status: t.status,
          entryTime: t.entryTime, entryClose: round(t.entryClose), entryLevel: round(t.entryLevel),
          exitTime: t.exitTime || null, exitClose: round(t.exitClose), exitLevel: round(t.exitLevel),
          resultPct: t.status === 'closed' ? +t.resultPct.toFixed(2) : null,
          lastClose: round(last.close), lastTime: last.t,
          unrealizedPct: unreal == null ? null : +unreal.toFixed(2),
          stop: t.status === 'open' ? round(stopNow(candles, side, sys)) : null,
        });
      }
    }
    formingSignals(candles, data.forming, walked, tf.periodMs, sys).forEach((f) => forming.push({
      system: sys.key, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side: f.side, kind: f.kind,
      candleTime: f.candleTime, closesAt: f.closesAt, price: round(f.price), level: round(f.level),
      entryTime: f.entryTime || null, entryClose: round(f.entryClose), resultPct: f.resultPct == null ? null : +f.resultPct.toFixed(2),
      stop: f.kind === 'entry' ? round(stopNow(candles, f.side, sys)) : null,
    }));
  }
  // Ichimoku breakout (long + short), same candles
  if (candles.length >= ICHI_MIN_BARS) {
    const S = ichiSeries(candles);
    const walked = [];
    for (const side of ['long', 'short']) {
      for (const t of walkIchimoku(S, side)) {
        walked.push(t);
        addHist('Ichimoku', t, side);
        if (t.status === 'closed' && t.exitTime < keepFrom) continue;
        const unreal = t.status === 'open' ? (side === 'long' ? last.close - t.entryClose : t.entryClose - last.close) / t.entryClose * 100 : null;
        trades.push({
          system: 'Ichimoku', trigger: t.trigger, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side, status: t.status,
          entryTime: t.entryTime, entryClose: round(t.entryClose), entryLevel: round(t.entryLevel),
          exitTime: t.exitTime || null, exitClose: round(t.exitClose), exitLevel: round(t.exitLevel),
          resultPct: t.status === 'closed' ? +t.resultPct.toFixed(2) : null,
          lastClose: round(last.close), lastTime: last.t,
          unrealizedPct: unreal == null ? null : +unreal.toFixed(2),
          stop: t.status === 'open' ? round(S.kijun[S.c.length - 1]) : null,
          sl: round(t.sl), exitReason: t.exitReason || null,
        });
      }
    }
    formingIchimoku(candles, data.forming, walked, tf.periodMs).forEach((f) => forming.push({
      system: 'Ichimoku', trigger: f.trigger || null, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side: f.side, kind: f.kind,
      candleTime: f.candleTime, closesAt: f.closesAt, price: round(f.price), level: round(f.level),
      entryTime: f.entryTime || null, entryClose: round(f.entryClose), resultPct: f.resultPct == null ? null : +f.resultPct.toFixed(2),
      stop: f.kind === 'entry' ? round(S.kijun[S.c.length - 1]) : null,
      sl: f.sl == null ? null : round(f.sl), exitReason: f.exitReason || null,
    }));
  }
  // Bullish CHoCH and Bullish BOS (long only; 4H and Daily)
  for (const st of STRUCT_STRATS) {
    const opt = st.tfs[tf.label];
    if (!opt || candles.length < CHOCH_MIN_BARS) continue;
    const run = structRun(candles, st.kind, opt);
    const keepFromS = Date.now() - (STRUCT_KEEP_CLOSED_MS[tf.label] || tf.keepClosedMs);
    const walkedC = run.trades.concat(run.open ? [run.open] : []);
    walkedC.forEach((t) => {
      addHist(st.key, t, 'long');
      if (t.status === 'closed' && t.exitTime < keepFromS) return;
      trades.push({
        system: st.key, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side: 'long', status: t.status,
        entryTime: t.entryTime, entryClose: round(t.entryClose), entryLevel: round(t.entryLevel),
        exitTime: t.exitTime || null, exitClose: round(t.exitClose), exitLevel: round(t.exitLevel),
        resultPct: t.status === 'closed' ? +t.resultPct.toFixed(2) : null,
        lastClose: round(last.close), lastTime: last.t,
        unrealizedPct: t.status === 'open' ? +((last.close - t.entryClose) / t.entryClose * 100).toFixed(2) : null,
        stop: t.status === 'open' ? round(t.stop) : null, sl: round(t.sl), exitReason: t.exitReason || null,
      });
    });
    structForming(run, data.forming, tf.periodMs, opt).forEach((f) => forming.push({
      system: st.key, symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, side: 'long', kind: f.kind,
      candleTime: f.candleTime, closesAt: f.closesAt, price: round(f.price), level: round(f.level),
      entryTime: f.entryTime || null, entryClose: round(f.entryClose), resultPct: f.resultPct == null ? null : +f.resultPct.toFixed(2),
      stop: null, sl: f.sl == null ? null : round(f.sl), exitReason: f.exitReason || null,
    }));
  }
  const rz = retraceLeg(candles);
  const retrace = rz ? {
    symbol: coin.symbol, name: coin.name, pair: coin.pair, mult: coin.mult, dir: rz.dir,
    high: round(rz.high), low: round(rz.low), highTime: rz.highTime, lowTime: rz.lowTime,
    l50: round(rz.l50), l618: round(rz.l618), atr: round(rz.atr), lastClose: round(rz.lastClose),
  } : null;
  return { trades, forming, retrace, hist, lastT: last.t };
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
    const off = tf.offsetMs || 0;
    const expected = Math.floor((now - off) / tf.periodMs) * tf.periodMs + off - tf.periodMs;
    tf.expected = expected;
    const asOf = prev && prev.timeframes && prev.timeframes[tf.label] && prev.timeframes[tf.label].asOf;
    return !SKIP_IF_CURRENT || !asOf || asOf < expected;
  });
  if (!due.length) { console.log('no new 1H/4H/1D/1W candle since the last scan, nothing to do (SKIP_IF_CURRENT)'); return; }
  console.log('scanning: ' + due.map((t) => t.label).join(', '));

  const instruments = new Set(await fetchJSON(ACTIVE_INSTRUMENTS_URL));
  const universe = await loadUniverse(instruments);
  if (!universe.coins.length) throw new Error('no scannable coins');

  const next = {
    updated: new Date().toISOString(),
    rules: { systems: SYSTEMS, structure: STRUCT_STRATS, span: CHOCH_SPAN, structKeepClosedMs: STRUCT_KEEP_CLOSED_MS },
    universe: { source: 'CoinGecko market-cap ranking excluding stablecoins, first 100 listed on CoinDCX as USDT perps (Donchian: the first 50); candles from CoinDCX', updated: universe.updated, scanned: universe.coins.length, donchianTop: DONCHIAN_TOP, ranks: Object.fromEntries(universe.coins.map((c) => [c.symbol, c.u])), skipped: universe.skipped },
    timeframes: { ...((prev && prev.timeframes) || {}) },
  };

  const prevHist = readJSON(HIST_OUT);
  const hist = { updated: null, tfs: { ...((prevHist && prevHist.tfs) || {}) } };
  for (const tf of due) {
    const histTrades = [];
    const trades = [];
    const forming = [];
    const retrace = [];
    const failed = [];
    let atExpected = 0;
    await pool(universe.coins, async (coin) => {
      try {
        const res = scanCoin(coin, await getCandles(coin.pair, tf), tf);
        trades.push(...res.trades);
        forming.push(...res.forming);
        if (res.retrace) retrace.push(res.retrace);
        histTrades.push(...res.hist);
        if (res.lastT === tf.expected) atExpected++;
      } catch (e) { failed.push(coin.symbol); console.warn(`${tf.label} ${coin.symbol}: ${e.message}`); }
    });
    if (failed.length >= universe.coins.length) throw new Error(`${tf.label}: every coin failed`);
    trades.sort((a, b) => (b.exitTime || b.entryTime) - (a.exitTime || a.entryTime));
    forming.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.system.localeCompare(b.system));
    retrace.sort((a, b) => a.symbol.localeCompare(b.symbol));

    // detectedAt = when THIS job first saw the signal (carried over from the previous file while the signal
    // stays the same). The app uses it for "New" and the badges. A signal that is already old the first time
    // we see it (for example a coin that just joined the scanned list with a trade open since last week) is not
    // new: it is stamped with its candle's close time instead of "now".
    const prevTf = (prev && prev.timeframes && prev.timeframes[tf.label]) || {};
    const prevAt = new Map();
    (prevTf.trades || []).forEach((t) => { if (t.detectedAt) prevAt.set(`t|${t.system || '20/10'}|${t.symbol}|${t.side}|${t.entryTime}|${t.status}`, t.detectedAt); });
    (prevTf.forming || []).forEach((f) => { if (f.detectedAt) prevAt.set(`f|${f.system || '20/10'}|${f.symbol}|${f.side}|${f.kind}|${f.candleTime}`, f.detectedAt); });
    const nowMs = Date.now();
    trades.forEach((t) => {
      const known = prevAt.get(`t|${t.system}|${t.symbol}|${t.side}|${t.entryTime}|${t.status}`);
      const eventClose = (t.exitTime || t.entryTime) + tf.periodMs;
      t.detectedAt = known || (nowMs - eventClose <= DETECT_GRACE_MS ? nowMs : eventClose);
    });
    forming.forEach((f) => { f.detectedAt = prevAt.get(`f|${f.system}|${f.symbol}|${f.side}|${f.kind}|${f.candleTime}`) || nowMs; });
    histTrades.sort((a, b) => a[3] - b[3] || a[1].localeCompare(b[1]) || String(a[0]).localeCompare(String(b[0])) || a[2] - b[2]);
    hist.tfs[tf.label] = { periodMs: tf.periodMs, historyDays: tf.historyDays, trades: histTrades };
    // Only mark this candle as scanned once most coins actually have it, otherwise try again on the next run.
    const complete = atExpected >= Math.ceil(universe.coins.length * 0.8);
    const prevAsOf = prev && prev.timeframes && prev.timeframes[tf.label] ? prev.timeframes[tf.label].asOf : null;
    next.timeframes[tf.label] = { asOf: complete ? tf.expected : prevAsOf, candleTime: tf.expected, scanned: universe.coins.length - failed.length, failed, trades, forming, retrace, formingAt: new Date().toISOString() };
    console.log(`${tf.label}: ${trades.length} trades (${trades.filter((t) => t.status === 'open').length} open), ${forming.length} forming, ${failed.length} failed, candle ${new Date(tf.expected).toISOString()} on ${atExpected}/${universe.coins.length} coins`);
  }

  // Forming signals carry a live price that drifts every run; compare only WHICH signals exist so the file
  // (and git history) change when a signal appears or disappears, not on every price tick.
  const strip = (o) => JSON.stringify({
    ...o, updated: null, universe: o.universe && { ...o.universe, updated: null },
    timeframes: Object.fromEntries(Object.entries(o.timeframes || {}).map(([k, v]) => [k, {
      ...v, formingAt: null, forming: (v.forming || []).map((f) => [f.system, f.symbol, f.side, f.kind, f.candleTime]),
    }])),
  });
  // The history file is compared on its trades only (its timestamp is ignored), like the signals file above.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const histKey = (h) => JSON.stringify(h && h.tfs);
  if (!prevHist || histKey(prevHist) !== histKey(hist)) {
    hist.updated = new Date().toISOString();
    fs.writeFileSync(HIST_OUT, JSON.stringify(hist));
    console.log('wrote ' + HIST_OUT);
  }
  if (prev && strip(prev) === strip(next)) { console.log('no change in signals, file not rewritten'); return; }
  fs.writeFileSync(OUT, JSON.stringify(next));
  console.log('wrote ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
