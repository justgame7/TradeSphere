// screen.js
//
// Standalone Ichimoku breakout screener, for running headless (no browser/DOM)
// on a schedule via GitHub Actions. Ports the same Ichimoku math used in
// screener.html.
//
// DATA SOURCE: Bybit V5 API (category=linear, USDT perpetuals), not Binance.
// Binance's futures API (fapi.binance.com) returns HTTP 451 for GitHub
// Actions runner IPs ("Service unavailable from a restricted location"), and
// still blocks proxied requests via the Cloudflare Worker with a 403 - so
// this was switched to Bybit, which as of this writing serves these runner
// + Worker IPs without issue. All requests still go through the same
// Cloudflare Worker (?url=<encoded target>) as the rest of the TradeSphere
// suite; api.bybit.com and api.bytick.com must be present in the Worker's
// ALLOWED_HOSTS.
//
// Bybit V5 API quirks handled here (different from Binance's fapi):
//   - GET /v5/market/kline returns candles NEWEST-FIRST ("sort in reverse by
//     startTime" per Bybit's docs) - reversed here to oldest-first, since
//     computeIchimokuSignal assumes dClose[last] = today, same as
//     screener.html's assumption for Binance data.
//   - GET /v5/market/instruments-info is paginated (500+ linear symbols,
//     500/page default) - a cursor loop is required or symbols go missing.
//   - Kline row shape: [startTime, open, high, low, close, volume, turnover].
//     "turnover" (index 6) is the USDT-notional value - the equivalent of
//     Binance's quoteVolume - NOT "volume" (index 5, which is base-asset
//     units, e.g. BTC not USDT).
//
// Same default params as screener.html: tenkan=9, kijun=26, senkouB=52,
// daily interval, minVolume=10,000,000 USDT notional turnover.
//
// NOTE: Bybit's overall market volume tends to run lower than Binance's for
// many altcoins. The $10M daily-turnover floor below was calibrated against
// Binance and may filter out more Bybit symbols than expected - worth
// revisiting after a few runs if the LONG/SHORT lists look thin.
//
// Run locally to test:
//   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node screen.js
//
// See README.md for the one-time Telegram bot setup and how the GitHub
// Actions workflow (.github/workflows/screener.yml) schedules this hourly.

const BYBIT_HOSTS = [
  'https://api.bybit.com',
  'https://api.bytick.com', // Bybit's official alternate mainnet domain
];

const PARAMS = {
  tenkanLen: 9,
  kijunLen: 26,
  senkouBLen: 52,
  interval: 'D', // Bybit interval code for daily (Binance used '1d')
  minVolume: 10_000_000,
};

const CONCURRENCY = 8;

// Same Cloudflare Worker proxy the rest of the TradeSphere suite uses.
// api.bybit.com / api.bytick.com must be in the Worker's ALLOWED_HOSTS.
const WORKER_BASE = 'https://newsyt.justfagame9.workers.dev';

function proxiedUrl(targetUrl) {
  return `${WORKER_BASE}/?url=${encodeURIComponent(targetUrl)}`;
}

// ---------------- fetch helpers (mirrors screener.html's activeHost fallback) ----------------
let activeHost = BYBIT_HOSTS[0];

async function fetchWithTimeout(url, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(path) {
  const order = [activeHost, ...BYBIT_HOSTS.filter((h) => h !== activeHost)];
  let lastErr;
  for (const host of order) {
    const target = host + path;
    try {
      const res = await fetchWithTimeout(proxiedUrl(target));
      const raw = await res.text();
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
        throw new Error(
          `Non-JSON body (status ${res.status}) via worker for ${target} :: ${raw.slice(0, 300)}`
        );
      }
      if (data.retCode !== 0) {
        throw new Error(`Bybit retCode ${data.retCode} for ${target} :: ${data.retMsg || ''}`);
      }
      activeHost = host;
      return data.result;
    } catch (e) {
      lastErr = e;
      console.error(`fetchJSON failed for ${target}: ${e.message}`);
    }
  }
  throw lastErr;
}

// ---------------- symbol universe (paginated) ----------------
async function getUSDTPerpetualSymbols() {
  const symbols = [];
  let cursor = '';
  do {
    const qs = new URLSearchParams({ category: 'linear', limit: '1000' });
    if (cursor) qs.set('cursor', cursor);
    const result = await fetchJSON(`/v5/market/instruments-info?${qs.toString()}`);
    for (const s of result.list) {
      if (s.contractType === 'LinearPerpetual' && s.quoteCoin === 'USDT' && s.status === 'Trading') {
        symbols.push(s.symbol);
      }
    }
    cursor = result.nextPageCursor || '';
  } while (cursor);
  return symbols;
}

// ---------------- klines ----------------
async function getKlines(symbol, interval, limit) {
  const qs = new URLSearchParams({
    category: 'linear',
    symbol,
    interval,
    limit: String(limit),
  });
  const result = await fetchJSON(`/v5/market/kline?${qs.toString()}`);
  // Bybit returns newest-first; reverse to oldest-first so dClose[last] = today,
  // matching what computeIchimokuSignal expects.
  const rows = [...result.list].reverse();
  return rows.map((k) => ({
    openTime: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),      // base-asset volume (not used for the volume filter)
    quoteVolume: parseFloat(k[6]), // turnover - USDT-notional volume, same role as Binance's quoteVolume
  }));
}

// ---------------- current prices ----------------
async function getCurrentPrices() {
  const result = await fetchJSON('/v5/market/tickers?category=linear');
  const out = {};
  for (const t of result.list) {
    out[t.symbol] = parseFloat(t.lastPrice);
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
  console.log(`Fetching USDT perpetual symbol list (Bybit)...`);
  const symbols = await getUSDTPerpetualSymbols();
  const currentPrices = await getCurrentPrices();
  console.log(`Scanning ${symbols.length} symbols (interval=${PARAMS.interval})...`);

  const raw = await runPool(symbols, (s) => screenSymbol(s, PARAMS, currentPrices), CONCURRENCY);
  const scanned = raw.filter((r) => r && !r.error);
  const results = scanned.filter((r) => r.volToday > PARAMS.minVolume && r.setup !== '');

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

  const stripUsdt = (s) => s.replace(/USDT$/, '');
  const fmtRow = (r) =>
    `<b>${stripUsdt(r.symbol)}</b> ${r.setup} (${r.breakout})${r.confirmed ? ' ✅' : ''}\n` +
    `Entry <code>${fmt(r.entry)}</code> · SL <code>${fmt(r.stop)}</code> · TP <code>${fmt(r.target)}</code>`;
  const fmtSection = (rows) => rows.length ? rows.map(fmtRow).join('\n\n') : 'none';

  const now = new Date();
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const message =
    `<b>Ichimoku breakout screener (Bybit) — ${stamp}</b>\n` +
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
