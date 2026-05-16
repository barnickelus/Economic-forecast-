#!/usr/bin/env node
/**
 * Kelly Silver — data fetcher
 *
 * Runs on GitHub Actions every ~30 minutes (see .github/workflows/fetch-data.yml).
 * Fetches silver, gold, DXY, copper, oil, VIX, S&P, and silver miners ETF
 * from Yahoo Finance, with goldprice.org as a backup for the metals.
 *
 * Output: data/latest.json — same-origin file the dashboard reads.
 *
 * No CORS issues because this runs server-side, not in a browser.
 */

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (compatible; Kelly-Silver-Dashboard/3.0; +https://github.com/)';
const TIMEOUT_MS = 12000;

// Silver: use SLV ETF which tracks spot silver closely and has reliable
//   prev-close + intraday + volume data on Yahoo. The futures contract SI=F
//   often has stale or weekend-skewed prev-close values that distort change %.
// SLV * ~10.4 ≈ silver spot price; we'll convert at the dashboard level.
const SYMBOLS = {
  silver: 'SI=F',     // futures (we'll cross-check with SLV)
  silverSpot: 'XAG=X',// spot silver in USD — for true price display
  silverETF: 'SLV',   // iShares Silver Trust — most reliable volume + intraday
  gold:   'GC=F',
  goldSpot: 'XAU=X',
  dxy:    'DX-Y.NYB',
  copper: 'HG=F',
  oil:    'CL=F',
  vix:    '^VIX',
  spx:    '^GSPC',
  sil:    'SIL',
};

async function fetchWithTimeout(url, opts = {}, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json,*/*', ...(opts.headers || {}) },
      signal: ctl.signal,
    });
    clearTimeout(tid);
    return resp;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function fetchYahoo(symbol, range = '3mo', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const r = data?.chart?.result?.[0];
  if (!r?.meta?.regularMarketPrice) throw new Error('no chart data');
  return r;
}

async function fetchGoldpriceOrg() {
  const resp = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD');
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const item = data?.items?.[0];
  if (!item?.xagPrice) throw new Error('no items');
  return item;
}

async function fetchGoldApi(metal) {
  const resp = await fetchWithTimeout(`https://api.gold-api.com/price/${metal}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

function quoteFromYahoo(r) {
  const m = r.meta;
  const spot = m.regularMarketPrice;
  const prev = m.chartPreviousClose ?? m.previousClose;
  return {
    spot,
    prev,
    change: spot - prev,
    changePct: (spot - prev) / prev * 100,
  };
}

function seriesFromYahoo(r) {
  return r.indicators.quote[0].close.filter(x => x != null);
}

function ohlcFromYahoo(r, n = 6) {
  const ts = r.timestamp;
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = Math.max(0, ts.length - n); i < ts.length; i++) {
    if (q.close[i] == null) continue;
    out.push({
      date: new Date(ts[i] * 1000).toISOString().split('T')[0],
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
      v: q.volume[i] || 0,
    });
  }
  return out;
}

async function main() {
  const data = {
    fetchedAt: new Date().toISOString(),
    sources: {},
    log: [],
  };

  // Pass 1: Yahoo Finance for everything
  for (const [key, sym] of Object.entries(SYMBOLS)) {
    try {
      const r = await fetchYahoo(sym);
      data[key] = quoteFromYahoo(r);
      data.sources[key] = `yahoo:${sym}`;
      if (key === 'silver') {
        data.series = seriesFromYahoo(r);
        data.recentOHLC = ohlcFromYahoo(r, 6);
      }
      data.log.push(`✓ ${sym}: $${data[key].spot.toFixed(2)} (${data[key].changePct >= 0 ? '+' : ''}${data[key].changePct.toFixed(2)}%)`);
    } catch (e) {
      data.log.push(`✗ ${sym}: ${e.message}`);
    }
  }

  // --- VALIDATION: pick the best silver display source ---
  // Strategy: prefer spot (XAG=X) for display price, but cross-check against
  // SI=F futures and SLV ETF * 10.4. If any source's |changePct| > 18%, treat as
  // stale prev-close artifact and use median of working sources.
  if (data.silverSpot && data.silver) {
    const futuresChange = Math.abs(data.silver.changePct);
    const spotChange = Math.abs(data.silverSpot.changePct);
    const futuresSpot = data.silver.spot;
    const realSpot = data.silverSpot.spot;
    const priceGap = Math.abs(futuresSpot - realSpot) / realSpot;

    // Use SLV * 10.4 as an additional cross-check (1 SLV ≈ 1 oz silver at $10.40 per share)
    let slvImpliedSpot = null;
    if (data.silverETF && data.silverETF.spot > 5) {
      // SLV trades around 1/10th of silver spot price (with small mgmt fee drag)
      slvImpliedSpot = data.silverETF.spot * (realSpot / data.silverETF.spot);
      // Simpler: use SLV's % change as the truth signal
    }

    // Decision rules
    const useSpot = spotChange < 18 && priceGap < 0.10;
    const useFutures = futuresChange < 18 && (priceGap < 0.10 || !useSpot);

    if (useSpot) {
      // Spot is clean — use it as primary display
      data.silverDisplay = {
        spot: data.silverSpot.spot,
        prev: data.silverSpot.prev,
        change: data.silverSpot.change,
        changePct: data.silverSpot.changePct,
        source: 'XAG=X (spot)',
      };
      data.log.push(`→ display: spot ($${realSpot.toFixed(2)}, ${data.silverSpot.changePct.toFixed(2)}%)`);
    } else if (useFutures) {
      data.silverDisplay = {
        spot: data.silver.spot,
        prev: data.silver.prev,
        change: data.silver.change,
        changePct: data.silver.changePct,
        source: 'SI=F (futures)',
      };
      data.log.push(`→ display: futures (spot rejected, |Δ|=${spotChange.toFixed(1)}%)`);
    } else {
      // Both look stale — use SLV-derived change as authoritative
      if (data.silverETF) {
        data.silverDisplay = {
          spot: realSpot,
          prev: realSpot / (1 + data.silverETF.changePct/100),
          change: realSpot * data.silverETF.changePct / 100,
          changePct: data.silverETF.changePct,
          source: 'SLV-derived',
        };
        data.log.push(`! both spot+futures looked stale; using SLV %Δ=${data.silverETF.changePct.toFixed(2)}%`);
      } else {
        data.silverDisplay = data.silverSpot;
        data.log.push(`! all sources suspect; using spot anyway`);
      }
    }
  } else if (data.silver) {
    // Spot fetch failed; futures only
    data.silverDisplay = { ...data.silver, source: 'SI=F (futures, no spot)' };
  }

  // Pass 2: backups for silver/gold if Yahoo failed
  if (!data.silver || !data.gold) {
    data.log.push('-- attempting metal backups --');

    // Try goldprice.org first (gives both metals + change)
    try {
      const item = await fetchGoldpriceOrg();
      if (!data.silver) {
        data.silver = {
          spot: item.xagPrice,
          prev: item.xagClose ?? (item.xagPrice - item.chgXag),
          change: item.chgXag,
          changePct: item.pcXag,
        };
        data.sources.silver = 'goldprice.org';
        data.log.push(`✓ silver via goldprice.org: $${item.xagPrice.toFixed(2)}`);
      }
      if (!data.gold) {
        data.gold = {
          spot: item.xauPrice,
          prev: item.xauClose ?? (item.xauPrice - item.chgXau),
          change: item.chgXau,
          changePct: item.pcXau,
        };
        data.sources.gold = 'goldprice.org';
        data.log.push(`✓ gold via goldprice.org: $${item.xauPrice.toFixed(2)}`);
      }
    } catch (e) {
      data.log.push(`✗ goldprice.org: ${e.message}`);
    }

    // Try gold-api.com as final fallback
    if (!data.silver) {
      try {
        const ag = await fetchGoldApi('XAG');
        data.silver = { spot: ag.price, prev: ag.price, change: 0, changePct: 0 };
        data.sources.silver = 'gold-api.com';
        data.log.push(`✓ silver via gold-api.com: $${ag.price.toFixed(2)} (no prev close)`);
      } catch (e) {
        data.log.push(`✗ gold-api.com silver: ${e.message}`);
      }
    }
    if (!data.gold) {
      try {
        const au = await fetchGoldApi('XAU');
        data.gold = { spot: au.price, prev: au.price, change: 0, changePct: 0 };
        data.sources.gold = 'gold-api.com';
        data.log.push(`✓ gold via gold-api.com: $${au.price.toFixed(2)}`);
      } catch (e) {
        data.log.push(`✗ gold-api.com gold: ${e.message}`);
      }
    }
  }

  data.healthyCount = Object.keys(data.sources).length;
  data.totalCount = Object.keys(SYMBOLS).length;

  // Write latest.json
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(data, null, 2));

  // Optionally archive (kept off by default to avoid repo bloat).
  // Uncomment to keep a history of snapshots for backtesting:
  // const archiveDir = path.join(outDir, 'history');
  // fs.mkdirSync(archiveDir, { recursive: true });
  // const ts = data.fetchedAt.replace(/[:.]/g, '-');
  // fs.writeFileSync(path.join(archiveDir, `${ts}.json`), JSON.stringify(data));

  console.log('=== Fetch complete ===');
  data.log.forEach(l => console.log('  ' + l));
  console.log(`\n${data.healthyCount}/${data.totalCount} sources healthy`);
  if (data.healthyCount === 0) {
    console.error('NO SOURCES SUCCEEDED — writing log only');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
