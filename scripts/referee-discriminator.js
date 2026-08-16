#!/usr/bin/env node
/**
 * REFEREE: oil-regime discriminator falsifier (pre-committed 2026-07-19,
 * evaluation code frozen 2026-08-16 — before the test could be run).
 *
 * Hypothesis: conditioning the ~20d oil->silver mapping on the CAUSE of the
 * oil move beats the unconditioned (falsified) mapping.
 * Test, verbatim from the dashboard panel: after >=30 regime-tagged trading
 * days with scoreable t+20 outcomes, the regime-conditioned mapping must beat
 * the unconditioned oil signal's directional hit rate by >=10 percentage
 * points, else the discriminator is falsified and retired.
 *
 * Operationalization (fixed here, now):
 *  - Regimes reconstructed per trading day from committed OHLC only (10-session
 *    co-movement of CL, HG, ^TNX; thresholds 1.5%/1.5%/8bp as in the panel).
 *  - Tagged day = SUPPLY RELIEF or DEMAND DESTRUCTION (both require oil down,
 *    so a prediction is always defined): RELIEF -> silver UP at t+20;
 *    DEMAND DESTRUCTION -> silver DOWN at t+20.
 *  - Unconditioned baseline ON THE SAME DAYS: oil down -> silver UP (the old
 *    mapping). Same denominators; no cherry-picking.
 *  - Window: tagged days from 2026-07-19 forward. Weekend pseudo-bars excluded.
 */
const fs = require('fs'); const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const wd = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };
const load = t => { try { return (JSON.parse(fs.readFileSync(path.join(DATA_DIR, t + '.json'))).historical.ohlc || []).filter(b => wd(b.date)); } catch (e) { return []; } };
const si = load('SI_F'), cl = load('CL_F'), hg = load('HG_F'), tnx = load('_TNX');
if (!si.length || !cl.length || !hg.length || !tnx.length) { console.log('referee-discriminator: series missing — NOT READY'); process.exit(0); }
const bd = s => Object.fromEntries(s.map((b, i) => [b.date, i]));
const iC = bd(cl), iH = bd(hg), iT = bd(tnx), iS = bd(si);
const sgn = (v, f) => v > f ? 1 : v < -f ? -1 : 0;
let tagged = 0, condHit = 0, unconHit = 0, pending = 0;
for (const d of Object.keys(iS)) {
  if (d < '2026-07-19') continue;
  const c = iC[d], h = iH[d], t = iT[d], s = iS[d];
  if (c == null || h == null || t == null || c < 10 || h < 10 || t < 10) continue;
  const oil = (cl[c].c - cl[c - 10].c) / cl[c - 10].c * 100;
  const cop = (hg[h].c - hg[h - 10].c) / hg[h - 10].c * 100;
  const yld = tnx[t].c - tnx[t - 10].c;
  const so = sgn(oil, 1.5), sc = sgn(cop, 1.5), sy = sgn(yld, 0.08);
  let regime = null;
  if (so < 0 && sc < 0 && sy < 0) regime = 'DD';
  else if (so < 0 && sc >= 0 && sy >= 0) regime = 'RELIEF';
  if (!regime) continue;
  if (s + 20 >= si.length) { pending++; continue; }
  tagged++;
  const up = si[s + 20].c > si[s].c;
  if ((regime === 'RELIEF' && up) || (regime === 'DD' && !up)) condHit++;
  if (up) unconHit++; // unconditioned: oil down -> silver up, on the same day
}
console.log('referee-discriminator: ' + tagged + ' tagged days scoreable (+' + pending + ' tagged, t+20 pending)');
if (tagged < 30) { console.log('  NOT READY — needs >=30 (pre-committed). No peeking at direction until then.'); process.exit(0); }
const cr = condHit / tagged * 100, ur = unconHit / tagged * 100;
console.log('  conditioned ' + cr.toFixed(0) + '% vs unconditioned ' + ur.toFixed(0) + '% on identical days');
console.log(cr >= ur + 10 ? '  VERDICT: PASS — discriminator earns consideration for wiring (still requires explicit decision)' : '  VERDICT: FAIL — discriminator falsified; retire it to the falsified list');
