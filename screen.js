// screen.js
//
// Standalone Ichimoku breakout screener, for running headless (no browser/DOM)
// on a schedule via GitHub Actions. Ports the same Ichimoku math used in
// screener.html.
//
// DATA SOURCE: CoinDCX public API only.
//
// This scans exactly the USDT-margined perpetual futures instruments that
// are actually tradable on CoinDCX (Mi trades there) - roughly 500 pairs as
// of the last full listing run - instead of scanning Binance/Bybit/OKX and
// then separately checking which of those are mirrored on CoinDCX.
//
// CANDLE ENDPOINT HISTORY - IMPORTANT, read before touching getKlines():
//   The first version of this file used CoinDCX's documented, generic
//   endpoint - https://public.coindcx.com/market_data/candles/?pair=... -
//   which is officially documented under "Market Data on CoinDCX API". In
//   production this returned empty candle arrays for ~35% of the futures
//   universe (176/500 symbols in one run), INCLUDING extremely liquid,
//   long-established coins like 1000PEPE, 1000BONK, 1000SHIB, 1000FLOKI,
//   GOAT, POPCAT, TRUMP, HYPE - coins that cannot plausibly lack 114 days
//   of history. Meanwhile BTC, ETH, LINK, NEAR worked fine on that
//   endpoint. Conclusion: that generic endpoint is CoinDCX's SPOT candle
//   series - it only returns data for pairs that also have a spot USDT
//   market under the same "B-COIN_USDT" code, which most futures-only
//   instruments don't.
//
//   The correct, futures-specific endpoint was found by inspecting the
//   actual network request CoinDCX's own futures-trading UI makes when
//   loading a daily chart (browser DevTools -> Network -> XHR, on a
//   B-1000PEPE_USDT perp page). It is NOT documented at
//   coindcx.com/api/help or docs.coindcx.com as far as could be found - the
//   unofficial coindcx-python wrapper references a get_futures_candles()
//   method distinctly from get_candles(), which lines up with this being a
//   separate, undocumented endpoint:
//
//     GET https://public.coindcx.com/market_data/candlesticks
//         ?pair=B-1000PEPE_USDT&resolution=1d&from=<unix_seconds>&to=<unix_seconds>&pcode=f
//
//   Quirks confirmed from a captured real response:
//     - Path is "candlesticks" (plural) - NOT "candles" like the spot one.
//     - "resolution" (not "interval") selects the candle size; "1d" is a
//       valid daily code.
//     - "from"/"to" are UNIX SECONDS, but each returned candle's "time"
//       field is UNIX MILLISECONDS - easy to get backwards.
//     - There's no separate "limit" parameter - history is windowed via
//       from/to instead, so getKlines below requests a wide multi-month
//       window rather than a bar count.
//     - "pcode=f" is presumed to mean "product code = futures" (as opposed
//       to spot) - this is what actually routes the request to the futures
//       candle series instead of the spot one. Omitting it, or getting it
//       wrong, would silently route back to the same empty-for-futures-only
//       -pairs behavior this replaces.
//     - Response is wrapped: { "s": "ok", "data": [ {open,high,low,close,
//       volume,time}, ... ] } - NOT a bare array like the spot endpoint.
//     - Candle "volume" still appears to be target-currency units (e.g.
//       PEPE, not USDT) based on order-of-magnitude sanity-checking a real
//       1000PEPE response - close * volume lines up with a plausible daily
//       USDT notional for that coin, not an implausibly huge one.
//
// Two CoinDCX endpoints are used, both public / unauthenticated, both hit
// DIRECTLY (no Cloudflare Worker proxy) - this is a plain server-side Node
// fetch with no CORS concern, so there's no need to route it through the
// TradeSphere Worker or add CoinDCX hosts to its ALLOWED_HOSTS:
//   - GET https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments
//     Returns the full list of active futures instrument pair strings, e.g.
//     "B-BTC_USDT". Filtered here to pairs ending in "_USDT".
//   - GET https://public.coindcx.com/market_data/candlesticks (see above)
//
// Symbol format is "B-COIN_USDT" (Binance-liquidity-backed USDT-M perp),
// not "COINUSDT" - display formatting (stripUsdt) strips both the "B-"
// prefix and the "_USDT" suffix.
//
// CoinDCX's public rate limits for market-data endpoints aren't documented
// (the published rate-limit table only covers authenticated order
// endpoints), so the pacing throttle below starts conservative and should
// be loosened or tightened after watching a few real runs for 429s - see
// MIN_REQUEST_GAP_MS and CONCURRENCY.
//
// Same default params as screener.html: tenkan=9, kijun=26, senkouB=52,
// daily interval, minVolume=10,000,000 USDT notional volume.
//
// Run locally to test:
//   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node screen.js
//
// See README.md for the one-time Telegram bot setup and how the GitHub
// Actions workflow (.github/workflows/screener.yml) schedules this hourly.

