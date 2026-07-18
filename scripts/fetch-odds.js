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

const DEFAULT_TOPICS = ['iran', 'hormuz', 'fed rate', 'israel', 'oil price'];

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
  return {
    q: term,
    title: m.question || m.title || m.groupItemTitle || term,
    slug: m.slug || null,
    yes: yes == null || isNaN(yes) ? null : +yes.toFixed(2),
    vol24: +(m.volume24hr || m.volume24hrClob || 0),
    endDate: m.endDate || m.end_date_iso || null,
  };
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

  let topics = DEFAULT_TOPICS;
  if (fs.existsSync(TOPICS_FILE)) {
    try { topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')).topics || DEFAULT_TOPICS; } catch (e) {}
  } else {
    fs.writeFileSync(TOPICS_FILE, JSON.stringify({ topics: DEFAULT_TOPICS }, null, 2));
  }

  const [contracts, brent, wti] = await Promise.all([
    fetchContracts(topics),
    fetchOilQuote('BZ=F'),
    fetchOilQuote('CL=F'),
  ]);

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
      brent: brent ? brent.spot : null, wti: wti ? wti.spot : null,
      brentChangePct: brent ? brent.changePct : null,
    };
    if (idx >= 0) log[idx] = row; else { log.push(row); appended++; }
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1));
  fs.writeFileSync(LATEST_FILE, JSON.stringify({
    fetchedAt: nowIso,
    oil: { brent, wti },
    contracts: latestRows,
    logRows: log.length,
    logDays: new Set(log.map(r => r.date)).size,
  }, null, 2));

  console.log('✓ log: ' + log.length + ' rows across ' + new Set(log.map(r => r.date)).size +
    ' days (+' + appended + ' new today) · ' + latestRows.length + ' live contracts');
  if (!contracts.length) console.log('⚠ zero contracts matched — check data/odds-topics.json terms');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
