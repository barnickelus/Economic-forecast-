#!/usr/bin/env node
/**
 * REFEREE: contradiction-ledger wiring test (rule pre-committed 2026-08-03,
 * evaluation code frozen 2026-08-16 — before any flag could be judged).
 *
 * Verbatim rule: a flag earns confidence-damping only if, after >=20 scored
 * primary directional horizon-calls of which >=5 carry that flag, the flagged
 * calls' hit rate is >=15 percentage points WORSE than the unflagged calls'.
 * Anything else: the flag stays a decorative annotation.
 */
const fs = require('fs'); const path = require('path');
let log; try { log = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tilt-log.json'))); } catch (e) { log = []; }
const calls = [];
for (const r of log) {
  if (r.dup || (r.tilt !== 'bullish' && r.tilt !== 'bearish')) continue;
  for (const h of ['5', '10', '20']) {
    if (r['hit' + h] == null) continue;
    calls.push({ hit: r['hit' + h] ? 1 : 0, flags: Array.isArray(r.flags) ? r.flags : [] });
  }
}
console.log('referee-flags: ' + calls.length + ' scored primary directional horizon-calls');
const ALL = ['oil-premise', 'ratio-confirmer', 'curve-incoherent', 'kalshi-conflict', 'physical-stress'];
for (const f of ALL) {
  const withF = calls.filter(c => c.flags.includes(f));
  const without = calls.filter(c => !c.flags.includes(f));
  if (calls.length < 20 || withF.length < 5) {
    console.log('  ' + f + ': ' + withF.length + ' flagged — NOT READY (needs >=20 total, >=5 flagged)');
    continue;
  }
  const fr = withF.reduce((a, c) => a + c.hit, 0) / withF.length * 100;
  const ur = without.reduce((a, c) => a + c.hit, 0) / without.length * 100;
  const wire = fr <= ur - 15;
  console.log('  ' + f + ': flagged ' + fr.toFixed(0) + '% vs unflagged ' + ur.toFixed(0) + '% -> ' + (wire ? 'EARNS WIRING (separate decision to implement)' : 'stays annotation-only'));
}
