#!/usr/bin/env node
/**
 * Catalyst odds logger — runs on GitHub Actions (server-side, no CORS wall).
 *
 * Purpose: build the historical Polymarket odds time-series aligned to oil
 * that we need to ever test prediction-market -> oil -> silver lead/lag.
 * The browser "Log today's snapshot" button required Chris to open the page
 * daily; this removes the human from the loop entirely.
 *
 * Reads topics from data/odds-topics.json (editable via GitHub web UI):
 *   { "topics": ["iran", "hormuz", "fed rate", "israel", "oil price"] }
 *
 * Output:
 *   data/catalyst-log.json    — append-only daily rows (the backtest series)
 *   data/catalyst-latest.json — current odds + velocity vs prior logged day
 */

const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; Kelly-Catalyst-Logger/1.0; +https://github.com/)';

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOPICS_FILE = path.join(DATA_DIR, 'odds-topics.json');
const LOG_FILE = path.join(DATA_DIR, 'catalyst-log.json');
const LATEST_FILE = path.join(DATA_DIR, 'catalyst-latest.json');
const KALSHI_LOG_FILE = path.join(DATA_DIR, 'kalshi-log.json');

const DEFAULT_TOPICS = ['iran', 'hormuz', 'fed rate', 'israel', 'oil price'];
// Kalshi series to log daily — the Fed-channel instrument the tilt engine lacks.
// Purpose: build a daily market-implied rate-path series so the "hawkish shift
// should cap bullish confidence" hypothesis can eventually be TESTED, not assumed.
// Editable in data/odds-topics.json under "kalshiSeries"; unknown tickers just
// warn in the Actions log so wrong guesses are visible, not silent.
const DEFAULT_KALSHI_SERIES = ['KXFEDDECISION', 'KXFED', 'KXCPIYOY'];

async function fetchJSON(url) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ---------- Polymarket ----------
function marketToRow(m, term) {
  let yes = null;
  try {
    const op = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
    if (op && op.length) yes = parseFloat(op[0]) * 100;
  } catch (e) {}
  if (yes == null && m.lastTradePrice != null) yes = parseFloat(m.lastTradePrice) * 100;
  // book depth/quality fields: thin or wide-spread books mean the "odds" are
  // noise regardless of level — log them so the backtest can condition on quality
  let spread = null;
  if (m.bestBid != null && m.bestAsk != null) spread = +((parseFloat(m.bestAsk) - parseFloat(m.bestBid)) * 100).toFixed(2);
  return {
    q: term,
    title: m.question || m.title || m.groupItemTitle || term,
    slug: m.slug || null,
    conditionId: m.conditionId || null,
    yes: yes == null || isNaN(yes) ? null : +yes.toFixed(2),
    vol24: +(m.volume24hr || m.volume24hrClob || 0),
    liquidity: m.liquidityNum != null ? +m.liquidityNum : (m.liquidity != null ? +m.liquidity : null),
    spreadPts: spread,
    endDate: m.endDate || m.end_date_iso || null,
  };
}

// Trade count over the last 24h from the Polymarket data-api. Distinguishes
// "odds moved on one whale" from "odds moved on broad flow" — a whale-only
// reprice and a crowd reprice are different signals even at identical deltas.
// Best-effort: any failure returns null rather than blocking the log.
async function fetchTradeCount24h(conditionId) {
  if (!conditionId) return null;
  try {
    const trades = await fetchJSON(
      'https://data-api.polymarket.com/trades?market=' + encodeURIComponent(conditionId) + '&limit=500'
    );
    if (!Array.isArray(trades)) return null;
    const cutoff = Date.now() / 1000 - 86400;
    let n = 0;
    for (const t of trades) {
      const ts = +(t.timestamp || t.matchTime || 0);
      if (ts >= cutoff) n++;
    }
    // 500 recent trades all inside 24h means we undercounted — mark as ">=500"
    return trades.length >= 500 && n >= 500 ? 500 : n;
  } catch (e) {
    return null;
  }
}

