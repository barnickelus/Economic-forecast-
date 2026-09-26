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
  were placed 2026-05-27/28 at ~$75-76 (two weeks after a $88.89 local high on
  May 13); silver fell ~22% over the next 20 sessions (June low $57.03).
  (CORRECTED 2026-09-26 from committed OHLC: an earlier version called ~$76
  "the May-2026 top". The 5y high is 2026-01-29 at $121.30 intraday / $115.08
  close; silver has made lower highs since — Mar $95.86, May $88.89.)
- The engine's only honest entry was a 28%-confidence abstain. Confidence has
  been anti-correlated with outcomes. The tilt engine has NO demonstrated edge.
- Recorder-v2 clean sample (2026-07-20..09-24, scored 2026-09-25): 48 entries
  (24 bearish / 15 bullish / 9 abstain), directional hit 43% on 72
  horizon-calls vs momentum 42% on the same calls; 11 independent t+5
  windows. v14 shadow 50% vs v13 41% vs momentum 39% on 66 shared calls,
  8/15 independent windows toward the promotion gate. Flip rate 63%. v15
  on the same (in-sample) window: 9/18 directional t+5 hits — the study's
  t+5 pass did not show up in this slice; treat it as noise until live.
- FADE ANALYSIS (2026-09-26, "would the opposite bet have been better?"):
  fading beat following in every population, but NONE of it is an edge.
  Recorder-v2 window: silver rose after bullish calls (+1.6% t+5, +5.2%
  t+10) AND after bearish calls (+1.8%, +2.5%) — the engine's direction
  carried no information; bearish calls (23 of 36 at t+5) lost because
  silver rose ~12% over the window. Fading = being long in an uptrend, and
  plain ALWAYS-BULLISH beat the fade at every horizon (t+5 64% vs 61%, t+10
  66% vs 50%, t+20 64% vs 56%). Manual era: fade 77%/69%/69% on 13 calls
  vs always-bullish 46%/69%/69% — the fade's only edge is at t+5 on 5
  independent windows (p=0.06). v1 era: fade ~50%. Rule going forward: a
  fade is a forecaster like any other and must beat momentum AND always-
  bullish on the live sample; the scoreboard on the page tracks it.

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
- `scripts/engine.js` — THE ENGINE, shared verbatim by the dashboard
  (`<script src>` → `window.Engine`) and the server (`require`). Single source
  of truth on purpose: a duplicated copy would drift and silently corrupt the
  auto-vs-manual comparison. Pure — no DOM, no network. Verified
  behaviour-identical to the old inline copy over 400 randomized inputs.
- `scripts/engine.js` reason(d,variant): variant 'v14' = THE CHALLENGER
  (spec pre-committed 2026-08-16 in the file header): 5-session oil input
  (repairs v13 feeding its dominant weight the one timescale validated to
  carry no information) + dead-band 0.15→0.25. Shadow-logged daily to
  `data/shadow-v14.json`, scored identically by score-tilt, compared only on
  shared dates. PROMOTION RULE (fixed): ≥15 independent t+5 windows AND pooled
  t+5/t+10 hit beats BOTH v13 and momentum by ≥10pp on the same dates, else
  v14 is retired. Champion regression-locked (0 diffs over 400 inputs).
- `scripts/referee-*.js` — PRE-REGISTERED EVALUATION CODE for the three
  pending tests (discriminator falsifier, item-7 Kalshi, flag wiring), frozen
  before any test could run. They print NOT READY until their pre-committed
  maturity gates, then PASS/FAIL. Run every fetch-odds pass. Do not edit a
  referee after its data starts accruing.
- `scripts/watchdog.js` — opens a GitHub issue (deduped) when auto-logging
  gaps 2+ weekdays or SI_F goes >26h stale. Failures now reach a phone.