const COINDCX_API_BASE = 'https://api.coindcx.com';
const COINDCX_PUBLIC_BASE = 'https://public.coindcx.com';
const ACTIVE_INSTRUMENTS_URL = `${COINDCX_API_BASE}/exchange/v1/derivatives/futures/data/active_instruments`;
const FUTURES_CANDLES_URL = `${COINDCX_PUBLIC_BASE}/market_data/candlesticks`;

// How far back to window the candlesticks request. There's no bar-count
// "limit" param on this endpoint (unlike the spot one) - history is
// windowed via from/to instead - so this requests a generous multi-month
// range and lets computeIchimokuSignal's own "insufficient history" check
// catch genuinely-too-new listings.
const HISTORY_DAYS = 200; // comfortably more than the 114 bars actually needed

const PARAMS = {
  tenkanLen: 9,
  kijunLen: 26,
  senkouBLen: 52,
  resolution: '1d', // CoinDCX futures candlesticks resolution code for daily candles
  minVolume: 10_000_000,
};

const CONCURRENCY = 3; // conservative starting point - CoinDCX doesn't publish a public market-data rate limit, tune after watching real runs

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Global pacing throttle: enforces a minimum gap between the start of any
// two requests across ALL lanes, so requests get spread out in time
// regardless of how many lanes are running concurrently. Carried over from
// the earlier OKX version, where bursts (not sustained rate) were what
// tripped rate limits - starting with the same defensive posture here since
// CoinDCX's actual public limits are unknown.
const MIN_REQUEST_GAP_MS = 300;
let nextSlot = 0;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_GAP_MS;
  if (wait > 0) await sleep(wait);
}

// ---------------- fetch helpers ----------------
async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Retries HTTP 429 with exponential backoff + jitter before giving up.
const MAX_429_RETRIES = 8;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 12000; // cap so a single symbol's worst case stays bounded even with 8 retries

async function fetchJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await fetchWithTimeout(url);
      const raw = await res.text();
      if (res.status === 429) {
        const err = new Error(`HTTP 429 for ${url} :: ${raw.slice(0, 200)}`);
        err.isRateLimit = true;
        throw err;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url} :: ${raw.slice(0, 300)}`);
      }
      if (!raw) {
        throw new Error(`Empty body (status ${res.status}) for ${url}`);
      }
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON body (status ${res.status}) for ${url} :: ${raw.slice(0, 300)}`);
      }
    } catch (e) {
      lastErr = e;
      if (e.isRateLimit && attempt < MAX_429_RETRIES) {
        const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) + Math.random() * 300;
        await sleep(delay);
        continue;
      }
      console.error(`fetchJSON failed for ${url}: ${e.message}`);
      break;
    }
  }
  throw lastErr;
}

// ---------------- symbol universe ----------------
// Returns every active "B-COIN_USDT" perpetual pair CoinDCX currently lists.
async function getUSDTPerpetualSymbols() {
  const data = await fetchJSON(ACTIVE_INSTRUMENTS_URL);
  return data.filter((pair) => pair.endsWith('_USDT'));
}

// ---------------- klines ----------------
async function getKlines(pair, resolution, historyDays) {
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - historyDays * 86400;
  const qs = new URLSearchParams({
    pair,
    resolution,
    from: String(fromSec),
    to: String(toSec),
    pcode: 'f', // "product code = futures" - selects the futures candle series, not spot
  });
  const body = await fetchJSON(`${FUTURES_CANDLES_URL}?${qs.toString()}`);
  // Response is wrapped as { s: "ok", data: [...] } - but fall back to a
  // bare array just in case CoinDCX's shape ever varies by pair.
  const rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
  if (!rows) {
    const status = body && body.s ? body.s : 'unknown';
    throw new Error(`unexpected candlesticks response shape (status: ${status})`);
  }
  // Sort ascending by time explicitly rather than assuming the API's
  // return order - computeIchimokuSignal assumes dClose[last] = today.
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  return sorted.map((k) => {
    const close = parseFloat(k.close);
    const volume = parseFloat(k.volume); // target-currency units (e.g. PEPE), not USDT - see header note
    return {
      openTime: Number(k.time), // milliseconds, per the captured response
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close,
      volume,
      // USDT-notional volume, computed from target-currency volume * close -
      // see header note on why this isn't taken directly from the API.
      quoteVolume: close * volume,
    };
  });
}

