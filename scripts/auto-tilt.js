#!/usr/bin/env node
/**
 * DAILY AUTO-LOGGER — removes the human from the forward log.
 *
 * Why this exists: entries used to be logged only when Chris opened the page,
 * leaving 12- and 38-day gaps. The engine held opinions on those days that were
 * never scored, so the record measured "engine on days Chris chose to log,"
 * not the engine. Self-selection is the one sample defect no scoring rule can
 * repair. This runs the SAME engine (scripts/engine.js — shared with the
 * dashboard, not a copy) once per committed trading day and logs whatever it
 * says, INCLUDING abstains/balanced verdicts.
 *
 * RECORDER v2 (rule pre-committed 2026-09-25, in CLAUDE.md, before the first
 * entry under it). The v1 recorder tried to log trade date D on the evening of
 * D, from whatever bar Yahoo's daily series showed at run time. GitHub ran the
 * 21:10 UTC cron 2-3 hours late, after the 22:00 UTC Globex reopen, and in
 * that window Yahoo's bar dated D is actually the NEWLY OPENED next session
 * (both silver and oil), rewritten to the true D bar only hours later. 20 of
 * the 26 v1 entries recorded the next session's opening-hour price as D's
 * close and fed the engine a phantom oil change (once a -6.3% "crash" on a
 * -1.2% day). Timing cannot be controlled on shared cron, so v2 removes the
 * dependence on it:
 *
 *   The verdict for trade date D is a DETERMINISTIC FUNCTION OF INPUTS DATED
 *   <= D, computed on the first run AFTER D's bar is final:
 *     - D is final when the committed series holds a bar dated LATER than D
 *       (the mis-dated evening bar carries D's own date, so it never qualifies).
 *     - spot / oil / gold / ratio / discriminator: committed closes <= D only.
 *     - contracts: the odds logger's rows dated D (data/catalyst-log.json —
 *       the evening run's rows when the run landed before midnight UTC, else
 *       the morning run's pre-close rows), with day-over-day delta vs the
 *       latest rows dated < D. Days-to-expiry measured from D.
 *     - Kalshi drift and physical state: rows dated <= D only.
 *   No input postdates D's close by more than the odds logger's own lag
 *   (<= ~3h post-close, the same exposure v1 accepted). Because the function
 *   is deterministic in dated inputs, computing it a day (or three) late is
 *   NOT backfilling — the only unrecoverable gap is a day with no odds rows.
 *   Entries carry recorder:'v2', oddsAt (when the odds were read) and
 *   recordedAt (when this ran), plus the oil inputs the engine saw.
 *
 * Still refuses to log when the contract channel is blind (zero rows for D):
 * an oil-only "verdict" would be a different forecaster wearing the same name.
 */

