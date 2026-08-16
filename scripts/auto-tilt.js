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
 * Anchoring rules that keep the record honest:
 *  - One entry per COMMITTED trading bar, dated to that bar, priced at that
 *    bar's CLOSE. Fully reproducible; never a live intraday quote.
 *  - NEVER backfills. Computing a verdict for a past date using today's
 *    contract odds would be look-ahead contamination. A missed day stays
 *    missed and is reported as such.
 *  - source:'auto' distinguishes these from source:'issue' (manual) entries so
 *    the two populations can be compared later.
 */

const fs = require('fs');
const path = require('path');
const Engine = require('./engine.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TILT_FILE = path.join(DATA_DIR, 'tilt-log.json');
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; Kelly-Auto-Tilt/1.0; +https://github.com/)';
const TERMS = ['iran', 'hormuz', 'fed rate', 'israel', 'ukraine', 'russia'];

function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } }
function ohlcOf(t) { return ((loadJSON(path.join(DATA_DIR, t + '.json'), {}).historical || {}).ohlc || []); }

async function fetchJSON(url) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) { clearTimeout(tid); throw e; }
}

// Same contract population the dashboard builds, fetched server-side.
async function gatherContracts() {
  const raw = [];
  for (const t of TERMS) {
    let got = [];
    try {
      const j = await fetchJSON('https://gamma-api.polymarket.com/public-search?q=' + encodeURIComponent(t) + '&limit_per_type=10&events_status=active');
      (j.events || []).forEach(e => (e.markets || []).forEach(m => got.push(m)));
      (j.markets || []).forEach(m => got.push(m));
    } catch (e) { console.log('✗ search "' + t + '": ' + e.message); }
    for (const m of got) {
      let yes = null;
      try {
        const op = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        if (op && op.length) yes = parseFloat(op[0]) * 100;
      } catch (e) {}
      const title = m.question || m.title || t;
      const words = t.toLowerCase().split(/\s+/).filter(x => x.length > 2);
      if (!words.every(x => title.toLowerCase().includes(x))) continue;
      raw.push({
        title, yes,
        vol: m.volume24hr || m.volume || 0,
        delta: m.oneDayPriceChange != null ? parseFloat(m.oneDayPriceChange) * 100 : null,
        theme: t,
      });
    }
  }
  const seen = new Set();
  return raw
    .filter(r => { if (seen.has(r.title)) return false; seen.add(r.title); return true; })
    .map(r => {
      r.dte = Engine.daysToExpiry(r.title);
      const pinned = r.yes != null && (r.yes <= 1 || r.yes >= 99);
      const past = r.dte != null && r.dte < 0;
      r.resolved = pinned || past;
      return r;
    })
    .filter(r => !r.resolved)
    .sort((a, b) => (b.vol || 0) - (a.vol || 0))
    .slice(0, 20);
}

