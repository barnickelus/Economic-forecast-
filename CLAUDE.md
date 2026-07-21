# Silver Market Intelligence Dashboard

Static dashboard on GitHub Pages (barnickelus.github.io/Economic-forecast-/).
Owner: Chris. iPad-only historically; now also works via Claude Code with repo access.
Purpose: structured, falsifiable read of silver's regime — NOT a price oracle.

## Prime directives (non-negotiable)
1. **Pre-commit every test.** Hypothesis, falsifier, and pass/fail threshold stated
   BEFORE looking at outcomes. No post-hoc rationalization.
2. **The forward log is sacred.** Every tilt/prediction gets logged and scored
   against committed daily closes at exact horizons (t+5/10/20). Never score from
   a live quote at page-load — that bug already corrupted the v13 log.
3. **No claimed edge without measured history.** Frame unproven modules as
   "hypothesis-generating instruments," on the page itself, in plain sight.
4. **Brutal honesty.** Chris catches flattery and motivated reasoning. Report
   failures plainly. A falsified hypothesis is a win, not an embarrassment.
5. Macro → meso → micro decomposition order. Never fit micro first.

## Measured track record (do not soften)
- Tilt engine forward log: 31% hit rate over 13 entries; later v13 log scored
  3/15 horizon-scores (20%), 0-for-5 at t+10. Two 70%-confidence bullish reads
  were placed within days of the May-2026 top (~$76); silver fell 25% to ~$56.
- The engine's only honest entry was a 28%-confidence abstain. Confidence has
  been anti-correlated with outcomes. The tilt engine has NO demonstrated edge.

## Falsified hypotheses — do NOT re-propose without new evidence
- **Russia/Ukraine haven channel for silver**: ~6% 2-week bid post-Feb-2022
  invasion, mean-reverted; later escalations produced no measurable response.
  Gold/silver ratio COMPRESSED around those events (industrial signature, not
  haven). Silver has essentially one geopolitical transmission: industrial/
  inflation-impulse, read via the ratio.
- **Fed/real-rate channel as general driver**: falsified outside the 2022 hiking
  regime. Rising yields preceded STRONGER forward silver in the broader sample.
  Regime-dependent, sign flips by timescale (tactically bearish via yield
  competition; strategically bullish as paper-trust erosion symptom).
- **Positioning/mean-reversion**: failed; silver shows mild momentum.
- **Oil-sign mapping (both versions)**: "oil down → silver up (relief/rates)"
  failed live in May-Jun 2026 — oil fell on DEMAND DESTRUCTION and silver fell
  25% with it. Sign of oil is not identifying without the CAUSE of the move.
  Open task: regime discriminator (e.g., oil+copper+yields co-movement to
  separate demand regime from supply-relief regime).
- **Prediction-market → silver edge**: UNPROVEN, not falsified. Link 1 (does the
  odds market lead the oil tape?) is untested because no historical odds series
  existed. The catalyst logger (below) is building that dataset now.

## Validated / kept
- Gold = pure monetary/distrust instrument; gold/silver ratio = industrial wave
  separator (confirmer, not predictor).
- Oil as ~20-day forward signal (re-specified after same-day corr ≈ 0).
- Macro anatomy plan: monthly data back to 1971 (fiat era); real rates as
  pre-committed master monetary variable; exclude Hunt Bros 1979-80 spike.
- $78.30 horizontal shelf (5 touches) — check if still structurally relevant
  post-decline before citing it.

## Architecture
- `index.html` — main dashboard (large, ~178KB). Reads committed data files
  same-origin; some legacy fetches still use public CORS proxies (flaky —
  migrate to `data/` reads where possible).
- `catalyst.html` — Polymarket catalyst monitor. Live odds + oil divergence
  flags. DIVERGE = odds moved >5pt/24h while |Brent| < 1%.
- `scripts/fetch-data.js` — price fetcher; Actions cron every 30 min commits
  `data/*.json` (SI=F, GC=F, macro tickers; 5y daily OHLC in
  `data/SI_F.json → historical.ohlc`).
- `scripts/fetch-odds.js` + `.github/workflows/fetch-odds.yml` — catalyst odds
  logger, 2x daily, appends `data/catalyst-log.json` (one row per contract per
  day: yes%, vol, liquidity, spread, 24h trade count, Brent/WTI). THIS FILE IS
  THE FUTURE BACKTEST DATASET. Also appends `data/kalshi-log.json` (Kalshi
  Fed/CPI markets — the Fed-channel series the tilt engine lacks; series
  tickers in `data/odds-topics.json → kalshiSeries`, unverified guesses warn
  in the Actions log). Topics editable in `data/odds-topics.json`.