// ---------------- Ichimoku core (verbatim port of screener.html - unchanged) ----------------
function donchianMid(highs, lows, len, endIdx) {
  if (endIdx - len + 1 < 0) return NaN;
  let hh = -Infinity, ll = Infinity;
  for (let i = endIdx - len + 1; i <= endIdx; i++) {
    if (highs[i] > hh) hh = highs[i];
    if (lows[i] < ll) ll = lows[i];
  }
  return (hh + ll) / 2;
}

function computeIchimokuSignal(symbol, daily, currentPrice, params) {
  const needed = 2 * params.kijunLen + params.senkouBLen + 10;
  if (!Number.isFinite(currentPrice)) throw new Error('current price unavailable');
  if (daily.length < needed) throw new Error(`insufficient daily history (${daily.length}/${needed} bars)`);

  const dHigh = daily.map((d) => d.high), dLow = daily.map((d) => d.low), dClose = daily.map((d) => d.close);

  const senkouA_raw = (i) => {
    const t = donchianMid(dHigh, dLow, params.tenkanLen, i);
    const k = donchianMid(dHigh, dLow, params.kijunLen, i);
    return (isNaN(t) || isNaN(k)) ? NaN : (t + k) / 2;
  };
  const senkouB_raw = (i) => donchianMid(dHigh, dLow, params.senkouBLen, i);

  const cloudAtBar = (t) => {
    const idx = t - params.kijunLen;
    if (idx < 0) return { top: NaN, bottom: NaN };
    const a = senkouA_raw(idx), b = senkouB_raw(idx);
    return { top: Math.max(a, b), bottom: Math.min(a, b) };
  };
  const cloudAtChikouBar = (t) => {
    const idx = t - 2 * params.kijunLen;
    if (idx < 0) return { top: NaN, bottom: NaN };
    const a = senkouA_raw(idx), b = senkouB_raw(idx);
    return { top: Math.max(a, b), bottom: Math.min(a, b) };
  };

  const iToday = dClose.length - 1;
  const iYest = iToday - 1;

  function signalAt(index) {
    const previous = index - 1;
    const price = dClose[index];
    const pricePrevious = dClose[previous];
    const cloud = cloudAtBar(index);
    const cloudPrevious = cloudAtBar(previous);
    const chikouCloud = cloudAtChikouBar(index);
    const chikouCloudPrevious = cloudAtChikouBar(previous);
    const tenkan = donchianMid(dHigh, dLow, params.tenkanLen, index);
    const kijun = donchianMid(dHigh, dLow, params.kijunLen, index);
    const futureA = senkouA_raw(index);
    const futureB = senkouB_raw(index);
    const volume = daily[index].quoteVolume;
    const valid = [cloud.top, cloud.bottom, cloudPrevious.top, cloudPrevious.bottom,
      chikouCloud.top, chikouCloud.bottom, chikouCloudPrevious.top,
      chikouCloudPrevious.bottom, tenkan, kijun, futureA, futureB].every((v) => !isNaN(v));
    if (!valid) return null;

    const volumeOk = volume > params.minVolume;
    const longTrend = tenkan > kijun && futureA > futureB;
    const shortTrend = tenkan < kijun && futureB > futureA;
    const ckLong = pricePrevious < chikouCloudPrevious.top &&
      price > chikouCloud.top && price > cloud.top && longTrend && volumeOk;
    const pkLong = pricePrevious < cloudPrevious.top &&
      price > cloud.top && price > chikouCloud.top && longTrend && volumeOk;
    const ckShort = pricePrevious > chikouCloudPrevious.bottom &&
      price < chikouCloud.bottom && price < cloud.bottom && shortTrend && volumeOk;
    const pkShort = pricePrevious > cloudPrevious.bottom &&
      price < cloud.bottom && price < chikouCloud.bottom && shortTrend && volumeOk;

    return {
      price, volume, cloud, chikouCloud, tenkan, kijun,
      ckLong, pkLong, ckShort, pkShort,
      long: ckLong || pkLong,
      short: ckShort || pkShort,
    };
  }

  const today = signalAt(iToday);
  const yesterday = signalAt(iYest);
  if (!today || !yesterday) {
    throw new Error('insufficient history for ichimoku calc');
  }

  const confirmedLong = yesterday.long && today.price > today.cloud.top && today.price > today.chikouCloud.top;
  const confirmedShort = yesterday.short && today.price < today.cloud.bottom && today.price < today.chikouCloud.bottom;
  const confirmed = confirmedLong || confirmedShort;
  const active = confirmed ? yesterday : today;
  const isLong = confirmedLong || (!confirmed && today.long);
  const isShort = confirmedShort || (!confirmed && today.short);
  const ckLong = confirmed ? yesterday.ckLong : today.ckLong;
  const pkLong = confirmed ? yesterday.pkLong : today.pkLong;
  const ckShort = confirmed ? yesterday.ckShort : today.ckShort;
  const pkShort = confirmed ? yesterday.pkShort : today.pkShort;
  let breakout = '';
  let setup = '';
  if (isLong) {
    setup = 'Long';
    breakout = (ckLong && pkLong) ? 'CK, PK' : (ckLong ? 'CK' : 'PK');
  } else if (isShort) {
    setup = 'Short';
    breakout = (ckShort && pkShort) ? 'CK, PK' : (ckShort ? 'CK' : 'PK');
  }
  const breakoutPrice = breakout === 'CK' ? active.chikouCloud[setup === 'Long' ? 'top' : 'bottom'] : active.cloud[setup === 'Long' ? 'top' : 'bottom'];
  const priceToday = currentPrice;
  const entryPrice = currentPrice;

  return {
    symbol,
    confirmed,
    priceToday,
    entryPrice,
    breakoutPrice,
    cloudTop: today.cloud.top,
    cloudBottom: today.cloud.bottom,
    volToday: today.volume,
    breakout,
    setup,
  };
}

