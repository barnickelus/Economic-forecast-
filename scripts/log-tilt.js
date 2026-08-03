#!/usr/bin/env node
/**
 * Tilt-verdict inbox — appends verdicts from a GitHub issue to data/tilt-log.json.
 *
 * The dashboard's "+ Log verdict" / "⬆ Commit log to repo" buttons open a
 * prefilled new-issue form; submitting it triggers log-tilt.yml, which runs
 * this script with the issue body in ISSUE_BODY. The body must contain a
 * fenced ```json block holding one entry object or an array of them:
 *   { "t": "2026-07-19 14:02", "spot": 55.94, "tilt": "bearish",
 *     "confidence": 52, "headline": "..." }
 *
 * Strictly validated; malformed entries are skipped with a log line, never
 * guessed at. Dedupe key is the timestamp t (one verdict per logged moment).
 */

const fs = require('fs');
const path = require('path');

const TILT_FILE = path.join(__dirname, '..', 'data', 'tilt-log.json');
const TILTS = new Set(['bullish', 'bearish', 'balanced']);

const body = process.env.ISSUE_BODY || '';
const m = body.match(/```json\s*([\s\S]*?)```/);
if (!m) { console.error('✗ no ```json block found in issue body'); process.exit(1); }

let parsed;
try { parsed = JSON.parse(m[1]); } catch (e) { console.error('✗ json block did not parse: ' + e.message); process.exit(1); }
const candidates = Array.isArray(parsed) ? parsed : [parsed];

let log = [];
try { log = JSON.parse(fs.readFileSync(TILT_FILE, 'utf8')); } catch (e) { log = []; }
if (!Array.isArray(log)) log = [];

const seen = new Set(log.map(r => r.t));
let added = 0, skipped = 0;
for (const c of candidates) {
  const t = typeof c.t === 'string' ? c.t.trim().slice(0, 16) : null;
  const spot = typeof c.spot === 'number' && isFinite(c.spot) && c.spot > 0 ? c.spot : null;
  const tilt = TILTS.has(c.tilt) ? c.tilt : null;
  const confidence = typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 100 ? c.confidence : null;
  if (!t || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(t) || spot == null || !tilt || confidence == null) {
    console.log('· skipped malformed entry: ' + JSON.stringify(c).slice(0, 120)); skipped++; continue;
  }
  if (seen.has(t)) { console.log('· duplicate t=' + t + ' — already logged'); skipped++; continue; }
  seen.add(t);
  // contradiction-ledger annotations: whitelist-validated, capped, optional.
  // They ride along for the retrospective flagged-vs-unflagged scoring test
  // and influence nothing at intake.
  let flags = [];
  if (Array.isArray(c.flags)) {
    flags = c.flags.filter(f => typeof f === 'string' && /^[a-z][a-z0-9-]{2,23}$/.test(f)).slice(0, 8);
  }
  log.push({
    t,
    spot,
    tilt,
    confidence,
    headline: typeof c.headline === 'string' ? c.headline.slice(0, 140) : '',
    flags,
    source: 'issue',
    p5: null, pct5: null, hit5: null,
    p10: null, pct10: null, hit10: null,
    p20: null, pct20: null, hit20: null,
  });
  added++;
}

log.sort((a, b) => a.t < b.t ? -1 : 1);
fs.writeFileSync(TILT_FILE, JSON.stringify(log, null, 1));
console.log('✓ tilt-log: +' + added + ' added, ' + skipped + ' skipped, ' + log.length + ' total');
if (!added && skipped) process.exit(1); // surface a fully-rejected issue as a failed run