- Scoring (index.html): forward log scores from committed `SI_F.json` OHLC at
  exact t+5/10/20 trading days (never live spot). Shows calibration (stated vs
  realized), Brier (0.25 = always-50% baseline), and a momentum baseline
  (trailing 20d sign — the reigning champion any tilt must beat).
- Durable tilt log: `data/tilt-log.json`, scored 2x daily by
  `scripts/score-tilt.js` in the fetch-odds workflow. Verdicts arrive via
  owner-gated GitHub issues ("TILT:" title + fenced json block) parsed by
  `scripts/log-tilt.js` / `.github/workflows/log-tilt.yml`; the dashboard's
  log/sync buttons prefill the issue. Browser localStorage is now just a
  cache — the page merges the server log on load and flags unsynced entries.
- Oil-regime discriminator (index.html): 10d co-movement of CL + HG + ^TNX from
  committed files. DISPLAY-ONLY with pre-committed falsifier (panel text, dated
  2026-07-19): regime-conditioned t+20 oil signal must beat unconditioned by
  ≥10pts after ≥30 tagged days, else retire it. NOT wired into tilt.

## Known pitfalls (each cost us a debugging session)
- Polymarket Gamma `/markets?search=` silently IGNORES the search param and
  returns top-volume junk. Use `/public-search?q=` + client-side keyword filter.
- Yahoo `chartPreviousClose` breaks on futures rolls (once manufactured a fake
  −11% oil print). Compute change vs prior daily close within the series.
- `window.storage` exists only inside Claude.ai artifacts — NOT in browsers.
  It silently no-ops on GitHub Pages (this destroyed a year of manual odds
  logging). Use localStorage in pages; prefer Actions-committed files.
- Futures/index tickers sometimes omit `regularMarketPrice` — guard for it.
- Escalation keyword tagger needs reversal-word detection ("blockade LIFTED").
- Contracts with past resolution dates settle at 0/100 — filter by endDate.

## Work queue
1. ~~Verify odds logger deployed~~ DONE 2026-07-19: first run committed 20 sane
   rows to `data/catalyst-log.json`.
2. ~~Build server-side tilt scorer~~ BUILT 2026-07-20: `data/tilt-log.json` +
   `scripts/score-tilt.js` (runs in fetch-odds workflow) + issue-driven inbox
   (`log-tilt.yml`, owner-gated: dashboard buttons open a prefilled "TILT:"
   issue; submitting commits + scores it). REMAINING: Chris must tap
   "⬆ Commit log to repo" on the iPad once — that syncs the real v13
   localStorage entries (true timestamps/spots) into the durable log.
3. ~~Build the oil-regime discriminator~~ BUILT 2026-07-19 as display-only panel
   with pre-committed falsifier. Copper (HG=F) added to tickers.json — verify
   first `data/HG_F.json` commit has 5y backfill. REMAINING: after ≥30 tagged
   days, run the falsifier test before any wiring into tilt.
4. Migrate remaining CORS-proxy fetches to same-origin `data/` reads.
5. After ~90 days of odds history: run Link 1 test (odds lead/lag vs oil tape).
6. Verify Kalshi series tickers on first Actions run (log warns if a series
   returns 0 markets — fix `kalshiSeries` in `data/odds-topics.json` via web UI).
7. After ~60 days of `kalshi-log.json`: test the Fed-conflict hypothesis —
   "hawkish weekly shift in Kalshi rate-path odds should have capped bullish
   confidence." State exact threshold BEFORE scoring.
8. Smart-wallet layer (unbuilt): Polymarket data-api exposes per-wallet trades +
   leaderboard P&L. Hypothesis to spec before building: calibrated-wallet-
   weighted odds lead the mid. `trades24h` field (now logging) is the cheap
   precursor — whale-vs-crowd repricing.
9. Physical layer (logging since 2026-07-21): `data/physical-log.json` — silver
   curve spread (SI=F front vs deferred, tickers in `odds-topics.json →
   silverCurve`, ROLL THEM as contracts expire; backwardation = physical
   stress) + best-effort SLV ounces (field names self-diagnose in Actions log).
   Hypothesis to spec BEFORE using either as a signal. Lease rates and Shanghai
   premium have no free source — still blind there.
10. Verdict hygiene (built 2026-07-21): logBtn warns when a directional call
   merely extrapolates a ≥3% 5-session move (the May failure pattern, 20% hit
   rate). The Fed-channel text in Channel Scope now carries the falsified-as-
   general-driver caveat — hawkish repricing is NOT automatically bearish
   until the item-7 test says so.
