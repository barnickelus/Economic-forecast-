#!/usr/bin/env node
/**
 * PRE-REGISTERED PREDICTOR STUDY v2 — written in full BEFORE its first run
 * (2026-09-26). study-v1 (scripts/study-predictors.js) stays frozen.
 *
 * WHY A v2: (1) study-v1's aligned history started 2022-08-09 only because
 * fetch-data truncated DX-Y.NYB (fixed 2026-09-26); every series now reaches
 * back to ~2021-09, adding ~10 months of IN-SAMPLE history. OOS is unchanged.
 * (2) v1's only survivor — oil LEVEL in its 120-session range, t+5 only — is
 * the basis of the v15 shadow challenger. A single-horizon pass at one window
 * length is exactly what a lucky parameter looks like. v2 is a ROBUSTNESS test
 * of that rule, plus a few new a-priori hypotheses.
 *
 * DISCLOSURE: the new hypotheses below were chosen AFTER seeing v1's results
 * (v1 showed change-signals failing and a level-signal surviving). They are
 * reasonable a priori, but they are not blind. The pass bar is unchanged, so
 * nothing here can be tuned toward a result.
 *
 * DATA, TARGET, SPLIT, EVALUATION: identical to study-v1 (see that header):
 * committed closes of SI=F, GC=F, CL=F, HG=F, ^TNX, DX-Y.NYB aligned on common
 * dates, weekend bars removed; target = sign of silver's forward log return at
 * h in {5,10,20}; IN-SAMPLE dates < 2025-01-01, OOS >= 2025-01-01;
 * non-overlapping windows averaged over all h phase offsets; baselines
 * (momentum 20d, always-bullish) measured on the SAME signaled windows.
 * WARMUP is 60 sessions; signals needing longer history return null (no
 * window) until they have it.
 *
 * SIGNALS: all 16 from v1 (replication on the longer in-sample), plus:
 *   oilLvl60     oil pctile in trailing 60d:  <=30 -> +1, >=70 -> -1, else 0
 *   oilLvl250    oil pctile in trailing 250d: same thresholds
 *                (60/120/250 = the same rule at three window lengths)
 *   ratioLvl250  gold/silver ratio pctile in trailing 250d: >=70 -> +1 (silver
 *                cheap vs gold), <=30 -> -1 (silver rich), else 0
 *   gold5        +sign(GC 5d change)   (gold leads silver)
 *   momoLowVol   momentum 20d only when silver's 20d realized vol is below its
 *                trailing 250d median, else 0
 *
 * PASS BAR (unchanged from v1): at a given horizon, OOS hit >= 55% with
 * N >= 30/20/15 (h=5/10/20) signaled windows, IS hit >= 52% with the same sign,
 * and OOS beats BOTH momentum-20d and always-bullish on the same windows by
 * >= 5pp. CANDIDATE = pass at >= 2 of 3 horizons.
 *
 * PRE-COMMITTED v15 VERDICT (printed by this script):
 *   ROBUST    oilLvl120 passes at t+5 again (with the longer in-sample) AND at
 *             least one of oilLvl60 / oilLvl250 also passes at t+5.
 *   FRAGILE   otherwise. Consequence: recorded in CLAUDE.md as "v15's basis
 *             did not replicate". v15 keeps shadow-logging — it is retired only
 *             by its own live promotion rule, never by a backtest.
 *
 * OUTPUT: table to stdout; data/study-predictors-v2.json for the dashboard.
 */
const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const STUDY_VERSION = 'study-v2';
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
  // ---- v2 additions ----
  oilLvl60: i => lvl(cl, i, 60, false),
  oilLvl250: i => lvl(cl, i, 250, false),
  ratioLvl250: i => { if (i < 250) return null; const w = []; for (let k = i - 249; k <= i; k++) w.push(gc[k] / si[k]); const cur = w[w.length - 1]; const r = w.filter(x => x < cur).length / w.length; return r >= 0.70 ? 1 : r <= 0.30 ? -1 : 0; },
  gold5: i => sgn(chg(gc, i, 5)),
  momoLowVol: i => { if (i < 270) return null; const v = k => { const r = []; for (let j = k - 19; j <= k; j++) r.push(Math.log(si[j] / si[j - 1])); const m = r.reduce((a, b) => a + b, 0) / r.length; return Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / r.length); }; const now = v(i); const hist = []; for (let k = i - 249; k <= i; k++) hist.push(v(k)); hist.sort((a, b) => a - b); return now < hist[Math.floor(hist.length / 2)] ? sgn(chg(si, i, 20)) : 0; },
};
// level-in-range rule: pctile of today's value among the trailing n closes (strictly below)
function lvl(a, i, n) { if (i < n - 1) return null; const w = a.slice(i - n + 1, i + 1); const r = w.filter(x => x < a[i]).length / w.length; return r <= 0.30 ? 1 : r >= 0.70 ? -1 : 0; }
const WARMUP = 60;
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
// PRE-COMMITTED v15 VERDICT
{
  const p = (k, h) => !!(out.results[k] && out.results[k]['h' + h] && out.results[k]['h' + h].pass);
  const robust = p('oilLvl120', 5) && (p('oilLvl60', 5) || p('oilLvl250', 5));
  out.v15Verdict = robust ? 'ROBUST' : 'FRAGILE';
  console.log('v15 BASIS (pre-committed rule): ' + out.v15Verdict + ' — oilLvl120 t+5 ' + (p('oilLvl120', 5) ? 'PASS' : 'fail') + ' · oilLvl60 t+5 ' + (p('oilLvl60', 5) ? 'PASS' : 'fail') + ' · oilLvl250 t+5 ' + (p('oilLvl250', 5) ? 'PASS' : 'fail'));
}
fs.writeFileSync(path.join(DATA_DIR, 'study-predictors-v2.json'), JSON.stringify(out, null, 1));