async function screenSymbol(symbol, params) {
  const daily = await getKlines(symbol, params.resolution, HISTORY_DAYS);
  if (daily.length === 0) throw new Error(`no candle data returned (requested ${HISTORY_DAYS}d window)`);
  // Current/entry price = close of the last (still-forming) daily candle -
  // see the CoinDCX quirks note at the top of this file.
  const currentPrice = daily[daily.length - 1].close;
  return computeIchimokuSignal(symbol, daily, currentPrice, params);
}

// ---------------- concurrency-limited queue (mirrors screener.html's runPool) ----------------
async function runPool(items, worker, concurrency) {
  let idx = 0;
  const results = new Array(items.length);
  async function next() {
    while (idx < items.length) {
      const my = idx++;
      try {
        results[my] = await worker(items[my]);
      } catch (e) {
        results[my] = { error: e.message, symbol: items[my] };
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(workers);
  return results;
}

// ---------------- trade-level math (mirrors screener.html's analysis modal) ----------------
function fmt(n, d = 4) {
  return (n === undefined || n === null || isNaN(n)) ? '—' : n.toFixed(d);
}

function targetFor(entry, stop, isLong, multiple) {
  if (stop === null || !Number.isFinite(stop)) return NaN;
  const risk = Math.abs(entry - stop);
  return isLong ? entry + multiple * risk : entry - multiple * risk;
}

// Strips CoinDCX's "B-" prefix and "_USDT" suffix, e.g. "B-PEPE_USDT" -> "PEPE".
function stripUsdt(s) {
  return s.replace(/^B-/, '').replace(/_USDT$/, '');
}

// ---------------- Telegram ----------------
// Telegram caps a single message at 4096 characters. With entry/SL/TP per
// coin now taking 2 lines each, a busy scan can exceed that - so split into
// multiple messages instead of erroring out, breaking only at blank lines
// (never mid-coin).
function splitMessage(text, maxLen = 3500) {
  if (text.length <= maxLen) return [text];
  const parts = text.split('\n\n');
  const chunks = [];
  let current = '';
  for (const part of parts) {
    const candidate = current ? current + '\n\n' + part : part;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const chunks = splitMessage(text);

  if (!token || !chatId) {
    console.log(`TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set - skipping Telegram send (${chunks.length} message(s) would be sent).\n---\n` + text);
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Telegram send failed (part ${i + 1}/${chunks.length}): HTTP ${res.status} ${body}`);
    }
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------------- main ----------------
async function main() {
  console.log(`Fetching USDT perpetual symbol list (CoinDCX)...`);
  const symbols = await getUSDTPerpetualSymbols();
  console.log(`Scanning ${symbols.length} symbols (resolution=${PARAMS.resolution})...`);

  const raw = await runPool(symbols, (s) => screenSymbol(s, PARAMS), CONCURRENCY);
  const scanned = raw.filter((r) => r && !r.error);
  const errored = raw.filter((r) => r && r.error);
  const hasSetup = scanned.filter((r) => r.setup !== '');
  const results = scanned.filter((r) => r.volToday > PARAMS.minVolume && r.setup !== '');

  // Diagnostics only (not sent to Telegram) - lets a future silent-zero run be
  // root-caused from the Action log instead of guessed at blind. Errors are
  // bucketed by cause (rather than a flat sample of messages) with the
  // actual failing symbols listed, since "no candle data" vs "insufficient
  // history" point at different root causes - the former suggests the pair
  // has no candle series at all, the latter suggests a recently-listed
  // instrument that just hasn't accumulated 114 days yet.
  console.log(
    `Diagnostics: ${symbols.length} symbols -> ${scanned.length} scanned ok, ${errored.length} errored, ` +
    `${hasSetup.length} had a trend setup, ${results.length} passed the $${PARAMS.minVolume.toLocaleString()} volume gate.`
  );
  if (errored.length) {
    const buckets = new Map(); // error-type label -> [{symbol, error}]
    for (const r of errored) {
      const label = r.error.startsWith('insufficient daily history') ? 'insufficient daily history'
        : r.error.startsWith('no candle data returned') ? 'no candle data returned'
        : r.error.startsWith('current price unavailable') ? 'current price unavailable'
        : r.error.startsWith('HTTP ') || r.error.includes('fetch') ? 'fetch/HTTP error'
        : 'other';
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(r);
    }
    console.log(`Errors by cause:`);
    for (const [label, rows] of buckets) {
      const symbolList = rows.map((r) => stripUsdt(r.symbol)).join(', ');
      console.log(`  ${label} (${rows.length}): ${symbolList}`);
    }
  }

  // Same entry/stop/target math as the analysis modal's trade plan in screener.html:
  //   entry = entryPrice (current price at scan time)
  //   stop  = today's cloud bottom (Long) / cloud top (Short)
  //   target = entry ± 2x the entry-to-stop risk
  const withTrade = results.map((r) => {
    const isLong = r.setup === 'Long';
    const entry = r.entryPrice;
    const stop = isLong ? r.cloudBottom : r.cloudTop;
    const target = targetFor(entry, stop, isLong, 2);
    return { ...r, entry, stop, target };
  });

  const longs = withTrade.filter((r) => r.setup === 'Long').sort((a, b) => b.confirmed - a.confirmed || b.volToday - a.volToday);
  const shorts = withTrade.filter((r) => r.setup === 'Short').sort((a, b) => b.confirmed - a.confirmed || b.volToday - a.volToday);

  // tradesphere:// custom-scheme deep link - tapping the coin name in
  // Telegram opens the TradeSphere app straight into screener.html's
  // analysis for that coin (screener.html?symbol=<coin> already handles
  // the rest). See index.html / screener.html for the matching appUrlOpen
  // listeners that handle this on the app side.
  const deepLink = (coin) => `tradesphere://screener?symbol=${encodeURIComponent(coin)}`;
  const fmtRow = (r) => {
    const coin = stripUsdt(r.symbol);
    return `<a href="${deepLink(coin)}"><b>${coin}</b></a> ${r.setup} (${r.breakout})${r.confirmed ? ' ✅' : ''}\n` +
      `Entry <code>${fmt(r.entry)}</code> · SL <code>${fmt(r.stop)}</code> · TP <code>${fmt(r.target)}</code>`;
  };
  const fmtSection = (rows) => rows.length ? rows.map(fmtRow).join('\n\n') : 'none';

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const message =
    `<b>Ichimoku breakout screener (CoinDCX) — ${stamp}</b>\n` +
    `Scanned ${symbols.length} symbols, ${withTrade.length} with an active setup (min daily vol $${PARAMS.minVolume.toLocaleString()}).\n\n` +
    `<b>LONG (${longs.length})</b>\n${fmtSection(longs)}\n\n` +
    `<b>SHORT (${shorts.length})</b>\n${fmtSection(shorts)}\n\n` +
    `✅ = confirmed · CK/PK = breakout type · SL/TP = 1:2 risk:reward off today's cloud`;

  console.log(message.replace(/<\/?[a-z]+>/g, ''));
  await sendTelegramMessage(message);
}

main().catch((err) => {
  console.error('Screener run failed:', err);
  process.exit(1);
});
