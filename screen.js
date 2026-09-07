// screen.js
//
// Standalone Ichimoku breakout screener, for running headless (no browser/DOM)
// on a schedule via GitHub Actions. Ports the same Ichimoku math used in
// screener.html.
//
// DATA SOURCE: OKX V5 API (instType=SWAP, USDT-margined linear perpetuals).
//
// History of this file's data source, for whoever debugs this next:
//   1. Binance futures (fapi.binance.com) - HTTP 451 for GitHub Actions
//      runner IPs ("Service unavailable from a restricted location"), even
//      proxied through the Worker.
//   2. Bybit (api.bybit.com / api.bytick.com) - HTTP 403 from BOTH mainnet
//      domains, identical body: "The Amazon CloudFront distribution is
//      configured to block access from your country." This is a geo-block
//      enforced by Bybit's CloudFront edge based on the request's origin
//      country - GitHub Actions' free-tier runners sit on Microsoft Azure US
//      datacenters, and Bybit blocks derivatives-API access from the US for
//      regulatory reasons. No amount of retrying or Worker allowlist changes
//      fixes this; it's an exchange-side block, not a bug here.
//   3. Switched to OKX, which does not geo-block US/Azure-origin IPs for
//      public market-data endpoints.
//
// All requests still go through the same Cloudflare Worker (?url=<encoded
// target>) as the rest of the TradeSphere suite; www.okx.com must be
// present in the Worker's ALLOWED_HOSTS.
//
// OKX V5 API quirks handled here (different from Binance's fapi / Bybit's v5):
//   - GET /api/v5/market/candles returns candles NEWEST-FIRST - reversed
//     here to oldest-first, since computeIchimokuSignal assumes
//     dClose[last] = today.
//   - GET /api/v5/market/candles only serves the most recent ~300 bars per
//     instId, which is enough here (needed history is ~114 bars) - no
//     pagination / history-candles endpoint required.
//   - GET /api/v5/public/instruments returns the full SWAP instrument list
//     in one call (no cursor pagination like Bybit's instruments-info).
//   - instId format is "BTC-USDT-SWAP", not "BTCUSDT" - symbol handling and
//     display formatting (stripUsdt) account for this.
//   - Candle row shape: [ts, open, high, low, close, vol, volCcy,
//     volCcyQuote, confirm]. "volCcyQuote" (index 7) is the USDT-notional
//     value - the equivalent of Binance's quoteVolume / Bybit's turnover -
//     NOT "vol" (index 5, contracts) or "volCcy" (index 6, base-asset units).
//   - Every response is wrapped as { code, msg, data }; code !== "0" means
//     an application-level error even on HTTP 200.
//   - Daily candle bar code is '1D' (uppercase = UTC-aligned candles);
//     lowercase '1d' would give Hong Kong time-aligned candles instead.
//
// Same default params as screener.html: tenkan=9, kijun=26, senkouB=52,
// daily interval, minVolume=10,000,000 USDT notional volume.
//
// NOTE: OKX's per-symbol volume profile differs from Binance's/Bybit's for
// many altcoins. The $10M daily-volume floor below was calibrated against
// Binance and may filter out more OKX symbols than expected - worth
// revisiting after a few runs if the LONG/SHORT lists look thin.
//
// Run locally to test:
//   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node screen.js
//
// See README.md for the one-time Telegram bot setup and how the GitHub
// Actions workflow (.github/workflows/screener.yml) schedules this hourly.

// aws.okx.com was tried as a second host but every request through the
// Worker returned HTTP 530 :: error code 1016 (Cloudflare's own "origin DNS
// error") - that hostname doesn't publicly resolve via Cloudflare's edge, so
// it's not usable as a fallback here. Rate-limit retries (see fetchJSON)
// handle resilience instead of a second host.
const OKX_HOSTS = ['https://www.okx.com'];

const PARAMS = {
  tenkanLen: 9,
  kijunLen: 26,
  senkouBLen: 52,
  interval: '1D', // OKX bar code for UTC-aligned daily candles
  minVolume: 10_000_000,
};

const CONCURRENCY = 2; // lowered again from 3 - concurrent bursts (not just sustained rate) were tripping OKX's 429, so pacing (below) matters more than lane count now

// Same Cloudflare Worker proxy the rest of the TradeSphere suite uses.
// www.okx.com must be in the Worker's ALLOWED_HOSTS.
const WORKER_BASE = 'https://newsyt.justfagame9.workers.dev';

function proxiedUrl(targetUrl) {
  return `${WORKER_BASE}/?url=${encodeURIComponent(targetUrl)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Global pacing throttle: even at low CONCURRENCY, multiple lanes can still
// dispatch requests within the same few milliseconds of each other, and it's
// that BURST - not the sustained rate - that was tripping OKX's 429 even
// after cutting concurrency 8 -> 3. This enforces a minimum gap between the
// start of any two requests across ALL lanes, so requests get spread out in
// time regardless of how many lanes are running concurrently.
const MIN_REQUEST_GAP_MS = 180;
let nextSlot = 0;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_REQUEST_GAP_MS;
  if (wait > 0) await sleep(wait);
}

// ---------------- fetch helpers (mirrors screener.html's activeHost fallback) ----------------
let activeHost = OKX_HOSTS[0];

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Retries HTTP 429 with exponential backoff + jitter before giving up on a
// host. This is separate from the host-fallback loop below: a 429 means
// "you're going too fast", not "this host is broken" - retrying the SAME
// host after a pause is the correct response, not immediately failing over.
const MAX_429_RETRIES = 5;
const BASE_BACKOFF_MS = 800;

async function fetchOnce(target) {
  await throttle();
  const res = await fetchWithTimeout(proxiedUrl(target));
  const raw = await res.text();
  if (res.status === 429) {
    const err = new Error(`HTTP 429 via worker for ${target} :: ${raw.slice(0, 200)}`);
    err.isRateLimit = true;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} via worker for ${target} :: ${raw.slice(0, 300)}`);
  }
  if (!raw) {
    throw new Error(`Empty body (status ${res.status}) via worker for ${target}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON body (status ${res.status}) via worker for ${target} :: ${raw.slice(0, 300)}`);
  }
  if (data.code !== '0') {
    throw new Error(`OKX code ${data.code} for ${target} :: ${data.msg || ''}`);
  }
  return data.data;
}

