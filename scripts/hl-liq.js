// Builds data/hl-liq.json: a snapshot of Hyperliquid perp positions and their
// exact liquidation prices, taken from the top accounts by account value.
//
// Hyperliquid is fully on-chain/public: every account's clearinghouseState
// (positions, margin, liquidationPx) can be queried, so unlike CEX heatmaps
// this is real data, not a leverage-distribution model. The caveat is
// coverage: there is no "all positions" endpoint, so we sample the top
// TOP_N accounts from the public leaderboard (which hold most of the notional).
//
// Node 20+ (built-in fetch). Run: node scripts/hl-liq.js [topN]
const fs = require('fs');
const path = require('path');

const INFO = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const TOP_N = parseInt(process.argv[2] || process.env.HL_TOP_N || '3000', 10);
const MIN_NOTIONAL_USD = 500;      // drop dust positions to keep the file small
const REQ_INTERVAL_MS = 120;       // ~8/s * weight 2 = ~1000 of the 1200/min budget
const OUT = path.join(__dirname, '..', 'data', 'hl-liq.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function info(body, tries = 5){
  for(let i = 0; i < tries; i++){
    try{
      const res = await fetch(INFO, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if(res.status === 429){ await sleep(8000 * (i + 1)); continue; }
      if(!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    }catch(err){
      if(i === tries - 1) throw err;
      await sleep(1500 * (i + 1));
    }
  }
}

async function main(){
  console.log('fetching leaderboard...');
  const lbRes = await fetch(LEADERBOARD);
  if(!lbRes.ok) throw new Error('leaderboard HTTP ' + lbRes.status);
  const lb = await lbRes.json();
  // Half by account value (whales), half by 7d trading volume (active,
  // usually higher-leverage accounts whose liquidations sit nearer to price).
  // Account value alone picks many idle/spot-only accounts with no perps.
  const weekVlm = r => {
    const w = (r.windowPerformances || []).find(x => x[0] === 'week');
    return w ? parseFloat(w[1].vlm) || 0 : 0;
  };
  const all = (lb.leaderboardRows || lb)
    .map(r => ({ addr: r.ethAddress, av: parseFloat(r.accountValue) || 0, vlm: weekVlm(r) }))
    .filter(r => r.addr && r.av > 0);
  const half = Math.ceil(TOP_N / 2);
  const byValue = [...all].sort((a, b) => b.av - a.av).slice(0, half);
  const byVolume = all.filter(r => r.av > 1000).sort((a, b) => b.vlm - a.vlm).slice(0, half);
  const seen = new Set();
  const rows = [...byValue, ...byVolume].filter(r => !seen.has(r.addr) && seen.add(r.addr));
  console.log('accounts to scan:', rows.length);

  const mids = await info({ type: 'allMids' });
  const coins = {};
  let scanned = 0, withPositions = 0, failed = 0;

  let cursor = 0;
  async function worker(offset){
    await sleep(offset);
    while(cursor < rows.length){
      const row = rows[cursor++];
      const started = Date.now();
      try{
        const st = await info({ type: 'clearinghouseState', user: row.addr });
        scanned++;
        const positions = (st.assetPositions || []).map(p => p.position).filter(Boolean);
        if(positions.length) withPositions++;
        for(const p of positions){
          const liq = parseFloat(p.liquidationPx);
          const usd = Math.abs(parseFloat(p.positionValue));
          const szi = parseFloat(p.szi);
          if(!isFinite(liq) || liq <= 0 || !(usd >= MIN_NOTIONAL_USD) || !szi) continue;
          const c = coins[p.coin] || (coins[p.coin] = { mark: parseFloat(mids[p.coin]) || null, long: [], short: [] });
          const cross = p.leverage && p.leverage.type === 'cross' ? 1 : 0;
          const lev = p.leverage ? p.leverage.value : null;
          // [liquidationPx, notionalUsd, leverage, isCross]
          (szi > 0 ? c.long : c.short).push([liq, Math.round(usd), lev, cross]);
        }
      }catch(err){
        failed++;
      }
      const wait = REQ_INTERVAL_MS * 4 - (Date.now() - started); // 4 workers share the budget
      if(wait > 0) await sleep(wait);
    }
  }
  await Promise.all([0, 1, 2, 3].map(i => worker(i * REQ_INTERVAL_MS)));

  const totals = {};
  for(const [coin, c] of Object.entries(coins)){
    const sum = a => a.reduce((s, x) => s + x[1], 0);
    totals[coin] = { long: sum(c.long), short: sum(c.short) };
  }
  const out = {
    updated: new Date().toISOString(),
    source: 'hyperliquid clearinghouseState (top accounts by account value)',
    accountsRequested: rows.length,
    accountsScanned: scanned,
    accountsWithPositions: withPositions,
    failed,
    coins,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`wrote ${OUT} (${kb} KB): scanned ${scanned}, with positions ${withPositions}, failed ${failed}`);
  ['BTC', 'ETH', 'SOL', 'HYPE', 'ZEC', 'XRP'].forEach(c => totals[c] && console.log(c, totals[c]));
  if(scanned < rows.length * 0.5) throw new Error('too many failures; not publishing a thin snapshot');
}

main().catch(err => { console.error(err); process.exit(1); });
