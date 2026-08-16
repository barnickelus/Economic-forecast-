#!/usr/bin/env node
/**
 * REFEREE: item-7 Fed-conflict test (hypothesis queued 2026-07-19, evaluation
 * code frozen 2026-08-16 — before the test could be run).
 *
 * Hypothesis: a hawkish shift in Kalshi rate-path odds should have capped
 * bullish confidence — i.e. bullish calls made INTO a hawkish drift score
 * materially worse than bullish calls made without one.
 *
 * Pre-committed operationalization:
 *  - Maturity gate: >=60 distinct logged days in data/kalshi-log.json.
 *  - For every PRIMARY directional BULLISH entry in the tilt log, recompute
 *    hawk-minus-cut drift over the ~5 logged days ending at the entry date,
 *    for the nearest Fed meeting AS OF that date (from kalshi-log history
 *    only — no future rows).
 *  - Hawk-drifted group: drift >= +5pp. Pooled t+5 and t+10 hits.
 *  - PASS (channel real; cap justified) iff hawk-drifted bullish hit rate is
 *    >= 15pp WORSE than other bullish, with >=5 drifted and >=10 other
 *    horizon-calls. Otherwise FAIL: the cap is not justified by this sample —
 *    consistent with the channel's falsified-as-general-driver status.
 */
const fs = require('fs'); const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))); } catch (e) { return null; } };
const k = load('kalshi-log.json') || [], log = load('tilt-log.json') || [];
const dec = k.filter(r => r.series === 'KXFEDDECISION' && r.yes != null && r.closeTime);
const days = [...new Set(dec.map(r => r.date))].sort();
console.log('referee-kalshi: ' + days.length + ' distinct Kalshi-logged days');
if (days.length < 60) { console.log('  NOT READY — needs >=60 (pre-committed). No peeking until then.'); process.exit(0); }
function driftAsOf(entryDate) {
  const upto = days.filter(d => d <= entryDate);
  if (upto.length < 2) return null;
  const lastDay = upto[upto.length - 1], refDay = upto[Math.max(0, upto.length - 6)];
  const live = dec.filter(r => r.date === lastDay && r.closeTime > entryDate).map(r => r.closeTime).sort()[0];
  if (!live) return null;
  const hmc = day => {
    const rows = dec.filter(r => r.date === day && r.closeTime === live);
    if (!rows.length) return null;
    let hawk = 0, cut = 0;
    rows.forEach(r => { if (/Hike rates by (>?25)/.test(r.title)) hawk += r.yes; else if (/Cut rates by/.test(r.title)) cut += r.yes; });
    return hawk - cut;
  };
  const a = hmc(refDay), b = hmc(lastDay);
  return (a == null || b == null) ? null : b - a;
}
const drifted = [], other = [];
for (const r of log) {
  if (r.dup || r.tilt !== 'bullish') continue;
  const dr = driftAsOf(String(r.t).slice(0, 10));
  for (const h of ['5', '10']) {
    if (r['hit' + h] == null) continue;
    (dr != null && dr >= 5 ? drifted : other).push(r['hit' + h] ? 1 : 0);
  }
}
console.log('  hawk-drifted bullish: ' + drifted.length + ' horizon-calls · other bullish: ' + other.length);
if (drifted.length < 5 || other.length < 10) { console.log('  NOT READY — needs >=5 drifted and >=10 other (pre-committed).'); process.exit(0); }
const dr_ = drifted.reduce((a, b) => a + b, 0) / drifted.length * 100;
const ot = other.reduce((a, b) => a + b, 0) / other.length * 100;
console.log('  hit rates: hawk-drifted ' + dr_.toFixed(0) + '% vs other ' + ot.toFixed(0) + '%');
console.log(dr_ <= ot - 15 ? '  VERDICT: PASS — hawkish drift capping bullish confidence is justified (wiring still a separate decision)' : '  VERDICT: FAIL — cap not justified by this sample; channel stays annotation-only');
