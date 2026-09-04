#!/usr/bin/env node
/**
 * MARKET TURN-UP SCANNER — runs in Actions (sandbox can't reach Yahoo).
 * Fetches ~6 months of daily bars for a broad watchlist and applies the same
 * mechanical turn-up screen used on the repo's own tickers:
 *
 *   TURNING UP (fresh): close > 10d MA, 10d MA rising, 5d change > +1%,
 *     prior-20d change (as of 10 sessions ago) <= +2% (i.e. it was flat/down
 *     — a TURN, not an ongoing trend), and a higher low (min of last 10
 *     sessions > min of prior 10).
 *   already trending / improving / basing / turning down: as labeled.
 *
 * Output: prints a sorted table to the Actions log and writes
 * data/scan-latest.json. Watchlist lives below — edit freely; this is a
 * convenience screen, NOT part of the forecast program's scored instruments.
 */

const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (compatible; Kelly-Scanner/1.0; +https://github.com/)';

const WATCHLIST = [
  // sector / industry ETFs
  'XLE', 'XLF', 'XLK', 'XLV', 'XLI', 'XLP', 'XLU', 'XLY', 'XLB', 'XLRE',
  'XBI', 'SMH', 'XME', 'KRE', 'ITB', 'XOP', 'URA', 'LIT',
  // megacap / large tech
  'MSFT', 'GOOGL', 'AMZN', 'META', 'AVGO', 'AMD', 'MU', 'INTC', 'CRM', 'ORCL', 'NFLX',
  // precious metals complex
  'GDX', 'GDXJ', 'SIL', 'SILJ', 'AU', 'AG', 'NEM', 'GOLD', 'PAAS', 'WPM', 'FNV', 'HL', 'CDE', 'FSM', 'MAG', 'EXK', 'SLV', 'GLD',
  // energy / materials
  'XOM', 'CVX', 'OXY', 'SLB', 'HAL', 'FCX', 'SCCO', 'ALB', 'CCJ',
  // momentum / crypto-adjacent
  'COIN', 'MSTR', 'PLTR',
];

const isWeekend = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };

async function fetchDaily(sym) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=6mo',
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const ts = res?.timestamp || [];
    const cl = res?.indicators?.quote?.[0]?.close || [];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      if (cl[i] == null) continue;
      const d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (isWeekend(d)) continue;
      bars.push({ date: d, c: cl[i] });
    }
    return bars;
  } catch (e) { clearTimeout(tid); return { error: e.message }; }
}

function screen(c) {
  if (c.length < 45) return null;
  const last = c[c.length - 1];
  const d1 = (c[c.length - 1] / c[c.length - 2] - 1) * 100;
  const d5 = (c[c.length - 1] / c[c.length - 6] - 1) * 100;
  const d20 = (c[c.length - 1] / c[c.length - 21] - 1) * 100;
  const ma10 = c.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma10p = c.slice(-13, -3).reduce((a, b) => a + b, 0) / 10;
  const ma10r = ma10 > ma10p;
  const above = last > ma10;
  const prior20 = (c[c.length - 11] / c[c.length - 31] - 1) * 100;
  const hl = Math.min(...c.slice(-10)) > Math.min(...c.slice(-20, -10));
  let verdict;
  if (above && ma10r && d5 > 1 && prior20 <= 2 && hl) verdict = 'TURNING_UP';
  else if (above && ma10r && d20 > 5) verdict = 'trending';
  else if (above && ma10r) verdict = 'improving';
  else if (!above && !ma10r && d5 < -1) verdict = 'turning_down';
  else verdict = 'basing';
  return { last: +last.toFixed(2), d1: +d1.toFixed(1), d5: +d5.toFixed(1), d20: +d20.toFixed(1), verdict };
}

(async function main() {
  const out = { fetchedAt: new Date().toISOString(), results: {} };
  const failed = [];
  for (const sym of WATCHLIST) {
    const bars = await fetchDaily(sym);
    if (bars.error || !Array.isArray(bars)) { failed.push(sym + (bars.error ? ' (' + bars.error + ')' : '')); continue; }
    const s = screen(bars.map(b => b.c));
    if (s) out.results[sym] = s;
    await new Promise(r => setTimeout(r, 150)); // be polite
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'scan-latest.json'), JSON.stringify(out, null, 1));

  const order = { TURNING_UP: 0, improving: 1, trending: 2, basing: 3, turning_down: 4 };
  const rows = Object.entries(out.results).sort((a, b) =>
    (order[a[1].verdict] - order[b[1].verdict]) || (b[1].d5 - a[1].d5));
  console.log('MARKET TURN-UP SCAN · ' + rows.length + ' scanned · ' + failed.length + ' failed' + (failed.length ? ' [' + failed.join(', ') + ']' : ''));
  console.log('sym'.padEnd(7) + 'last'.padStart(10) + '1d%'.padStart(7) + '5d%'.padStart(7) + '20d%'.padStart(8) + '  verdict');
  for (const [sym, s] of rows) {
    console.log(sym.padEnd(7) + String(s.last).padStart(10) + (s.d1 >= 0 ? '+' : '').padStart(0).concat().padEnd(0) +
      String((s.d1 >= 0 ? '+' : '') + s.d1).padStart(7) + String((s.d5 >= 0 ? '+' : '') + s.d5).padStart(7) +
      String((s.d20 >= 0 ? '+' : '') + s.d20).padStart(8) + '  ' + s.verdict);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