- `scripts/auto-tilt.js` — DAILY AUTO-LOGGER, RECORDER v2 (rule pre-committed
  2026-09-25; runs in the fetch-odds workflow, 2x daily). The verdict for trade
  date D is a DETERMINISTIC FUNCTION OF INPUTS DATED <= D, computed on the
  first run after D's bar is final (a later-dated bar exists in the committed
  series): closes <= D for spot/oil/gold/ratio/discriminator, the odds
  logger's `catalyst-log.json` rows dated D for the contract population
  (delta vs the latest rows dated < D, expiry measured from D), Kalshi and
  physical rows <= D for the flags. Entries carry `recorder:'v2'`, `oddsAt`,
  `recordedAt` and the oil inputs the engine saw (`inputs`). Logging D a day
  or three late is reproduction, not backfill — the only unrecoverable gap is
  a day with no odds rows. Still REFUSES to log when the contract channel is
  blind (zero matching rows: an oil-only verdict is a different forecaster).
  Computes the contradiction flags server-side with the dashboard's thresholds.
- `index.html` — main dashboard (large, ~178KB). Reads committed data files
  same-origin; some legacy fetches still use public CORS proxies (flaky —
  migrate to `data/` reads where possible).
- `catalyst.html` — Polymarket catalyst monitor. Live odds + oil divergence
  flags. DIVERGE = odds moved >5pt/24h while |Brent| < 1%. Since 2026-09-26
  every proxy call is timed (7s) and raced; searches run in parallel; if
  all proxies fail it falls back to `data/catalyst-latest.json` and says so.
- Dashboard SCOREBOARD (built 2026-09-26): v13, v14, v15, momentum,
  always-bullish and fade-v13 on the same recorder-v2 dates, latest call +
  directional hit rate, split into the recomputed window and the live
  column (from 2026-09-25). The live column is the only one that counts.
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
- `fetch()` has no timeout. Any browser call through a public CORS proxy must
  carry an AbortController timeout and race the proxies — a stalled proxy
  otherwise hangs the whole page action forever (the 2026-09 Analyze hang).
- The embedded `SV`/`GOLD` series in index.html are a snapshot ending
  2026-05-15; `extendSeries()` appends committed OHLC on the first Analyze.
- Escalation keyword tagger needs reversal-word detection ("blockade LIFTED").
- Contracts with past resolution dates settle at 0/100 — filter by endDate.
- Weekend pseudo-bars: Yahoo stamps the Globex Sunday-evening open as a
  Sunday-dated bar. SCORING now filters weekend bars everywhere (score
  version ohlc-v3); the auto-logger refuses them. Any new OHLC consumer must
  filter them too.
- Yahoo MIS-DATES the evening session: from the 22:00 UTC Globex reopen until
  some hours later, the daily bar dated TODAY is the newly opened NEXT
  session (open/close both from the reopen), and today's true bar only
  appears when Yahoo re-dates it. Any run between 22:00 UTC and the next
  morning that reads "today's bar" reads tomorrow's first hours. Applies to
  every futures series (SI, GC, CL, HG). Recorder v2 exists because of this.
- GitHub scheduled workflows run LATE on this repo — 2-3h for the 21:10 cron,
  and the */30 price cron fires every ~5h. Never design a rule that depends on
  a cron firing inside a window.
- Front-month rolls silently turn a listed deferred contract into the front
  (spread 0). Every curve consumer must treat |spread| < 0.05% as "the front".
- Tilt-log rows can SHARE A TIMESTAMP (a superseded v1 row and its recorder-v2
  replacement are both "D 21:00"). Never key or merge the log by `t`: the
  dashboard did, silently replacing each clean row with the contaminated one
  and counting both as the day's commitment (fixed 2026-09-26).
- Two workflows must never commit the same file. fetch-odds refreshes prices
  for its own use but commits only the files it owns; a shared file means a
  rebase conflict, a failed push, and a lost odds run.
