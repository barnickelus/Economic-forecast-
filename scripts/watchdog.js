#!/usr/bin/env node
/**
 * WATCHDOG — the system can now fail silently (a failed evening run is an
 * honest gap, but nobody reads Actions logs). This prints WATCHDOG_ALERT lines
 * that the workflow turns into a GitHub issue, so failures reach a phone.
 *
 * Checks:
 *  1. Auto-log gap: no auto entry for the last TWO completed weekdays.
 *  2. Stale prices: SI_F.json fetchedAt older than 26h (the 30-min cron died).
 * Always exits 0 — alerting must never break the pipeline it watches.
 */
const fs = require('fs'); const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f))); } catch (e) { return null; } };

const alerts = [];
// completed weekdays strictly before today (UTC)
const days = []; const d = new Date();
while (days.length < 2) {
  d.setUTCDate(d.getUTCDate() - 1);
  const w = d.getUTCDay();
  if (w !== 0 && w !== 6) days.push(d.toISOString().slice(0, 10));
}
const log = load('tilt-log.json') || [];
const autoDates = new Set(log.filter(r => r.source === 'auto').map(r => String(r.t).slice(0, 10)));
if (days.every(day => !autoDates.has(day)))
  alerts.push('no auto tilt entry for the last two completed weekdays (' + days.join(', ') + ') — evening runs failing or contract fetch blind');

const si = load('SI_F.json');
if (si && si.fetchedAt) {
  const age = (Date.now() - Date.parse(si.fetchedAt)) / 3600000;
  if (age > 26) alerts.push('SI_F.json is ' + age.toFixed(0) + 'h stale — the fetch-data cron has stopped committing');
} else alerts.push('SI_F.json missing or unreadable');

if (!alerts.length) console.log('watchdog: OK');
else for (const a of alerts) console.log('WATCHDOG_ALERT: ' + a);
