#!/usr/bin/env node
/**
 * PRE-REGISTERED PREDICTOR STUDY — written in full BEFORE it was first run
 * (2026-09-25). Nothing below was changed after seeing results; if it ever
 * is, bump STUDY_VERSION and say why in CLAUDE.md.
 *
 * QUESTION: which single, mechanical, daily-computable signals carried
 * out-of-sample directional information about silver's forward return, and
 * do any beat the two baselines the project already owns?
 *
 * DATA: the repo's committed 5y daily closes (data/*.json -> historical.ohlc),
 * weekend pseudo-bars removed, aligned on dates present in EVERY series:
 * SI=F, GC=F, CL=F, HG=F, ^TNX, DX-Y.NYB. (No odds data — 70 days is too short.)
 *
 * TARGET: sign of silver's forward log return over h in {5, 10, 20} sessions.
 *
 * SPLIT (fixed): IN-SAMPLE = dates < 2025-01-01. OUT-OF-SAMPLE = dates >= 2025-01-01.
 * The engine's rules were designed on data through mid-2026, so even "OOS" here
 * overlaps the period the rules were built in. This study cannot be a clean
 * hold-out for v13; it is a clean test for anything NEW proposed from it only
 * because the pass bar is written down here first.
 *
 * SIGNALS (direction rule fixed a priori; +1 = bullish silver, -1 = bearish, 0 = no call):
 *   momo20     sign(SI/SI[-20]-1)                 baseline #1 (the reigning champion)
 *   always-up  +1                                 baseline #2 (silver was in a bull market)
 *   momo5      sign(SI/SI[-5]-1)
 *   momo60     sign(SI/SI[-60]-1)
 *   meanrev5   -sign(SI/SI[-5]-1)                 control: previously falsified
 *   oil1d      -sign(CL 1d change)                v13's oil rule
 *   oil5d      -sign(CL 5d change)                v14's oil rule
 *   oil20d     -sign(CL 20d change)
 *   oilLvl120  oil pctile in trailing 120d: <=30% -> +1, >=70% -> -1, else 0   (the oil-range reader)
 *   copper20   +sign(HG 20d change)
 *   tnx20      -sign(^TNX 20d change)             "yield competition" (falsified as general driver)
 *   dxy20      -sign(DXY 20d change)
 *   gold20     +sign(GC 20d change)
 *   ratio20    -sign((GC/SI) 20d change)          ratio = confirmer, not predictor — test it anyway
 *   discOil20  discriminator-conditioned oil: regime from 10d co-movement of CL/HG/^TNX
 *              (same thresholds as the dashboard). DEMAND DESTRUCTION or DEMAND/REFLATION
 *              -> silver follows oil (+sign(oil20)); SUPPLY SHOCK or SUPPLY RELIEF ->
 *              silver goes against oil (-sign(oil20)); MIXED -> 0.
 *              This is the HISTORICAL analogue of the live discriminator falsifier, not
 *              a replacement for it (that test stays on live-tagged days).
 *   momoOilAgree  momo20 only when oil20d agrees, else 0
 *
 * EVALUATION per signal x horizon:
 *   - windows are NON-OVERLAPPING: step h, averaged over all h phase offsets so
 *     the phase choice cannot be gamed. N = mean signaled windows per phase.
 *   - hit = P(sign(signal) == sign(forward return)) over signaled windows.
 *   - also reported: coverage (share of windows with a call), mean forward
 *     return in the signal's direction (bp), and the overlapping-daily hit for
 *     reference (large N, heavily dependent — never the headline).
 *
 * PASS BAR (all of, at a given horizon):
 *   1. OOS hit >= 55% with N >= 30 (h=5), >= 20 (h=10), >= 15 (h=20) signaled windows.
 *   2. IS hit >= 52% (same direction rule — no sign flip between samples).
 *   3. OOS hit beats BOTH momo20 and always-up on the SAME windows by >= 5pp.
 *   A signal is a CANDIDATE only if it passes at >= 2 of the 3 horizons.
 *   45 signal-horizon tests are run; at 5% we expect ~2 false positives, which
 *   is why a single-horizon pass is not a candidate.
 *
 * OUTPUT: table to stdout; data/study-predictors.json for the dashboard.
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const STUDY_VERSION = 'study-v1';
const OOS_START = '2025-01-01';
const H = [5, 10, 20];
const MIN_N = { 5: 30, 10: 20, 20: 15 };

const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch (e) { return null; } };
const wk = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
const series = f => { const j = load(f); const m = {}; (((j || {}).historical || {}).ohlc || []).forEach(b => { if (b && b.c != null && !wk(b.date)) m[b.date] = b.c; }); return m; };
const S = { si: series('SI_F.json'), gc: series('GC_F.json'), cl: series('CL_F.json'), hg: series('HG_F.json'), tnx: series('_TNX.json'), dxy: series('DX-Y.NYB.json') };
const dates = Object.keys(S.si).filter(d => Object.values(S).every(m => m[d] != null)).sort();
const N = dates.length;
if (N < 300) { console.log('not enough aligned history (' + N + ' days)'); process.exit(0); }
const col = k => dates.map(d => S[k][d]);
const si = col('si'), gc = col('gc'), cl = col('cl'), hg = col('hg'), tnx = col('tnx'), dxy = col('dxy');
const sgn = v => v > 0 ? 1 : v < 0 ? -1 : 0;
const chg = (a, i, k) => (i >= k) ? a[i] / a[i - k] - 1 : null;

function regime(i) {
  if (i < 10) return null;
  const pct = a => (a[i] - a[i - 10]) / a[i - 10] * 100;
  const th = (v, f) => v > f ? 1 : v < -f ? -1 : 0;
  const so = th(pct(cl), 1.5), sc = th(pct(hg), 1.5), sy = th(tnx[i] - tnx[i - 10], 0.08);
  if (so < 0 && sc < 0 && sy < 0) return 'DD';
  if (so < 0 && sc >= 0 && sy >= 0) return 'SR';
  if (so > 0 && sc > 0) return 'DR';
  if (so > 0 && sc < 0) return 'SS';
  return 'MIX';
}
const SIGNALS = {
  momo20: i => sgn(chg(si, i, 20)),
  alwaysUp: i => 1,
  momo5: i => sgn(chg(si, i, 5)),
  momo60: i => sgn(chg(si, i, 60)),
  meanrev5: i => -sgn(chg(si, i, 5)),
  oil1d: i => -sgn(chg(cl, i, 1)),
  oil5d: i => -sgn(chg(cl, i, 5)),
  oil20d: i => -sgn(chg(cl, i, 20)),
  oilLvl120: i => { if (i < 120) return null; const w = cl.slice(i - 119, i + 1); const r = w.filter(x => x < cl[i]).length / w.length; return r <= 0.30 ? 1 : r >= 0.70 ? -1 : 0; },
  copper20: i => sgn(chg(hg, i, 20)),
  tnx20: i => (i >= 20) ? -sgn(tnx[i] - tnx[i - 20]) : null,
  dxy20: i => -sgn(chg(dxy, i, 20)),
  gold20: i => sgn(chg(gc, i, 20)),
  ratio20: i => (i >= 20) ? -sgn((gc[i] / si[i]) / (gc[i - 20] / si[i - 20]) - 1) : null,
  discOil20: i => { const r = regime(i), o = sgn(chg(cl, i, 20)); if (r == null || o == null) return null; return (r === 'DD' || r === 'DR') ? o : (r === 'SS' || r === 'SR') ? -o : 0; },
  momoOilAgree: i => { const m = sgn(chg(si, i, 20)), o = -sgn(chg(cl, i, 20)); return (m != null && o != null && m === o) ? m : 0; },
};
const WARMUP = 120;
const sigCache = {};
for (const k of Object.keys(SIGNALS)) sigCache[k] = dates.map((_, i) => i < WARMUP ? null : SIGNALS[k](i));
const fwd = {}; for (const h of H) fwd[h] = dates.map((_, i) => (i + h < N) ? Math.log(si[i + h] / si[i]) : null);
const oosIdx = dates.findIndex(d => d >= OOS_START);

// non-overlapping evaluation averaged over phase offsets; baselines measured on the SAME windows
function evalSignal(k, h, lo, hi) {
  const s = sigCache[k], f = fwd[h], m20 = sigCache.momo20;
  let sumHit = 0, sumN = 0, sumRet = 0, sumM = 0, sumU = 0, sumCov = 0, sumTot = 0;
  for (let ph = 0; ph < h; ph++) {
    let hit = 0, n = 0, ret = 0, mh = 0, uh = 0, tot = 0;
    for (let i = lo + ph; i < hi; i += h) {
      if (f[i] == null || s[i] == null) continue;
      tot++;
      if (s[i] === 0) continue;
      n++; const y = sgn(f[i]);
      if (y === s[i]) hit++;
      ret += s[i] * f[i];
      if (m20[i] != null && m20[i] !== 0 && m20[i] === y) mh++;
      if (y === 1) uh++;
    }
    sumHit += n ? hit / n : 0; sumN += n; sumRet += n ? ret / n : 0; sumM += n ? mh / n : 0; sumU += n ? uh / n : 0; sumCov += tot ? n / tot : 0; sumTot += tot;
  }
  let oh = 0, on = 0; for (let i = lo; i < hi; i++) { if (f[i] == null || s[i] == null || s[i] === 0) continue; on++; if (sgn(f[i]) === s[i]) oh++; }
  return { hit: sumHit / h * 100, n: sumN / h, retBp: sumRet / h * 1e4, momoSame: sumM / h * 100, upSame: sumU / h * 100, coverage: sumCov / h * 100, overlapHit: on ? oh / on * 100 : null, overlapN: on };
}

const out = { studyVersion: STUDY_VERSION, ranAt: new Date().toISOString(), oosStart: OOS_START, days: N, from: dates[0], to: dates[N - 1], isDays: oosIdx, oosDays: N - oosIdx, results: {}, candidates: [] };
console.log('PREDICTOR STUDY ' + STUDY_VERSION + ' · ' + N + ' aligned sessions ' + dates[0] + ' → ' + dates[N - 1] + ' · IS ' + oosIdx + ' days · OOS ' + (N - oosIdx) + ' days (from ' + OOS_START + ')');
console.log('base rate (share of forward windows up): ' + H.map(h => { let u = 0, n = 0; for (let i = oosIdx; i < N; i++) if (fwd[h][i] != null) { n++; if (fwd[h][i] > 0) u++; } return 't+' + h + ' OOS ' + Math.round(u / n * 100) + '%'; }).join(' · '));
console.log('');
console.log('signal'.padEnd(14) + 'h'.padStart(4) + '  IS hit   N  ' + '  OOS hit   N   cov%  ret(bp)  momo20*  alwaysUp*  overlapHit(N)  verdict');
for (const k of Object.keys(SIGNALS)) {
  out.results[k] = {};
  let passes = 0;
  for (const h of H) {
    const is = evalSignal(k, h, WARMUP, oosIdx), oos = evalSignal(k, h, oosIdx, N);
    const pass = oos.n >= MIN_N[h] && oos.hit >= 55 && is.hit >= 52 && oos.hit >= oos.momoSame + 5 && oos.hit >= oos.upSame + 5;
    if (pass) passes++;
    out.results[k]['h' + h] = { is, oos, pass };
    console.log(k.padEnd(14) + String(h).padStart(4) + '  ' + is.hit.toFixed(0).padStart(4) + '%' + String(Math.round(is.n)).padStart(5) + '  ' +
      '  ' + oos.hit.toFixed(0).padStart(4) + '%' + String(Math.round(oos.n)).padStart(5) + '  ' + oos.coverage.toFixed(0).padStart(4) + '  ' + oos.retBp.toFixed(0).padStart(7) +
      '  ' + oos.momoSame.toFixed(0).padStart(5) + '%   ' + oos.upSame.toFixed(0).padStart(5) + '%     ' + (oos.overlapHit != null ? oos.overlapHit.toFixed(0) + '% (' + oos.overlapN + ')' : '—').padEnd(12) + (pass ? '  PASS' : '  fail'));
  }
  if (passes >= 2 && k !== 'momo20' && k !== 'alwaysUp') out.candidates.push(k);
}
console.log('\n* baseline hit rates measured on the SAME signaled windows as the row\'s signal');
console.log('CANDIDATES (pass at >=2 horizons): ' + (out.candidates.length ? out.candidates.join(', ') : 'NONE — no single mechanical signal beat both baselines out of sample under the pre-committed bar'));
fs.writeFileSync(path.join(DATA_DIR, 'study-predictors.json'), JSON.stringify(out, null, 1));
