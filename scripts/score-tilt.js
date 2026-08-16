#!/usr/bin/env node
/**
 * Server-side tilt scorer — the durable half of the forward log.
 *
 * Reads data/tilt-log.json and fills t+5/10/20 scores from the committed
 * silver OHLC (data/SI_F.json -> historical.ohlc) at EXACT trading-day
 * offsets. Never touches a live quote: a horizon is only scored once a
 * committed close exists that far out. Idempotent — safe to run on every
 * Actions pass; already-scored horizons are left alone.
 *
 * Also computes the momentum baseline per entry (sign of the trailing
 * 20-trading-day return at entry) — the reigning champion any tilt must beat.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TILT_FILE = path.join(DATA_DIR, 'tilt-log.json');
const SI_FILE = path.join(DATA_DIR, 'SI_F.json');

function loadJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fallback; }
}

const log = loadJSON(TILT_FILE, null);
if (!Array.isArray(log)) { console.log('no data/tilt-log.json (or not an array) — nothing to score'); process.exit(0); }
if (!log.length) { console.log('tilt-log.json is empty — nothing to score'); process.exit(0); }

const si = loadJSON(SI_FILE, {});
const ohlc = ((si.historical || {}).ohlc || []).slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
if (ohlc.length < 30) { console.log('SI_F.json historical.ohlc missing/short — cannot score'); process.exit(0); }

const HORIZONS = [[5, 'p5', 'pct5', 'hit5'], [10, 'p10', 'pct10', 'hit10'], [20, 'p20', 'pct20', 'hit20']];
let filled = 0;

// Anchor an entry to its t+0 bar.
//   - entry on a trading day        -> that bar
//   - entry after the last committed bar -> -1 (not scoreable YET; wait for the bar,
//     which is also the correct answer for a verdict logged intraday today)
//   - entry on a non-trading day inside the series (weekend/holiday) -> the LAST
//     COMPLETED session. Anchoring forward to the next session instead made "t+5"
//     span six sessions of price action from the price the logger actually saw.
function entryIndex(ohlc, d) {
  const exact = ohlc.findIndex(b => b.date === d);
  if (exact >= 0) return exact;
  if (!ohlc.length || d > ohlc[ohlc.length - 1].date) return -1;
  let i = -1;
  for (let k = 0; k < ohlc.length; k++) { if (ohlc[k].date < d) i = k; else break; }
  return i;
}
// Bumping this marker forces one clean re-score of every row whenever the
// scoring rule itself changes (v2 = corrected non-trading-day anchor).
const SCORE_VERSION = 'ohlc-v2';

// ONE OBSERVATION PER DAY: the FIRST entry of each calendar day is the scored
// commitment; later same-day entries are revisions made after seeing more tape,
// so they stay in the log (nothing is ever deleted) and get scored for
// reference, but are flagged dup and excluded from every aggregate. Recomputed
// deterministically each run so out-of-order arrivals settle correctly.
log.sort((a, b) => a.t < b.t ? -1 : 1);
{
  const seenDay = new Set();
  for (const r of log) {
    const day = String(r.t).slice(0, 10);
    r.dup = seenDay.has(day);
    seenDay.add(day);
  }
}

for (const r of log) {
  if (!r || !r.t || r.spot == null || !r.tilt) continue;
  const entryDate = String(r.t).slice(0, 10);
  const idx = entryIndex(ohlc, entryDate);
  // == null (not === undefined): an entry logged before its t+0 bar commits
  // scores with idx -1 and momoDir lands null. It must stay eligible for
  // recomputation once the bar arrives, or that entry is silently dropped
  // from the momentum baseline.
  if (r.momoDir == null) r.momoDir = (idx >= 20) ? (ohlc[idx].c >= ohlc[idx - 20].c ? 'bullish' : 'bearish') : null;
  for (const [n, pk, pctk, hitk] of HORIZONS) {
    if (r[pk] != null && r.scoredFrom === SCORE_VERSION) continue;
    const target = idx < 0 ? -1 : idx + n;
    const c = (target >= 0 && target < ohlc.length) ? ohlc[target].c : null;
    if (c == null) continue; // no committed close that far out yet
    r[pk] = +c.toFixed(3);
    r[pctk] = +(((c - r.spot) / r.spot) * 100).toFixed(2);
    r[hitk] = (r.tilt === 'bullish' && r[pctk] > 0) || (r.tilt === 'bearish' && r[pctk] < 0) || (r.tilt === 'balanced' && Math.abs(r[pctk]) < 2);
    filled++;
  }
  if (r.momoDir) {
    for (const [hk, pk2, mk] of [['hit5', 'pct5', 'momoHit5'], ['hit10', 'pct10', 'momoHit10'], ['hit20', 'pct20', 'momoHit20']]) {
      if (r[hk] != null && r[mk] == null) r[mk] = (r.momoDir === 'bullish') ? r[pk2] > 0 : r[pk2] < 0;
    }
  }
  r.scoredFrom = SCORE_VERSION;
}

fs.writeFileSync(TILT_FILE, JSON.stringify(log, null, 1));

// summary — directional calls only (balanced = abstain, no probability to
// calibrate), and only the primary entry per day (dup entries excluded)
const calls = [], momo = [];
for (const r of log) {
  if (r.dup) continue;
  for (const h of ['5', '10', '20']) {
    if (r['hit' + h] != null && (r.tilt === 'bullish' || r.tilt === 'bearish') && r.confidence != null)
      calls.push({ p: r.confidence / 100, hit: r['hit' + h] ? 1 : 0 });
    if (r['momoHit' + h] != null) momo.push(r['momoHit' + h] ? 1 : 0);
  }
}
const dups = log.filter(r => r.dup).length;
console.log('✓ tilt-log: ' + log.length + ' entries (' + (log.length - dups) + ' primary, ' + dups + ' same-day dup' + (dups === 1 ? '' : 's') + ' excluded from aggregates), +' + filled + ' horizon-scores filled this run');
if (calls.length) {
  const stated = calls.reduce((a, c) => a + c.p, 0) / calls.length * 100;
  const realized = calls.reduce((a, c) => a + c.hit, 0) / calls.length * 100;
  const brier = calls.reduce((a, c) => a + Math.pow(c.p - c.hit, 2), 0) / calls.length;
  console.log('  calibration: ' + calls.length + ' directional horizon-calls · stated ' + stated.toFixed(0) + '% vs realized ' + realized.toFixed(0) + '% · Brier ' + brier.toFixed(3) + ' (always-50% = 0.25)');
}
if (momo.length) console.log('  momentum baseline: ' + (momo.reduce((a, b) => a + b, 0) / momo.length * 100).toFixed(0) + '% hit on ' + momo.length + ' scored');

// EFFECTIVE SAMPLE SIZE. Consecutive daily entries produce horizon windows that
// overlap almost entirely — six t+20 calls logged on six consecutive days share
// 19 of 20 days of price path, so they are ONE observation wearing six hats.
// Report the greedy count of NON-OVERLAPPING windows alongside the raw count so
// the headline hit rate can never overstate how much evidence stands behind it.
{
  const parts = [];
  for (const [n] of HORIZONS) {
    const spans = [];
    for (const r of log) {
      if (r.dup || r['hit' + n] == null) continue;
      const i = entryIndex(ohlc, String(r.t).slice(0, 10));
      if (i >= 0) spans.push([i, i + n]);
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[1] - b[1]);
    let last = -1, indep = 0;
    for (const [a, b] of spans) if (a >= last) { indep++; last = b; }
    parts.push('t+' + n + ': ' + spans.length + ' scored / ' + indep + ' independent');
  }
  if (parts.length) console.log('  effective sample (non-overlapping windows) — ' + parts.join(' · '));
}

// VERDICT PERSISTENCE (auto era): a forecaster claiming 5-20 day horizons that
// flips direction day-to-day is incoherent regardless of hit rate — surface it.
{
  const autos = log.filter(r => r.source === 'auto' && !r.dup).sort((a, b) => a.t < b.t ? -1 : 1);
  if (autos.length >= 3) {
    let flips = 0;
    for (let i = 1; i < autos.length; i++) if (autos[i].tilt !== autos[i - 1].tilt) flips++;
    console.log('  auto verdict persistence: ' + flips + ' flip' + (flips === 1 ? '' : 's') + ' in ' + (autos.length - 1) + ' transitions (' + Math.round(flips / (autos.length - 1) * 100) + '% flip rate)');
  }
}
