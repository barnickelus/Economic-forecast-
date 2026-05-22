#!/usr/bin/env node
/**
 * Kelly Live Dashboard — multi-asset data fetcher
 *
 * Runs on GitHub Actions every ~30 minutes.
 * Reads tickers from data/tickers.json (or falls back to default: silver).
 * For each ticker, fetches: the asset itself, its sector reference ETF,
 * and the cross-asset macro context (VIX, oil, DXY, S&P).
 *
 * Output: data/{TICKER}.json — one file per tracked ticker.
 *         data/index.json     — list of all tracked tickers.
 *         data/latest.json    — backward-compat for silver dashboard.
 */

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (compatible; Kelly-Live-Dashboard/4.0; +https://github.com/)';
const TIMEOUT_MS = 12000;

const ASSET_CONFIG = {
  // Precious metals
  'SI=F':   { name: 'Silver',    assetClass: 'commodity', sectorETF: 'SIL',  spotSource: 'XAG=X', typicalVolAnnual: 0.32 },
  'GC=F':   { name: 'Gold',      assetClass: 'commodity', sectorETF: 'GDX',  spotSource: 'XAU=X', typicalVolAnnual: 0.15 },
  // Major equities
  'AAPL':   { name: 'Apple',     assetClass: 'equity', sectorETF: 'XLK',  typicalVolAnnual: 0.25 },
  'MSFT':   { name: 'Microsoft', assetClass: 'equity', sectorETF: 'XLK',  typicalVolAnnual: 0.25 },
  'NVDA':   { name: 'Nvidia',    assetClass: 'equity', sectorETF: 'SMH',  typicalVolAnnual: 0.50 },
  'TSLA':   { name: 'Tesla',     assetClass: 'equity', sectorETF: 'XLY',  typicalVolAnnual: 0.55 },
  'AMZN':   { name: 'Amazon',    assetClass: 'equity', sectorETF: 'XLY',  typicalVolAnnual: 0.30 },
  'GOOGL':  { name: 'Alphabet',  assetClass: 'equity', sectorETF: 'XLC',  typicalVolAnnual: 0.28 },
  'META':   { name: 'Meta',      assetClass: 'equity', sectorETF: 'XLC',  typicalVolAnnual: 0.40 },
  'JPM':    { name: 'JPMorgan',  assetClass: 'equity', sectorETF: 'XLF',  typicalVolAnnual: 0.25 },
  'XOM':    { name: 'Exxon',     assetClass: 'equity', sectorETF: 'XLE',  typicalVolAnnual: 0.28 },
  'SPY':    { name: 'S&P 500 ETF', assetClass: 'index', sectorETF: 'QQQ', typicalVolAnnual: 0.15 },
  'QQQ':    { name: 'Nasdaq 100',  assetClass: 'index', sectorETF: 'SPY', typicalVolAnnual: 0.22 },
  'HL':     { name: 'Hecla Mining', assetClass: 'equity', sectorETF: 'SIL', typicalVolAnnual: 0.55 },
  'PAAS':   { name: 'Pan American', assetClass: 'equity', sectorETF: 'SIL', typicalVolAnnual: 0.50 },
  'BTC-USD': { name: 'Bitcoin',   assetClass: 'crypto', sectorETF: 'ETH-USD', typicalVolAnnual: 0.65 },

  // Macro context tickers (added for cross-asset IC analysis in macro lab)
  'DX-Y.NYB': { name: 'US Dollar Index', assetClass: 'macro', sectorETF: 'UUP', typicalVolAnnual: 0.08 },
  'HG=F':     { name: 'Copper',          assetClass: 'commodity', sectorETF: 'COPX', typicalVolAnnual: 0.25 },
  'CL=F':     { name: 'Crude Oil',       assetClass: 'commodity', sectorETF: 'XLE', typicalVolAnnual: 0.40 },
  '^VIX':     { name: 'VIX',             assetClass: 'macro', sectorETF: 'VXX', typicalVolAnnual: 1.20 },
  '^TNX':     { name: '10Y Treasury Yield', assetClass: 'macro', sectorETF: 'TLT', typicalVolAnnual: 0.20 },
  'CNY=X':    { name: 'USDCNY',          assetClass: 'macro', sectorETF: 'CYB', typicalVolAnnual: 0.05 },
};

const MACRO_SYMBOLS = {
  dxy: 'DX-Y.NYB',
  oil: 'CL=F',
  vix: '^VIX',
  spx: '^GSPC',
  tnx: '^TNX',
};

const DEFAULT_TICKERS = ['SI=F'];

async function fetchWithTimeout(url, timeout = TIMEOUT_MS) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json,*/*' },
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
  if (!r) throw new Error('no chart result');
  // Futures/index symbols (CL=F, ^VIX, ^TNX, HG=F) often OMIT meta.regularMarketPrice
  // even when full OHLC is present (esp. when market closed). Don't reject on that —
  // require usable price data from EITHER meta OR the close series.
  const hasMetaPrice = r.meta && r.meta.regularMarketPrice != null;
  const closes = r?.indicators?.quote?.[0]?.close?.filter(x => x != null) || [];
  if (!hasMetaPrice && closes.length === 0) throw new Error('no usable price data');
  return r;
}

function quoteFromYahoo(r) {
  const m = r.meta || {};
  const closes = r?.indicators?.quote?.[0]?.close?.filter(x => x != null) || [];
  // spot: prefer meta price, else last series close (futures/index when closed)
  const spot = (m.regularMarketPrice != null) ? m.regularMarketPrice
             : (closes.length ? closes[closes.length - 1] : null);
  // prev: prefer the SERIES prior close (roll-safe — same contract) over
  // meta.chartPreviousClose, which breaks across futures contract rolls.
  let prev;
  if (closes.length >= 2) prev = closes[closes.length - 2];
  else prev = m.chartPreviousClose ?? m.previousClose ?? spot;
  const changePct = (prev && spot != null) ? (spot - prev) / prev * 100 : 0;
  return { spot, prev, change: (spot != null && prev != null) ? spot - prev : 0, changePct };
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

async function fetchTicker(tickerSymbol, config, macroData) {
  const data = {
    ticker: tickerSymbol,
    config: config,
    fetchedAt: new Date().toISOString(),
    sources: {},
    log: [],
  };

  // 1. Primary asset (3mo for current dashboard)
  try {
    const r = await fetchYahoo(tickerSymbol);
    data.asset = quoteFromYahoo(r);
    data.series = seriesFromYahoo(r);
    data.recentOHLC = ohlcFromYahoo(r, 6);
    data.sources.asset = `yahoo:${tickerSymbol}`;
    const sp = (data.asset.spot != null) ? data.asset.spot.toFixed(2) : 'n/a';
    const pc = (data.asset.changePct != null) ? `${data.asset.changePct >= 0 ? '+' : ''}${data.asset.changePct.toFixed(2)}%` : 'n/a';
    data.log.push(`✓ ${tickerSymbol}: $${sp} (${pc})`);
  } catch (e) {
    data.log.push(`✗ ${tickerSymbol}: ${e.message}`);
    return data;
  }

  // 1b. Extended history (5 years) for backtesting
  // This is the longer series that drives the backtest engine.
  try {
    const r = await fetchYahoo(tickerSymbol, '5y', '1d');
    const fullSeries = seriesFromYahoo(r);
    const fullOHLC = ohlcFromYahoo(r, fullSeries.length);
    if (fullSeries.length >= 250) {  // at least 1 year of data
      data.historical = {
        series: fullSeries,
        ohlc: fullOHLC,
        bars: fullSeries.length,
      };
      data.log.push(`✓ ${tickerSymbol} history: ${fullSeries.length} bars (${(fullSeries.length/252).toFixed(1)}y)`);
    }
  } catch (e) {
    data.log.push(`✗ ${tickerSymbol} history: ${e.message}`);
  }

  // 2. Sector/peer reference ETF
  if (config.sectorETF) {
    try {
      const r = await fetchYahoo(config.sectorETF);
      data.sector = quoteFromYahoo(r);
      data.sectorName = config.sectorETF;
      data.sources.sector = `yahoo:${config.sectorETF}`;
      data.log.push(`✓ sector ${config.sectorETF}: $${data.sector.spot.toFixed(2)} (${data.sector.changePct >= 0 ? '+' : ''}${data.sector.changePct.toFixed(2)}%)`);
    } catch (e) {
      data.log.push(`✗ sector ${config.sectorETF}: ${e.message}`);
    }
  }

  // 3. Alt spot source (commodities)
  if (config.spotSource) {
    try {
      const r = await fetchYahoo(config.spotSource);
      data.spotAlt = quoteFromYahoo(r);
      data.sources.spotAlt = `yahoo:${config.spotSource}`;
      data.log.push(`✓ spot ${config.spotSource}: $${data.spotAlt.spot.toFixed(2)} (${data.spotAlt.changePct >= 0 ? '+' : ''}${data.spotAlt.changePct.toFixed(2)}%)`);
    } catch (e) {
      data.log.push(`✗ spot ${config.spotSource}: ${e.message}`);
    }
  }

  data.display = computeDisplayPrice(data, config);
  data.macro = macroData;
  data.healthyCount = Object.keys(data.sources).length;
  data.totalCount = 2 + (config.spotSource ? 1 : 0);

  return data;
}

function computeDisplayPrice(data, config) {
  if (!data.asset) return null;

  if (!data.spotAlt) {
    return {
      spot: data.asset.spot,
      prev: data.asset.prev,
      change: data.asset.change,
      changePct: data.asset.changePct,
      source: data.ticker,
    };
  }

  const spotChange = Math.abs(data.spotAlt.changePct);
  const priceGap = Math.abs(data.asset.spot - data.spotAlt.spot) / data.spotAlt.spot;

  const useSpot = spotChange < 18 && priceGap < 0.10;
  if (useSpot) {
    data.log.push(`→ display: spot ${config.spotSource}`);
    return {
      spot: data.spotAlt.spot,
      prev: data.spotAlt.prev,
      change: data.spotAlt.change,
      changePct: data.spotAlt.changePct,
      source: config.spotSource + ' (spot)',
    };
  }

  if (data.sector && Math.abs(data.sector.changePct) < 15) {
    const impliedPrev = data.spotAlt.spot / (1 + data.sector.changePct / 100);
    data.log.push(`! sources suspect; using ${data.sectorName} %Δ`);
    return {
      spot: data.spotAlt.spot,
      prev: impliedPrev,
      change: data.spotAlt.spot - impliedPrev,
      changePct: data.sector.changePct,
      source: data.sectorName + '-derived',
    };
  }

  return {
    spot: data.spotAlt.spot,
    prev: data.spotAlt.prev,
    change: data.spotAlt.change,
    changePct: data.spotAlt.changePct,
    source: config.spotSource + ' (spot)',
  };
}

async function fetchMacroContext() {
  const macro = { fetchedAt: new Date().toISOString(), log: [] };
  for (const [key, sym] of Object.entries(MACRO_SYMBOLS)) {
    try {
      const r = await fetchYahoo(sym);
      macro[key] = quoteFromYahoo(r);
      macro.log.push(`✓ ${sym}`);
    } catch (e) {
      macro.log.push(`✗ ${sym}: ${e.message}`);
    }
  }
  return macro;
}

function loadTickerList() {
  const tickerFile = path.join(__dirname, '..', 'data', 'tickers.json');
  try {
    if (fs.existsSync(tickerFile)) {
      const list = JSON.parse(fs.readFileSync(tickerFile, 'utf8'));
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch (e) {
    console.log('Could not read tickers.json, using default');
  }
  return DEFAULT_TICKERS;
}

async function main() {
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });

  const tickerList = loadTickerList();
  console.log(`Tracking ${tickerList.length} ticker(s): ${tickerList.join(', ')}\n`);

  console.log('--- Fetching macro context ---');
  const macroData = await fetchMacroContext();
  macroData.log.forEach(l => console.log('  ' + l));

  const indexEntry = {
    generatedAt: new Date().toISOString(),
    tickers: [],
  };

  for (const tickerSym of tickerList) {
    const config = ASSET_CONFIG[tickerSym] || {
      name: tickerSym,
      assetClass: 'equity',
      sectorETF: 'SPY',
      typicalVolAnnual: 0.30,
    };

    console.log(`\n--- ${tickerSym} (${config.name}) ---`);
    const result = await fetchTicker(tickerSym, config, macroData);
    result.log.forEach(l => console.log('  ' + l));

    if (result.asset) {
      const safeFilename = tickerSym.replace(/[=^]/g, '_') + '.json';
      const filePath = path.join(outDir, safeFilename);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

      indexEntry.tickers.push({
        ticker: tickerSym,
        filename: safeFilename,
        name: config.name,
        assetClass: config.assetClass,
        spot: result.display?.spot ?? result.asset.spot,
        changePct: result.display?.changePct ?? result.asset.changePct,
        healthyCount: result.healthyCount,
        totalCount: result.totalCount,
      });
      console.log(`  → wrote ${safeFilename}`);
    }
  }

  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(indexEntry, null, 2));

  // Backward compat: if silver is tracked, also write legacy latest.json
  const silverFile = path.join(outDir, 'SI_F.json');
  if (fs.existsSync(silverFile)) {
    const sData = JSON.parse(fs.readFileSync(silverFile, 'utf8'));
    const legacy = {
      fetchedAt: sData.fetchedAt,
      ticker: sData.ticker,
      sources: sData.sources,
      log: sData.log,
      silver: sData.asset,
      silverSpot: sData.spotAlt,
      silverDisplay: sData.display,
      gold: null,
      dxy: macroData.dxy,
      copper: null,
      oil: macroData.oil,
      vix: macroData.vix,
      spx: macroData.spx,
      sil: sData.sector,
      series: sData.series,
      recentOHLC: sData.recentOHLC,
      healthyCount: sData.healthyCount,
      totalCount: sData.totalCount,
    };
    fs.writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(legacy, null, 2));
  }

  // Explicit accounting: which tickers wrote vs were dropped (so silent
  // failures — like the futures/index tickers — can never recur unnoticed).
  const wrote = indexEntry.tickers.map(t => t.ticker);
  const dropped = tickerList.filter(t => !wrote.includes(t));
  console.log(`\n=== Done. ${wrote.length}/${tickerList.length} tickers written. ===`);
  console.log(`    wrote:   ${wrote.join(', ')}`);
  if (dropped.length) {
    console.log(`    DROPPED: ${dropped.join(', ')}  ← these failed to fetch; check logs above`);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