// ---------- Kalshi (regulated US exchange — Fed/CPI markets, public API) ----------
async function fetchKalshiSeries(seriesList) {
  const out = [];
  for (const series of seriesList) {
    const st = String(series).trim();
    if (!st) continue;
    try {
      const j = await fetchJSON(
        'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=' + encodeURIComponent(st) + '&status=open&limit=50'
      );
      let markets = j.markets || [];
      if (!markets.length) { console.log('⚠ kalshi "' + st + '": 0 open markets — wrong series ticker? Edit kalshiSeries in data/odds-topics.json'); continue; }
      // near-dated meetings first — the API can return distant dead markets first,
      // and with a result cap that buries every market that actually trades
      markets.sort((a, b) => String(a.close_time || a.closeTime || '') < String(b.close_time || b.closeTime || '') ? -1 : 1);
      const pick = (m, ...names) => { for (const n of names) if (m[n] != null) return m[n]; return null; };
      // live API returns dollar-STRING fields ("0.0600" = 6¢ = 6%) instead of the
      // documented integer-cent fields — verified from a raw sample in the Actions
      // log on 2026-07-19. Support both shapes.
      const cents = (m, base) => {
        if (m[base] != null && m[base] !== 0) return +m[base];
        if (m[base + '_dollars'] != null) { const v = parseFloat(m[base + '_dollars']) * 100; return isNaN(v) ? null : v; }
        return m[base] != null ? +m[base] : null;
      };
      let quoted = 0;
      for (const m of markets) {
        // Kalshi prices normalize to cents (0-100). Mid of bid/ask when both exist, else last.
        const bid = cents(m, 'yes_bid'), ask = cents(m, 'yes_ask');
        const last = cents(m, 'last_price');
        let yes = null;
        if (bid != null && ask != null && ask > 0) yes = (bid + ask) / 2;
        else if (last != null && last > 0) yes = last;
        if (yes == null) continue; // dead market, no order book — logging it teaches nothing
        quoted++;
        if (quoted > 15) break;   // cap per series: the near-dated quoted markets are the signal
        out.push({
          series: st,
          ticker: m.ticker,
          title: m.title || m.subtitle || m.ticker,
          yes: +(+yes).toFixed(2),
          yesBid: bid, yesAsk: ask,
          vol24: pick(m, 'volume_24h', 'volume24h', 'volume'),
          openInterest: pick(m, 'open_interest', 'openInterest'),
          closeTime: pick(m, 'close_time', 'closeTime'),
        });
      }
      console.log('✓ kalshi "' + st + '": ' + markets.length + ' open, ' + Math.min(quoted, 15) + ' quoted+logged');
      if (!quoted) console.log('⚠ kalshi "' + st + '": zero quoted markets — raw field sample: ' + JSON.stringify(markets[0]).slice(0, 400));
    } catch (e) {
      console.log('✗ kalshi "' + st + '": ' + e.message);
    }
  }
  return out;
}

function matchesTerm(title, term) {
  const t = (title || '').toLowerCase();
  const words = term.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  return words.length > 0 && words.every(w => t.includes(w));
}

function isPastEnd(row) {
  if (!row.endDate) return false;
  const d = new Date(row.endDate);
  return !isNaN(d) && d < new Date();
}

async function fetchContracts(topics) {
  const out = [];
  for (const term of topics) {
    const tt = String(term).trim();
    if (!tt) continue;
    let got = [];
    try {
      const sj = await fetchJSON(
        'https://gamma-api.polymarket.com/public-search?q=' + encodeURIComponent(tt) +
        '&limit_per_type=10&events_status=active'
      );
      for (const ev of (sj.events || [])) for (const m of (ev.markets || [])) got.push(m);
      for (const m of (sj.markets || [])) got.push(m);
    } catch (e) {
      console.log('✗ search "' + tt + '": ' + e.message);
    }
    const rows = got.map(m => marketToRow(m, tt))
      .filter(r => matchesTerm(r.title, tt))
      .filter(r => !isPastEnd(r))
      .filter(r => !(r.yes != null && (r.yes <= 1 || r.yes >= 99))) // settled/pinned
      .sort((a, b) => (b.vol24 || 0) - (a.vol24 || 0))
      .slice(0, 5);
    out.push(...rows);
    console.log('✓ "' + tt + '": ' + rows.length + ' live contracts');
  }
  // dedupe by title
  const seen = new Set(), uniq = [];
  for (const r of out) { if (r.title && !seen.has(r.title)) { seen.add(r.title); uniq.push(r); } }
  return uniq;
}