// ---- contradiction ledger, server-side (mirrors the dashboard's thresholds) ----
function ratio20dChangePct() {
  const si = ohlcOf('SI_F'), gc = ohlcOf('GC_F');
  if (!si.length || !gc.length) return null;
  const g = {}; gc.forEach(b => g[b.date] = b.c);
  const r = si.filter(b => g[b.date] != null).map(b => g[b.date] / b.c);
  return r.length < 21 ? null : (r[r.length - 1] / r[r.length - 21] - 1) * 100;
}
function discriminatorRegime() {
  const last11 = t => { const o = ohlcOf(t); return o.length >= 11 ? o.slice(-11) : null; };
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
function physicalState() {
  const p = loadJSON(path.join(DATA_DIR, 'physical-log.json'), []);
  if (!Array.isArray(p) || !p.length) return null;
  const last = p[p.length - 1];
  const leases = (last.curve || []).filter(c => c.impliedLeasePct != null).map(c => c.impliedLeasePct);
  const maxLease = leases.length ? Math.max(...leases) : null;
  let d10 = null;
  if (maxLease != null && p.length >= 11) {
    const prev = (p[p.length - 11].curve || []).filter(c => c.impliedLeasePct != null).map(c => c.impliedLeasePct);
    if (prev.length) d10 = maxLease - Math.max(...prev);
  }
  return {
    stress: maxLease != null && (maxLease > 2.0 || (d10 != null && d10 >= 1.0)),
    backwardated: (last.curve || []).some(c => c.spreadPct != null && c.spreadPct < 0),
  };
}
function kalshiHawkDrift5() {
  const k = loadJSON(path.join(DATA_DIR, 'kalshi-log.json'), []);
  const dec = (Array.isArray(k) ? k : []).filter(r => r.series === 'KXFEDDECISION' && r.yes != null && r.closeTime);
  if (!dec.length) return null;
  const days = [...new Set(dec.map(r => r.date))].sort();
  if (days.length < 2) return null;
  const lastDay = days[days.length - 1], refDay = days[Math.max(0, days.length - 6)];
  const meeting = dec.filter(r => r.date === lastDay).map(r => r.closeTime).sort()[0];
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
function computeFlags(v) {
  const flags = [];
  const directional = v.tilt === 'bullish' || v.tilt === 'bearish';
  if (discriminatorRegime() === 'DEMAND DESTRUCTION' && v.oilTilt != null && v.oilTilt > 0.25) flags.push('oil-premise');
  if (directional) {
    const rc = ratio20dChangePct();
    if (rc != null && ((v.tilt === 'bullish' && rc > 2) || (v.tilt === 'bearish' && rc < -2))) flags.push('ratio-confirmer');
  }
  if (v.dealCurve && v.dealCurve.length >= 2) {
    for (let i = 0; i < v.dealCurve.length - 1; i++) {
      if (v.dealCurve[i].yes > v.dealCurve[i + 1].yes + 3) { flags.push('curve-incoherent'); break; }
    }
  }
  if (v.tilt === 'bullish') { const dr = kalshiHawkDrift5(); if (dr != null && dr >= 5) flags.push('kalshi-conflict'); }
  const ph = physicalState();
  if (v.tilt === 'bearish' && ph && (ph.stress || ph.backwardated)) flags.push('physical-stress');
  return flags;
}

(async function main() {
  const si = ohlcOf('SI_F');
  if (si.length < 25) { console.log('SI_F history too short — nothing to do'); return; }
  const bar = si[si.length - 1];
  const log = loadJSON(TILT_FILE, []);
  if (!Array.isArray(log)) { console.log('tilt-log.json unreadable — refusing to write'); process.exit(1); }

  // RECORDING-FAIRNESS GATE (added after auditing the first 9 auto entries,
  // which were all logged MID-SESSION with spots up to 2.7% away from the
  // final close — a directional bias in volatile tape):
  //  - A bar dated today is only loggable AFTER 21:00 UTC: settlement (18:25)
  //    is done, so the recorded spot is near-final, and the odds inputs still
  //    PRECEDE the final electronic close — no look-ahead in either direction.
  //    The morning run sees today's bar mid-session and must refuse it.
  //  - A bar older than today is refused outright. Logging yesterday's close
  //    with this morning's odds hands the verdict 16h of post-close
  //    information (look-ahead); logging Friday on Monday hands it 60h. If
  //    the evening run fails, that day is an honest gap, not a reconstruction.
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  if (bar.date === todayUTC && now.getUTCHours() < 21) {
    console.log('· bar ' + bar.date + ' is mid-session — only the post-settlement (>=21:00 UTC) run logs; skipping');
    return;
  }
  if (bar.date < todayUTC) {
    console.log('· latest bar ' + bar.date + ' predates today — logging it now would use post-close odds (look-ahead); skipping');
    return;
  }

  if (log.some(r => String(r.t).slice(0, 10) === bar.date && r.source === 'auto')) {
    console.log('· auto entry for ' + bar.date + ' already logged — nothing to do');
    return;
  }

  // oil/gold context from committed closes (same series the dashboard uses live)
  const cl = ohlcOf('CL_F'), gc = ohlcOf('GC_F');
  const oilSp = cl.length ? cl[cl.length - 1].c : null;
  const oilChg = cl.length >= 2 ? ((cl[cl.length - 1].c - cl[cl.length - 2].c) / cl[cl.length - 2].c) * 100 : null;
  const goldSp = gc.length ? gc[gc.length - 1].c : null;
  const chg = si.length >= 2 ? ((bar.c - si[si.length - 2].c) / si[si.length - 2].c) * 100 : 0;

  const contracts = await gatherContracts();
  console.log('✓ contracts: ' + contracts.length + ' live');

  // REFUSE to log a degraded verdict. Zero contracts across all six search
  // terms means the Polymarket fetch failed, not that the world went quiet —
  // the engine's entire contract channel is blind, so its "verdict" would be
  // oil-only. A missing day is a gap; a wrong day is corruption of the record.
  if (!contracts.length) {
    console.log('⚠ ZERO contracts fetched — contract channel blind, refusing to log a degraded verdict for ' + bar.date);
    return;
  }

  const v = Engine.reason({ spot: bar.c, chg, oilChg, oilSp, goldSp, contracts });
  const flags = computeFlags(v);

  log.push({
    t: bar.date + ' 21:00',            // anchored to the committed close, not wall-clock
    inputsAt: new Date().toISOString(), // provenance: when odds/spot were read
    spot: +bar.c.toFixed(3),
    tilt: v.tilt,
    confidence: v.confidence,
    headline: (v.headline || '').slice(0, 140),
    flags,
    source: 'auto',
    contractsSeen: contracts.length,
    p5: null, pct5: null, hit5: null,
    p10: null, pct10: null, hit10: null,
    p20: null, pct20: null, hit20: null,
  });
  log.sort((a, b) => a.t < b.t ? -1 : 1);
  fs.writeFileSync(TILT_FILE, JSON.stringify(log, null, 1));

  console.log('✓ AUTO-LOGGED ' + bar.date + ': ' + v.tilt.toUpperCase() + ' @ ' + v.confidence + '%' +
    (flags.length ? ' · flags: ' + flags.join(',') : ' · no flags') + ' · spot $' + bar.c.toFixed(2));

  // report coverage honestly — gaps are the defect this script exists to close
  const autos = log.filter(r => r.source === 'auto').map(r => String(r.t).slice(0, 10));
  if (autos.length >= 2) {
    const firstIdx = si.findIndex(b => b.date === autos[0]);
    const sessions = firstIdx >= 0 ? si.length - firstIdx : null;
    if (sessions) console.log('  coverage: ' + autos.length + ' auto entries across ' + sessions + ' sessions (' + Math.round(autos.length / sessions * 100) + '%)');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