- The odds logger's `brent`/`brentChangePct` fields are read at run time from
  Yahoo's continuous contract: after 22:00 UTC they span the mis-dated
  evening bar, and on roll days they are fake (2026-09-25: Brent -8.6% vs
  WTI -2.3%). Rows where Brent and WTI moved >4pp apart carry
  `brentChangeSuspect` (3 of 49 days before the flag existed: 08-31, 09-18,
  09-25). Any backtest uses committed final closes (CL_F / BZ_F), never these.
- fetch-data's `ohlcFromYahoo(r, n)` sliced the last n TIMESTAMPS where n was
  the count of non-null closes, so series with null bars lost their oldest
  history (DX-Y.NYB started 2022-08-09 in a "5y" file). Fixed 2026-09-26:
  bars with closes, one per date, last n. Never size a slice by one array
  and apply it to another.
- The embedded OILH (Brent) series in index.html ends 2026-05-28. Until
  2026-09-26 the oil reader's "120d range" was Dec-May plus today's price.
  `extendSeries()` now appends committed BZ=F closes (added to tickers.json);
  the reader returns no read if the series is >10 sessions stale.
- Yahoo's `historical.ohlc` INCLUDES the in-progress session as a partial bar
  (Globex opens 22:00 UTC the prior evening, so "today's bar" exists all day
  with a moving close). The first 9 auto entries were logged from mid-session
  snapshots up to 2.7% off the final close before the post-settlement gate
  (below) fixed it. Anything reading the last bar of historical.ohlc during
  market hours is reading a moving number.

## Work queue
1. ~~Verify odds logger deployed~~ DONE 2026-07-19: first run committed 20 sane
   rows to `data/catalyst-log.json`.
2. ~~Build server-side tilt scorer~~ BUILT 2026-07-20: `data/tilt-log.json` +
   `scripts/score-tilt.js` (runs in fetch-odds workflow) + issue-driven inbox
   (`log-tilt.yml`, owner-gated: dashboard buttons open a prefilled "TILT:"
   issue; submitting commits + scores it). DONE: the manual entries are in the
   durable log (16 `source:'issue'` rows); stale issue #19 (its 3 entries
   already logged, close step had failed) closed 2026-09-26.
3. ~~Build the oil-regime discriminator~~ BUILT 2026-07-19 as display-only panel
   with pre-committed falsifier. Copper (HG=F) added to tickers.json — verify
   first `data/HG_F.json` commit has 5y backfill. REMAINING: after ≥30 tagged
   days, run the falsifier test before any wiring into tilt.
4. Migrate remaining CORS-proxy fetches to same-origin `data/` reads.
   PARTLY DONE 2026-09-25: the Analyze button (`gatherData`) now reads spot/oil/
   gold from committed `data/*.json` (same inputs as auto-tilt) and only uses
   the proxies for the live Polymarket population — all six searches in
   parallel, every proxy under a hard timeout, falling back to
   `data/catalyst-latest.json` (tagged in the data-table meta line). Before
   this, nine sequential proxy calls with NO timeout hung the button forever
   whenever one proxy stalled. DONE 2026-09-26 for catalyst.html too (timed,
   raced, parallel, committed fallback). Proxies remain only for LIVE odds,
   never for anything the page cannot complete without.
5. After ~90 days of odds history: run Link 1 test (odds lead/lag vs oil tape).
   Use committed FINAL closes (CL_F, and BZ_F once it has history) aligned by
   date — not the logger's run-time `brent`/`brentChangePct` fields — and
   exclude `brentChangeSuspect` rows. State the test before running it.
6. Verify Kalshi series tickers on first Actions run (log warns if a series
   returns 0 markets — fix `kalshiSeries` in `data/odds-topics.json` via web UI).