// ---------- Oil (Yahoo, roll-safe: change vs prior daily close in-series) ----------
async function fetchOilQuote(sym) {
  try {
    const j = await fetchJSON(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=10d'
    );
    const res = j?.chart?.result?.[0];
    const meta = res?.meta;
    if (!meta) return null;
    const spot = meta.regularMarketPrice;
    const closes = (res?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    const prev = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? spot);
    const changePct = prev ? ((spot - prev) / prev * 100) : 0;
    return { spot: +spot.toFixed(2), changePct: +changePct.toFixed(2) };
  } catch (e) {
    console.log('✗ oil ' + sym + ': ' + e.message);
    return null;
  }
}

// ---------- main ----------
(async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let topics = DEFAULT_TOPICS, kalshiSeries = DEFAULT_KALSHI_SERIES;
  if (fs.existsSync(TOPICS_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
      topics = cfg.topics || DEFAULT_TOPICS;
      kalshiSeries = cfg.kalshiSeries || DEFAULT_KALSHI_SERIES;
    } catch (e) {}
  } else {
    fs.writeFileSync(TOPICS_FILE, JSON.stringify({ topics: DEFAULT_TOPICS, kalshiSeries: DEFAULT_KALSHI_SERIES }, null, 2));
  }

  const [contracts, kalshiRows, brent, wti] = await Promise.all([
    fetchContracts(topics),
    fetchKalshiSeries(kalshiSeries),
    fetchOilQuote('BZ=F'),
    fetchOilQuote('CL=F'),
  ]);

  // per-contract 24h trade counts (sequential — small N, be polite to the API)
  for (const c of contracts) c.trades24h = await fetchTradeCount24h(c.conditionId);

  // load existing log
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) { log = []; }
  }

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();

  // prior-day odds lookup for velocity (most recent logged yes per title before today)
  const prior = {};
  for (const r of log) {
    if (r.date < today && (!prior[r.title] || r.date > prior[r.title].date)) prior[r.title] = r;
  }

  let appended = 0;
  const latestRows = [];
  for (const c of contracts) {
    const prev = prior[c.title];
    const delta = (prev && prev.yes != null && c.yes != null) ? +(c.yes - prev.yes).toFixed(2) : null;
    latestRows.push({ ...c, deltaVsPriorDay: delta, priorDate: prev ? prev.date : null });
    // one row per contract per day; update today's row if it exists (later run wins)
    const idx = log.findIndex(r => r.date === today && r.title === c.title);
    const row = {
      date: today, fetchedAt: nowIso, title: c.title, slug: c.slug,
      yes: c.yes, vol24: c.vol24, endDate: c.endDate,
      liquidity: c.liquidity, spreadPts: c.spreadPts, trades24h: c.trades24h,
      brent: brent ? brent.spot : null, wti: wti ? wti.spot : null,
      brentChangePct: brent ? brent.changePct : null,
    };
    if (idx >= 0) log[idx] = row; else { log.push(row); appended++; }
  }

  // Kalshi daily log — same one-row-per-market-per-day pattern (later run wins)
  let klog = [];
  if (fs.existsSync(KALSHI_LOG_FILE)) {
    try { klog = JSON.parse(fs.readFileSync(KALSHI_LOG_FILE, 'utf8')); } catch (e) { klog = []; }
  }
  let kAppended = 0;
  for (const k of kalshiRows) {
    const idx = klog.findIndex(r => r.date === today && r.ticker === k.ticker);
    const row = { date: today, fetchedAt: nowIso, ...k };
    if (idx >= 0) klog[idx] = row; else { klog.push(row); kAppended++; }
  }
  fs.writeFileSync(KALSHI_LOG_FILE, JSON.stringify(klog, null, 1));

  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1));
  fs.writeFileSync(LATEST_FILE, JSON.stringify({
    fetchedAt: nowIso,
    oil: { brent, wti },
    contracts: latestRows,
    kalshi: kalshiRows,
    logRows: log.length,
    logDays: new Set(log.map(r => r.date)).size,
    kalshiLogRows: klog.length,
  }, null, 2));

  console.log('✓ log: ' + log.length + ' rows across ' + new Set(log.map(r => r.date)).size +
    ' days (+' + appended + ' new today) · ' + latestRows.length + ' live contracts' +
    ' · kalshi: ' + klog.length + ' rows (+' + kAppended + ' today)');
  if (!contracts.length) console.log('⚠ zero contracts matched — check data/odds-topics.json terms');
  if (!kalshiRows.length) console.log('⚠ zero kalshi markets — check kalshiSeries tickers in data/odds-topics.json');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