async function fetchJSON(path) {
  const order = [activeHost, ...OKX_HOSTS.filter((h) => h !== activeHost)];
  let lastErr;
  for (const host of order) {
    const target = host + path;
    for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
      try {
        const data = await fetchOnce(target);
        activeHost = host;
        return data;
      } catch (e) {
        lastErr = e;
        if (e.isRateLimit && attempt < MAX_429_RETRIES) {
          const delay = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 300;
          await sleep(delay);
          continue; // retry same host, don't fall through to the next one yet
        }
        console.error(`fetchJSON failed for ${target}: ${e.message}`);
        break; // non-429 error, or retries exhausted - try next host
      }
    }
  }
  throw lastErr;
}

// ---------------- symbol universe ----------------
async function getUSDTPerpetualSymbols() {
  // OKX returns the full SWAP instrument list in one call - no cursor
  // pagination needed (unlike Bybit's instruments-info).
  const result = await fetchJSON('/api/v5/public/instruments?instType=SWAP');
  const symbols = [];
  for (const s of result) {
    if (s.ctType === 'linear' && s.settleCcy === 'USDT' && s.state === 'live') {
      symbols.push(s.instId); // e.g. "BTC-USDT-SWAP"
    }
  }
  return symbols;
}

// ---------------- klines ----------------
async function getKlines(symbol, interval, limit) {
  const qs = new URLSearchParams({
    instId: symbol,
    bar: interval,
    limit: String(limit), // OKX /market/candles caps out around 300 recent bars, plenty here
  });
  const result = await fetchJSON(`/api/v5/market/candles?${qs.toString()}`);
  // OKX returns newest-first; reverse to oldest-first so dClose[last] = today,
  // matching what computeIchimokuSignal expects.
  const rows = [...result].reverse();
  return rows.map((k) => {
    const close = parseFloat(k[4]);
    const volCcy = parseFloat(k[6]); // base-currency volume - reliably populated for SWAP
    return {
      openTime: Number(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close,
      volume: parseFloat(k[5]), // contracts (not used for the volume filter)
      // Deliberately NOT using OKX's volCcyQuote (index 7): on SWAP candles it
      // comes back as 0 for a large share of instruments even when the pair
      // is actively trading, which silently zeroed out every symbol's
      // volumeOk gate and made every breakout condition unsatisfiable - the
      // root cause of "0 with an active setup" runs. close * volCcy is the
      // same USDT-notional quantity, computed from a field OKX fills in
      // consistently.
      quoteVolume: close * volCcy,
    };
  });
}

// ---------------- current prices ----------------
async function getCurrentPrices() {
  const result = await fetchJSON('/api/v5/market/tickers?instType=SWAP');
  const out = {};
  for (const t of result) {
    out[t.instId] = parseFloat(t.last);
  }
  return out;
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
  if (daily.length < needed) throw new Error('insufficient daily history');

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

async function screenSymbol(symbol, params, currentPrices) {
  const needed = 2 * params.kijunLen + params.senkouBLen + 10;
  const daily = await getKlines(symbol, params.interval, Math.max(needed, 150));
  const currentPrice = currentPrices[symbol];
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
  console.log(`Fetching USDT perpetual symbol list (OKX)...`);
  const symbols = await getUSDTPerpetualSymbols();
  const currentPrices = await getCurrentPrices();
  console.log(`Scanning ${symbols.length} symbols (interval=${PARAMS.interval})...`);

  const raw = await runPool(symbols, (s) => screenSymbol(s, PARAMS, currentPrices), CONCURRENCY);
  const scanned = raw.filter((r) => r && !r.error);
  const errored = raw.filter((r) => r && r.error);
  const hasSetup = scanned.filter((r) => r.setup !== '');
  const results = scanned.filter((r) => r.volToday > PARAMS.minVolume && r.setup !== '');

  // Diagnostics only (not sent to Telegram) - lets a future silent-zero run be
  // root-caused from the Action log instead of guessed at blind, the way
  // this one had to be.
  console.log(
    `Diagnostics: ${symbols.length} symbols -> ${scanned.length} scanned ok, ${errored.length} errored, ` +
    `${hasSetup.length} had a trend setup, ${results.length} passed the $${PARAMS.minVolume.toLocaleString()} volume gate.`
  );
  if (errored.length) {
    const sampleErrors = [...new Set(errored.slice(0, 5).map((r) => r.error))];
    console.log(`Sample errors: ${sampleErrors.join(' | ')}`);
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

  const stripUsdt = (s) => s.replace(/-USDT-SWAP$/, '');
  const fmtRow = (r) =>
    `<b>${stripUsdt(r.symbol)}</b> ${r.setup} (${r.breakout})${r.confirmed ? ' ✅' : ''}\n` +
    `Entry <code>${fmt(r.entry)}</code> · SL <code>${fmt(r.stop)}</code> · TP <code>${fmt(r.target)}</code>`;
  const fmtSection = (rows) => rows.length ? rows.map(fmtRow).join('\n\n') : 'none';

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const message =
    `<b>Ichimoku breakout screener (OKX) — ${stamp}</b>\n` +
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