7. After ~60 days of `kalshi-log.json`: test the Fed-conflict hypothesis —
   "hawkish weekly shift in Kalshi rate-path odds should have capped bullish
   confidence." State exact threshold BEFORE scoring.
   VERDICT (referee-kalshi, first mature run 2026-09-25, 69 days): FAIL.
   Bullish calls made INTO a hawkish drift hit 63% (8 horizon-calls) vs 41%
   for other bullish calls (22) — the opposite of the hypothesis, consistent
   with the falsified Fed channel. Caveat: scored on the recomputed,
   in-sample-adjacent window. The cap is not justified; `kalshi-conflict`
   stays annotation-only.
8. Smart-wallet layer (unbuilt): Polymarket data-api exposes per-wallet trades +
   leaderboard P&L. Hypothesis to spec before building: calibrated-wallet-
   weighted odds lead the mid. `trades24h` field (now logging) is the cheap
   precursor — whale-vs-crowd repricing.
9. Physical layer (logging since 2026-07-21; lease added 2026-08-03):
   `data/physical-log.json` — silver curve spread (SI=F front vs deferred,
   tickers in `odds-topics.json → silverCurve`, ROLL THEM as contracts expire;
   backwardation = acute physical stress) + IMPLIED LEASE RATE per deferred
   contract (cost-of-carry: 13wk bill `^IRX` − annualized contango; level reads
   ~0.3-0.5%/yr high from unobservable storage — constant bias, signal is the
   spike; contracts <60d to expiry excluded from the calc) + best-effort SLV
   ounces (still null — iShares endpoint returns HTML; field self-diagnoses).
   PRE-COMMITTED (2026-08-03, before any event): STRESS = lease >2.0% absolute
   OR +100bp within 10 logged days; hypothesis: t+20 return after stress >
   unconditional t+20; test after ≥5 distinct events (episode ends when lease
   <1.5%). Display-only until then. True lease fixings and Shanghai premium
   still have no free source.
   ROLL ARTIFACT (found 2026-09-25, amendments pre-committed before any event
   is counted): SI=F rolled Sep->Dec on 2026-08-27 while Dec was still listed
   as deferred, so its spread read 0 and its "lease" = the whole bill rate
   (3.7-4.1%) — a month of fake STRESS on the panel and 12 fake
   `physical-stress` flags (all on v1 rows, now superseded). Same roll jumped
   the March leg's lease from -0.2% to +1.7% overnight (spread measured
   against a nearer front), tripping the +100bp/10d spike rule. Amendments:
   a leg within 0.05% of the front IS the front (lease not computed, warned,
   ignored by every consumer); the 10-day spike test only counts when the same
   deferred legs exist on both dates and neither row spans a roll. Rows
   2026-08-27..09-25 are roll artifacts — they count toward NO stress event.
   Tickers rolled to SIH27/SIK27 (SIK27 unverified until the first run logs
   it). Roll again when SIH27 is within ~60d (late Jan 2027).
10. Verdict hygiene (built 2026-07-21): logBtn warns when a directional call
   merely extrapolates a ≥3% 5-session move (the May failure pattern, 20% hit
   rate). The Fed-channel text in Channel Scope now carries the falsified-as-
   general-driver caveat — hawkish repricing is NOT automatically bearish
   until the item-7 test says so.
11. One-observation-per-day rule (built 2026-07-21): the FIRST entry of each
   calendar day is the scored commitment; later same-day entries are post-tape
   revisions — kept in the log and scored individually, but flagged `dup` and
   excluded from hit rate, calibration, Brier, and momentum aggregates, on
   both the server scorer and the dashboard. Never delete log rows.