const fs = require('fs');
const path = require('path');
const Engine = require('./engine.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TILT_FILE = path.join(DATA_DIR, 'tilt-log.json');
const SHADOW_FILE = path.join(DATA_DIR, 'shadow-v14.json');
const CATALYST_FILE = path.join(DATA_DIR, 'catalyst-log.json');
const TERMS = ['iran', 'hormuz', 'fed rate', 'israel', 'ukraine', 'russia'];
const RECORDER = 'v2';
// First trade date eligible under the v2 rule = the first weekday with odds rows.
// Because a v2 verdict depends only on inputs dated <= D, recomputing the
// odds-log era is reproduction, not backfill (pre-committed in CLAUDE.md). A
// v1 auto row for the same date is kept but marked superseded (treated as a
// same-day dup by the scorer: scored for reference, excluded from aggregates).
const RECORDER_V2_START = '2026-07-20';
const MAX_PER_RUN = +(process.env.AUTO_TILT_MAX_PER_RUN || 5); // bounded catch-up after an outage

function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
const isWeekendBar = d => { const w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 || w === 6; };
const ohlcAll = t => ((loadJSON(path.join(DATA_DIR, t + '.json'), {}).historical || {}).ohlc || [])
  .filter(b => b && b.c != null && !isWeekendBar(b.date)).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
// every price read is AS OF D: nothing after D's close can leak in
const ohlcAsOf = (t, D) => ohlcAll(t).filter(b => b.date <= D);

// ---- contract population for trade date D, from the odds logger's dated rows ----
function contractsAsOf(crows, D) {
  const rowsD = crows.filter(r => r.date === D && r.title);
  if (!rowsD.length) return { contracts: [], oddsAt: null };
  // latest row per title strictly before D, for the day-over-day delta
  const prior = {};
  for (const r of crows) if (r.date < D && r.title && (!prior[r.title] || r.date > prior[r.title].date)) prior[r.title] = r;
  const dayMs = 86400000, Dms = Date.parse(D + 'T21:00:00Z');
  const raw = [];
  for (const r of rowsD) {
    const title = r.title, tl = title.toLowerCase();
    // same keyword filter the dashboard's live population uses
    const theme = TERMS.find(t => t.toLowerCase().split(/\s+/).filter(x => x.length > 2).every(x => tl.includes(x)));
    if (!theme) continue;
    const p = prior[title];
    const delta = (p && p.yes != null && r.yes != null) ? +(r.yes - p.yes).toFixed(2) : null;
    let dte = null;
    if (r.endDate) dte = Math.round((Date.parse(r.endDate) - Dms) / dayMs);
    if (dte == null) { const td = Engine.parseTitleDate(title); if (td) dte = Math.round((td - Dms) / dayMs); }
    raw.push({ title, yes: r.yes, vol: r.vol24 || 0, delta, theme, dte });
  }
  const seen = new Set();
  const contracts = raw
    .filter(r => { if (seen.has(r.title)) return false; seen.add(r.title); return true; })
    .map(r => { const pinned = r.yes != null && (r.yes <= 1 || r.yes >= 99); const past = r.dte != null && r.dte < 0; r.resolved = pinned || past; return r; })
    .filter(r => !r.resolved)
    .sort((a, b) => (b.vol || 0) - (a.vol || 0))
    .slice(0, 20);
  const oddsAt = rowsD.map(r => r.fetchedAt || '').sort().pop() || null;
  return { contracts, oddsAt };
}

// ---- contradiction ledger, server-side, AS OF D (mirrors the dashboard's thresholds) ----
function ratio20dChangePct(D) {
  const si = ohlcAsOf('SI_F', D), gc = ohlcAsOf('GC_F', D);
  if (!si.length || !gc.length) return null;
  const g = {}; gc.forEach(b => g[b.date] = b.c);
  const r = si.filter(b => g[b.date] != null).map(b => g[b.date] / b.c);
  return r.length < 21 ? null : (r[r.length - 1] / r[r.length - 21] - 1) * 100;
}
function discriminatorRegime(D) {
  const last11 = t => { const o = ohlcAsOf(t, D); return o.length >= 11 ? o.slice(-11) : null; };
  const oil = last11('CL_F'), cop = last11('HG_F'), tnx = last11('_TNX');
  if (!oil || !cop || !tnx) return null;
  const pct = s => ((s[s.length - 1].c - s[0].c) / s[0].c) * 100;
  const sgn = (v, f) => v > f ? 1 : v < -f ? -1 : 0;
  const so = sgn(pct(oil), 1.5), sc = sgn(pct(cop), 1.5), sy = sgn(tnx[tnx.length - 1].c - tnx[0].c, 0.08);
  if (so < 0 && sc < 0 && sy < 0) return 'DEMAND DESTRUCTION';
  if (so < 0 && sc >= 0 && sy >= 0) return 'SUPPLY RELIEF';
  if (so > 0 && sc > 0) return 'DEMAND / REFLATION';
  if (so > 0 && sc < 0) return 'SUPPLY SHOCK';
  return 'MIXED / NO READ';
}
// A curve leg whose price equals the front IS the front (the front-month rolled
// into it): its "lease" is the whole bill rate. Ignore such legs — the Aug-27
// roll manufactured a month of fake STRESS this way.
const realLegs = row => (row.curve || []).filter(c => c.impliedLeasePct != null && c.spreadPct != null && Math.abs(c.spreadPct) >= 0.05);
function physicalState(D) {
  const p = (loadJSON(path.join(DATA_DIR, 'physical-log.json'), []) || []).filter(r => r && r.date <= D);
  if (!p.length) return null;
  const last = p[p.length - 1];
  const leases = realLegs(last).map(c => c.impliedLeasePct);
  const maxLease = leases.length ? Math.max(...leases) : null;
  // The 10-day spike test is only meaningful when the SAME deferred legs exist
  // on both dates and neither row spans a front-month roll: a roll changes the
  // front the spread is measured against, jumping every leg's lease by ~1-2pp
  // with no physical event (2026-08-27: March lease -0.2% -> +1.7% overnight).
  let d10 = null;
  if (maxLease != null && p.length >= 11) {
    const prevRow = p[p.length - 11], prevLegs = realLegs(prevRow);
    const same = prevLegs.length && prevLegs.map(c => c.sym).sort().join() === realLegs(last).map(c => c.sym).sort().join();
    const rolled = [last, prevRow].some(r => (r.curve || []).some(c => c.spreadPct != null && Math.abs(c.spreadPct) < 0.05));
    if (same && !rolled) d10 = maxLease - Math.max(...prevLegs.map(c => c.impliedLeasePct));
  }
  return {
    stress: maxLease != null && (maxLease > 2.0 || (d10 != null && d10 >= 1.0)),
    backwardated: (last.curve || []).some(c => c.spreadPct != null && c.spreadPct < -0.05),
  };
}
function kalshiHawkDrift5(D) {
  const k = loadJSON(path.join(DATA_DIR, 'kalshi-log.json'), []);
  const dec = (Array.isArray(k) ? k : []).filter(r => r.series === 'KXFEDDECISION' && r.yes != null && r.closeTime && r.date <= D);
  if (!dec.length) return null;
  const days = [...new Set(dec.map(r => r.date))].sort();
  if (days.length < 2) return null;
  const lastDay = days[days.length - 1], refDay = days[Math.max(0, days.length - 6)];
  const meeting = dec.filter(r => r.date === lastDay && r.closeTime > D).map(r => r.closeTime).sort()[0];
  if (!meeting) return null;
  const hmc = day => {
    const rows = dec.filter(r => r.date === day && r.closeTime === meeting);
    if (!rows.length) return null;
    let hawk = 0, cut = 0;
    rows.forEach(r => { if (/Hike rates by (>?25)/.test(r.title)) hawk += r.yes; else if (/Cut rates by/.test(r.title)) cut += r.yes; });
    return hawk - cut;
  };
  const a = hmc(refDay), b = hmc(lastDay);
  return (a == null || b == null) ? null : +(b - a).toFixed(1);
}
function computeFlags(v, D) {
  const flags = [];
  const directional = v.tilt === 'bullish' || v.tilt === 'bearish';
  if (discriminatorRegime(D) === 'DEMAND DESTRUCTION' && v.oilTilt != null && v.oilTilt > 0.25) flags.push('oil-premise');
  if (directional) {
    const rc = ratio20dChangePct(D);
    if (rc != null && ((v.tilt === 'bullish' && rc > 2) || (v.tilt === 'bearish' && rc < -2))) flags.push('ratio-confirmer');
  }
  if (v.dealCurve && v.dealCurve.length >= 2) {
    for (let i = 0; i < v.dealCurve.length - 1; i++) {
      if (v.dealCurve[i].yes > v.dealCurve[i + 1].yes + 3) { flags.push('curve-incoherent'); break; }
    }
  }
  if (v.tilt === 'bullish') { const dr = kalshiHawkDrift5(D); if (dr != null && dr >= 5) flags.push('kalshi-conflict'); }
  const ph = physicalState(D);
  if (v.tilt === 'bearish' && ph && (ph.stress || ph.backwardated)) flags.push('physical-stress');
  return flags;
}

const blank = () => ({ p5: null, pct5: null, hit5: null, p10: null, pct10: null, hit10: null, p20: null, pct20: null, hit20: null });

(function main() {
  const si = ohlcAll('SI_F');
  if (si.length < 25) { console.log('SI_F history too short — nothing to do'); return; }
  const log = loadJSON(TILT_FILE, []);
  if (!Array.isArray(log)) { console.log('tilt-log.json unreadable — refusing to write'); process.exit(1); }
  let shadow = loadJSON(SHADOW_FILE, []);
  if (!Array.isArray(shadow)) shadow = [];
  const crows = loadJSON(CATALYST_FILE, []);
  if (!Array.isArray(crows) || !crows.length) { console.log('catalyst-log.json missing/empty — contract channel blind, nothing logged'); return; }

  const autoDates = new Set(log.filter(r => r.source === 'auto' && r.recorder === RECORDER).map(r => String(r.t).slice(0, 10)));
  const oddsDates = new Set(crows.map(r => r.date));
  const lastDate = si[si.length - 1].date;
  // candidates: final bars (a later bar exists), on/after the v2 start, not yet logged
  const pending = si.filter(b => b.date < lastDate && b.date >= RECORDER_V2_START && !autoDates.has(b.date));
  if (!pending.length) { console.log('· no unlogged final bars (latest committed bar ' + lastDate + ' is not final until a later bar exists)'); return; }
  const noOdds = pending.filter(b => !oddsDates.has(b.date)).map(b => b.date);
  if (noOdds.length) console.log('· no odds rows dated ' + noOdds.join(', ') + ' — honest gap(s), cannot be reconstructed');
  const todo = pending.filter(b => oddsDates.has(b.date)).slice(0, MAX_PER_RUN);
  if (!todo.length) return;

  let wrote = 0;
  for (const bar of todo) {
    const D = bar.date;
    const siD = ohlcAsOf('SI_F', D), cl = ohlcAsOf('CL_F', D), gc = ohlcAsOf('GC_F', D);
    if (siD[siD.length - 1].date !== D) { console.log('· ' + D + ': silver series inconsistent — skipping'); continue; }
    const oilSp = cl.length ? cl[cl.length - 1].c : null;
    const oilChg = cl.length >= 2 && cl[cl.length - 1].date === D ? ((cl[cl.length - 1].c - cl[cl.length - 2].c) / cl[cl.length - 2].c) * 100 : null;
    const oilChg5 = cl.length >= 6 && cl[cl.length - 1].date === D ? ((cl[cl.length - 1].c - cl[cl.length - 6].c) / cl[cl.length - 6].c) * 100 : null;
    const goldSp = gc.length ? gc[gc.length - 1].c : null;
    const chg = siD.length >= 2 ? ((bar.c - siD[siD.length - 2].c) / siD[siD.length - 2].c) * 100 : 0;
    const { contracts, oddsAt } = contractsAsOf(crows, D);
    if (!contracts.length) { console.log('⚠ ' + D + ': odds rows exist but none match the engine terms — contract channel blind, refusing to log'); continue; }

    const d = { spot: bar.c, chg, oilChg, oilChg5, oilSp, goldSp, contracts };
    const v = Engine.reason(d);
    const flags = computeFlags(v, D);
    // CHALLENGER SHADOW: same bar, same inputs, v14 spec (see engine.js). Own file so
    // the champion's record stays untouched; scored identically by score-tilt.
    // Contracts are shared state — deep-copy so the champion's mutations can't leak.
    const v14 = Engine.reason(JSON.parse(JSON.stringify(d)), 'v14');
    const now = new Date().toISOString();
    const inputs = {
      oilChg: oilChg != null ? +oilChg.toFixed(2) : null, oilChg5: oilChg5 != null ? +oilChg5.toFixed(2) : null,
      chg: +chg.toFixed(2), regimeLevel: v.regimeLevel != null ? +v.regimeLevel.toFixed(1) : null,
    };
    log.push({
      t: D + ' 21:00',                 // anchored to the committed close, not wall-clock
      recorder: RECORDER, oddsAt, recordedAt: now,
      inputsAt: oddsAt || now,         // kept for older consumers: when the odds were read
      spot: +bar.c.toFixed(3),
      tilt: v.tilt, confidence: v.confidence,
      headline: (v.headline || '').slice(0, 140),
      flags, inputs,
      source: 'auto', contractsSeen: contracts.length,
      ...blank(),
    });
    autoDates.add(D);
    // a v1 row for the same date stays in the log (nothing is deleted) but no
    // longer counts: its spot/oil inputs came from the mis-dated evening bar
    for (const r of log) if (r.source === 'auto' && r.recorder !== RECORDER && String(r.t).slice(0, 10) === D && !r.superseded) {
      r.superseded = true; r.supersededBy = RECORDER;
      r.inputNote = (r.inputNote ? r.inputNote + ' · ' : '') + 'v1 evening-run recorder: spot/oil read from the mis-dated post-22:00 UTC bar — superseded by recorder v2 (same date, as-of inputs)';
    }
    for (const r of shadow) if (r.recorder !== RECORDER && String(r.t).slice(0, 10) === D && !r.superseded) { r.superseded = true; r.supersededBy = RECORDER; }
    if (!shadow.some(r => String(r.t).slice(0, 10) === D && r.recorder === RECORDER)) {
      shadow.push({
        t: D + ' 21:00', recorder: RECORDER, oddsAt, recordedAt: now, inputsAt: oddsAt || now,
        spot: +bar.c.toFixed(3), tilt: v14.tilt, confidence: v14.confidence,
        headline: (v14.headline || '').slice(0, 140), source: 'auto-v14', inputs, ...blank(),
      });
    }
    wrote++;
    console.log('✓ AUTO-LOGGED ' + D + ': ' + v.tilt.toUpperCase() + ' @ ' + v.confidence + '%' +
      (flags.length ? ' · flags: ' + flags.join(',') : ' · no flags') + ' · spot $' + bar.c.toFixed(2) +
      ' · oil 1d ' + (oilChg != null ? oilChg.toFixed(2) + '%' : 'n/a') + ' · ' + contracts.length + ' contracts (odds read ' + (oddsAt || '?').slice(0, 16) + 'Z)' +
      ' · v14 ' + v14.tilt.toUpperCase() + ' @ ' + v14.confidence + '%' + (v14.tilt !== v.tilt ? ' (DIVERGES)' : ''));
  }
  if (!wrote) return;
  log.sort((a, b) => a.t < b.t ? -1 : 1);
  shadow.sort((a, b) => a.t < b.t ? -1 : 1);
  fs.writeFileSync(TILT_FILE, JSON.stringify(log, null, 1));
  fs.writeFileSync(SHADOW_FILE, JSON.stringify(shadow, null, 1));

  // report coverage honestly — gaps are the defect this script exists to close
  const autos = log.filter(r => r.source === 'auto').map(r => String(r.t).slice(0, 10)).sort();
  const v2 = log.filter(r => r.source === 'auto' && r.recorder === RECORDER).length;
  if (autos.length >= 2) {
    const firstIdx = si.findIndex(b => b.date === autos[0]);
    const sessions = firstIdx >= 0 ? si.length - firstIdx : null;
    if (sessions) console.log('  coverage: ' + autos.length + ' auto entries across ' + sessions + ' sessions (' + Math.round(autos.length / sessions * 100) + '%) · ' + v2 + ' under recorder v2');
  }
})();