12. Sample-integrity rules (built 2026-08-03, after auditing irregular logging):
   - Non-trading-day entries anchor to the LAST COMPLETED session, not the next
     one. Anchoring forward made "t+5" span six sessions from the price the
     logger actually saw. `scoredFrom` carries a SCORE_VERSION marker
     (`ohlc-v2`); bump it to force one clean re-score when the rule changes.
   - EFFECTIVE SAMPLE SIZE is reported next to every hit rate: consecutive
     daily entries produce horizon windows that overlap almost entirely (six
     t+20 calls on six consecutive days share 19/20 of their price path = ONE
     observation wearing six hats). Greedy non-overlapping window count shown
     on the dashboard and in the Actions log. Horizons with <5 independent
     windows are anecdote, not measurement.
   - RECORDING FAIRNESS (added 2026-08-16): auto entries log ONLY from the
     post-settlement run (>=21:00 UTC, same day): earlier, the bar is
     mid-session and the spot is a moving number; later (next morning), the
     odds would postdate the close being scored from — look-ahead in either
     direction. A failed evening run leaves an honest gap. Auto entries
     before 2026-08-17 carry `spotNote` marking mid-session spot drift (up
     to 2.7%); their scores stand but analyses can separate them. Flip-rate
     diagnostic in score-tilt surfaces verdict persistence (57% at intro —
     the engine flips direction day-to-day while claiming 5-20d horizons).
   - SELF-SELECTION: FIXED 2026-08-04 by `scripts/auto-tilt.js` (below). Gaps
     of 12 and 38 days exist in the PRE-2026-08-04 history; entries before that
     date remain self-selected and should be treated as a separate, weaker
     sample from the auto-logged era.
   - RECORDER v2 (pre-committed 2026-09-25). Audit finding: GitHub ran the
     21:10 UTC cron 2-3h late, after the 22:00 UTC Globex reopen, and in that
     window Yahoo's daily bar dated D is the NEWLY OPENED next session (silver
     AND oil), rewritten to the true D bar hours later. 20 of 26 v1 evening
     entries recorded the next session's opening price as D's close (up to
     2.7% off) and fed the engine a phantom oil change (2026-09-22: -6.3%
     "crash" on a -1.2% day -> bullish "relief" verdict). Fix: the rule in the
     Architecture bullet — verdicts are functions of inputs dated <= D, computed
     after D is final. CONSEQUENCES, all pre-committed: (a) the odds-log era
     (2026-07-20 onward) was recomputed under v2 — 48 entries; (b) every v1
     auto row with a v2 row for the same date is KEPT but marked `superseded`
     and treated as a same-day dup (scored for reference, excluded from every
     aggregate and referee); the two v1 rows on non-sessions (Aug-16 Sunday
     pseudo-bar, Sep-7 Labor Day) are marked `superseded` by 'non-session';
     (c) DISCLOSURE: outcomes for the recomputed window were already visible
     when v2 was designed. The design (true closes, dated odds) is the
     obviously correct one and was not tuned to outcomes, but treat the
     recomputed window as in-sample-adjacent; the untainted clean sample
     starts 2026-09-25. (d) The 30-min price cron is throttled to ~5h gaps;
     fetch-odds now refreshes prices itself before recording.

13. Contradiction ledger (built 2026-08-03): five cross-instrument disagreement
   flags computed at analyze time, displayed under the verdict, and stamped
   into each logged entry (`flags` array; whitelist-validated at issue intake).
   WIRED INTO NOTHING. Pre-committed wiring test (stated before any flag was
   logged): a flag earns confidence-damping only if, after ≥20 scored primary
   directional horizon-calls of which ≥5 carry that flag, flagged hit rate is
   ≥15pp worse than unflagged. Flags + fixed thresholds:
   - `oil-premise`: discriminator=DEMAND DESTRUCTION while oilTilt>+0.25
     (engine reading oil-down as relief — the falsified May mapping).
   - `ratio-confirmer`: ratio 20d change >+2% vs bullish, or <−2% vs bearish
     (validated confirmer refusing to confirm).
   - `curve-incoherent`: nearer deal contract >3pts above a farther one
     (logically impossible; contract layer is noise that day).
   - `kalshi-conflict`: hawk-minus-cut for nearest Fed meeting drifted ≥+5pp
     over ~5 logged days vs bullish (item-7 hypothesis, annotation only).
   - `physical-stress`: lease stress or backwardation vs bearish.
   The one pre-existing WIRED damper (oil-vs-contracts `contradiction` →
   conf ≤28) predates the ledger and stays as-is.
   First mature referee run (2026-09-25): `ratio-confirmer` flagged 59% vs
   unflagged 33%, `curve-incoherent` 42% vs 37% — neither is >=15pp WORSE,
   so neither earns damping. `ratio-confirmer` pointing the other way is a
   hint, not a finding (in-sample-adjacent window; would need its own
   pre-registration). `physical-stress` has 0 flags after the roll-artifact
   cleanup; `oil-premise` 0; `kalshi-conflict` 4 — NOT READY.

14. PREDICTOR STUDY (pre-registered 2026-09-25, `scripts/study-predictors.js`,
   committed before its first run; results in `data/study-predictors.json`,
   shown on the page). 16 mechanical signals x t+5/10/20 on committed closes
   (aligned history 2022-08-09.. because DX-Y.NYB only goes back that far),
   OOS from 2025-01-01, non-overlapping windows averaged over phase, pass bar
   in the file header. RESULT: NO candidate. OOS base rate (share of windows
   up) was 60/62/66% — "always bullish" beat every signal. Every oil-CHANGE
   rule (1d = v13's input, 5d = v14's, 20d) scored 47-55% OOS: the "one
   validated channel" is NOT validated as a change signal. Momentum 50-55%
   OOS. The discriminator-conditioned oil rule (historical analogue) 49-53%.
   Yield-change and dollar-change signals flipped sign between IS and OOS.
   Only oil's LEVEL in its trailing 120-session range passed, and only at
   t+5 (OOS 65% on 52 windows vs momentum 47% / always-up 59%); at t+10/20
   it merely matched always-up. That single-horizon pass is the basis for
   the v15 challenger (below) — a weak prior, tested live, never promoted on
   the study alone. Do not re-run the study with different settings and
   report the best one; add a study-v2 with its own pre-registration.
   NOTE: v1's aligned history began 2022-08-09 because of a fetch-data bug
   (below), not data availability.
   STUDY-v2 (pre-registered 2026-09-26 in `scripts/study-predictors-v2.js`,
   committed before its first run; `data/study-predictors-v2.json`): v1's
   16 signals on the full aligned history (2021-09-27.., IS 821 days, OOS
   unchanged) plus oil level at 60d/250d, gold/silver ratio level 250d,
   gold 5d, momentum-in-low-vol. RESULT: NO candidate. v15 BASIS = FRAGILE
   under the pre-committed rule: oilLvl120 passed t+5 again (IS 54%, OOS 65%
   vs momentum 47% / always-up 59%) but neither oilLvl60 (OOS 56%) nor
   oilLvl250 (OOS 67% vs always-up 63%: +4pp, bar is +5) passed t+5.
   Descriptive only, NOT a pass: the oil-level family points the same way
   in all 9 window x horizon cells (IS 51-58%, OOS 56-72%). v15 keeps
   shadow-logging; only its live promotion rule can retire or promote it.
   Cautionary row: ratioLvl250 scored 63/72/78% in-sample and 53/54/54% out
   of sample with NEGATIVE returns — what an overfit looks like here.
15. v15 CHALLENGER (spec pre-committed 2026-09-25 in engine.js): oil channel
   = level, not change — oilTilt +1 at or below the 30th percentile of oil's
   trailing 120 sessions, -1 at or above the 70th, else 0; everything else
   as v14. Shadow-logged to `data/shadow-v15.json`; rows dated before
   2026-09-25 carry `inSample:true` (derivation window) and never count.
   Same promotion rule as v14, counted from 2026-09-25. Champion and v14
   regression-locked (0 diffs over 400 random inputs after the edit).
