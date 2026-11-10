"""Independent, read-only audit of a git-committed forward forecast log.

Risk-Tier: T2 (new read-only analysis tooling; no authority, no writes to the
audited repository, no network, no provider, no execution of audited code).

The audited repository keeps a forward log of directional calls (a JSON array)
and a daily price series, both committed by automation. This tool answers three
questions from git history alone, without running any of that repository's code:

1. PRECOMMITMENT. When did each entry first appear in a commit, and how many
   later sessions had already closed by then?
2. IMMUTABILITY. After an entry first appeared, were any of its commitment
   fields changed, or was it removed?
3. REPRODUCTION. Do the recorded scores follow from the committed prices under
   the stated rule, and how do the calls compare with simple baselines on the
   same horizon-calls?

It also checks whether a committed closing price changed after it became final.

Limits, stated once: commit times are those recorded in git. They come from the
committing machine's clock and could be forged by anyone able to rewrite the
branch; a third party who fetched the repository earlier, or the hosting
service's own push records, can corroborate them, and this tool does not. A
call that a fixed rule would have produced anyway is still counted here as late
if it was committed late: the audit measures what was on record, not what was
computable.

    python3 -m tools.forward_log_audit_v0 --repo PATH --out-json F --out-md F
    python3 forward_log_audit_v0.py --repo . --summary-json F --check     (unattended)
"""
import argparse
import bisect
import datetime
import json
import subprocess
import sys

LOG_PATH = 'data/tilt-log.json'
PRICE_PATH = 'data/SI_F.json'
HORIZONS = (5, 10, 20)
MOMENTUM_LOOKBACK = 20
# A daily bar dated X is treated as knowable from X 21:00 UTC (17:00 New York in
# summer; one hour early in winter, which errs toward calling a commit late).
CLOSE_HOUR_UTC = 21
# What a call commits to. Every other field is scoring or annotation.
COMMITMENT_FIELDS = ('t', 'tilt', 'confidence', 'spot', 'source', 'recorder', 'headline', 'flags',
                     'inputs', 'oddsAt', 'recordedAt', 'inputsAt', 'contractsSeen')
CORE_FIELDS = ('tilt', 'confidence', 'spot')


def git(repo, *args):
    return subprocess.run(('git', '-C', repo) + args, check=True, capture_output=True).stdout


def history(repo, path, rev='HEAD'):
    """[(committer_time, commit, author)] for commits touching path, oldest first."""
    out = git(repo, 'log', '--format=%ct %H %an', rev, '--', path).decode('utf-8', 'replace')
    rows = [(int(a), b, c) for a, b, c in (line.split(' ', 2) for line in out.splitlines() if line)]
    return sorted(rows)


def blob(repo, commit, path):
    try:
        return json.loads(git(repo, 'show', '%s:%s' % (commit, path)))
    except (subprocess.CalledProcessError, ValueError):
        return None


def is_weekend(date):
    return datetime.date.fromisoformat(date).weekday() >= 5


def bars_of(price_doc):
    rows = ((price_doc or {}).get('historical') or {}).get('ohlc') or []
    rows = [b for b in rows if b.get('date') and b.get('c') is not None and not is_weekend(b['date'])]
    return sorted(rows, key=lambda b: b['date'])


def close_time(date):
    d = datetime.datetime.fromisoformat(date).replace(tzinfo=datetime.timezone.utc)
    return int(d.timestamp()) + CLOSE_HOUR_UTC * 3600


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def key_of(entry):
    return '%s|%s|%s' % (entry.get('t'), entry.get('source'), entry.get('recorder') or '')


def audit_log_history(repo, rev='HEAD'):
    """First appearance, later commitment-field changes and removals, per entry."""
    entries, order = {}, []
    present_before = set()
    for ts, commit, author in history(repo, LOG_PATH, rev):
        doc = blob(repo, commit, LOG_PATH)
        if not isinstance(doc, list):
            continue
        present = set()
        for raw in doc:
            if not isinstance(raw, dict) or not raw.get('t'):
                continue
            key = key_of(raw)
            present.add(key)
            commitment = {f: raw.get(f) for f in COMMITMENT_FIELDS}
            state = entries.get(key)
            if state is None:
                entries[key] = dict(key=key, first_commit=commit, first_commit_time=ts, first_author=author,
                                    first=commitment, last=commitment, changes=[], removed_at=None,
                                    reappeared=False, scored={})
                order.append(key)
                state = entries[key]
            for h in HORIZONS:           # when the score now on record was written
                value = raw.get('p%d' % h)
                if value is not None and state['scored'].get(h, (None, None))[1] != value:
                    state['scored'][h] = (ts, value)
            if state['first_commit'] == commit:
                continue
            if state['removed_at'] is not None:
                state['removed_at'], state['reappeared'] = None, True
            for f in COMMITMENT_FIELDS:
                if commitment[f] != state['last'][f]:
                    state['changes'].append(dict(commit=commit, time=ts, author=author, field=f,
                                                 old=state['last'][f], new=commitment[f]))
            state['last'] = commitment
        for key in present_before - present:
            if entries[key]['removed_at'] is None:
                entries[key]['removed_at'] = dict(commit=commit, time=ts, author=author)
        present_before = present
    return [entries[k] for k in order]


def audit_price_stability(repo, since, rev='HEAD'):
    """Closes that changed after the bar was final (a later-dated bar existed)."""
    seen = {}
    for ts, commit, _ in history(repo, PRICE_PATH, rev):
        bars = bars_of(blob(repo, commit, PRICE_PATH))
        for b in bars[:-1]:                       # the last bar may still be forming
            if b['date'] >= since:
                seen.setdefault(b['date'], {}).setdefault(round(float(b['c']), 3), ts)
    changed = []
    for date in sorted(seen):
        values = sorted(seen[date].items(), key=lambda kv: kv[1])
        if len(values) > 1:
            lo, hi = min(v for v, _ in values), max(v for v, _ in values)
            changed.append(dict(date=date, values=[dict(close=v, first_seen=iso(t)) for v, t in values],
                                spread_pct=round((hi - lo) / lo * 100, 3) if lo else None))
    return dict(final_bars_checked=len(seen), changed=changed)


def anchor_index(dates, day):
    """The scoring rule's t+0 bar: that day's bar, else the last completed session before it."""
    i = bisect.bisect_left(dates, day)
    if i < len(dates) and dates[i] == day:
        return i
    if not dates or day > dates[-1]:
        return -1
    return i - 1


def rescore(entry, bars, dates):
    """Recompute p/pct/hit per horizon and the momentum direction from FINAL committed closes.

    A bar is final only once a later-dated bar exists: the newest bar may still be trading.
    A horizon whose outcome bar is not final is None, never a provisional value.
    """
    day = str(entry['t'])[:10]
    idx = anchor_index(dates, day)
    final = len(bars) - 1                         # indices below this are final
    out = dict(anchor=dates[idx] if idx >= 0 else None, horizons={})
    spot, tilt = entry.get('spot'), entry.get('tilt')
    momentum = None
    if MOMENTUM_LOOKBACK <= idx < final:
        momentum = 'bullish' if bars[idx]['c'] >= bars[idx - MOMENTUM_LOOKBACK]['c'] else 'bearish'
    out['momentum'] = momentum
    for h in HORIZONS:
        j = idx + h if idx >= 0 else -1
        if j < 0 or j >= final or spot in (None, 0):
            out['horizons'][h] = None
            continue
        close = bars[j]['c']
        pct = round((close - spot) / spot * 100, 2)
        hit = ((tilt == 'bullish' and pct > 0) or (tilt == 'bearish' and pct < 0)
               or (tilt == 'balanced' and abs(pct) < 2))
        out['horizons'][h] = dict(date=dates[j], close=round(close, 3), pct=pct, hit=hit,
                                  momentum_hit=None if momentum is None else (pct > 0) == (momentum == 'bullish'))
    return out


def verify_scores(log_rows, bars, dates):
    """Current recorded scores of one log against final committed closes (no history)."""
    out = dict(horizon_scores=0, not_yet_verifiable=0, differs_from_final_close=0, hit_flag_differs=0,
               examples=[])
    for raw in log_rows or []:
        if not isinstance(raw, dict) or not raw.get('t'):
            continue
        score = rescore(raw, bars, dates)
        for h in HORIZONS:
            mine, theirs = score['horizons'][h], raw.get('p%d' % h)
            if theirs is None:
                continue
            out['horizon_scores'] += 1
            if mine is None:
                out['not_yet_verifiable'] += 1
                continue
            differs = abs(mine['close'] - theirs) > 0.0015
            flips = mine['hit'] != raw.get('hit%d' % h)
            out['differs_from_final_close'] += differs
            out['hit_flag_differs'] += flips
            if (differs or flips) and len(out['examples']) < 10:
                out['examples'].append(dict(t=raw['t'], horizon=h, outcome_date=mine['date'],
                                            recorded=theirs, final_close=mine['close']))
    return out


def failures(result):
    """Integrity failures: facts that should never be true of a sound forward log."""
    imm, rep, price = result['immutability'], result['reproduction'], result['price_stability']
    out = []
    if imm['entries_with_core_field_changes']:
        out.append('%d entries had direction, confidence or entry price changed after first commit'
                   % imm['entries_with_core_field_changes'])
    if imm['entries_removed_from_history']:
        out.append('%d entries were removed from the log' % len(imm['entries_removed_from_history']))
    if price['changed']:
        out.append('%d final daily closes changed after the fact' % len(price['changed']))
    if rep['differs_from_final_close'] or rep['hit_flag_differs']:
        out.append('%d recorded scores and %d hit flags differ from final closes in %s'
                   % (rep['differs_from_final_close'], rep['hit_flag_differs'], result['log_path']))
    for path, v in sorted(result.get('other_logs', {}).items()):
        if v['differs_from_final_close'] or v['hit_flag_differs']:
            out.append('%d recorded scores and %d hit flags differ from final closes in %s'
                       % (v['differs_from_final_close'], v['hit_flag_differs'], path))
    return out


def summarize(rows):
    """Engine and baselines on the same directional horizon-calls."""
    out = {}
    for h in HORIZONS:
        calls = [r for r in rows if r['tilt'] in ('bullish', 'bearish') and r['score']['horizons'][h]]
        n = len(calls)
        hits = sum(1 for r in calls if r['score']['horizons'][h]['hit'])
        up = sum(1 for r in calls if r['score']['horizons'][h]['pct'] > 0)
        momo = [r['score']['horizons'][h]['momentum_hit'] for r in calls
                if r['score']['horizons'][h]['momentum_hit'] is not None]
        brier = [((r['confidence'] or 0) / 100 - (1 if r['score']['horizons'][h]['hit'] else 0)) ** 2
                 for r in calls if r['confidence'] is not None]
        # Overlapping windows are not independent. Calls whose anchors differ by a multiple of h
        # sessions do not overlap, so each residue class of the anchor index is one independent
        # subsample. All h of them are reported; none is singled out.
        phases = []
        for phase in range(h):
            sub = [r for r in calls if r['anchor_index'] % h == phase]
            if sub:
                phases.append((len(sub), sum(1 for r in sub if r['score']['horizons'][h]['hit'])))
        rates = sorted(k / n_ for n_, k in phases)
        out['t+%d' % h] = dict(
            calls=n, engine_hits=hits, engine_rate=round(hits / n, 3) if n else None,
            always_bullish_rate=round(up / n, 3) if n else None,
            momentum_calls=len(momo), momentum_rate=round(sum(momo) / len(momo), 3) if momo else None,
            brier=round(sum(brier) / len(brier), 4) if brier else None,
            independent_subsamples=len(phases),
            independent_calls_each=[n_ for n_, _ in phases],
            independent_rate_min=round(rates[0], 3) if rates else None,
            independent_rate_max=round(rates[-1], 3) if rates else None)
    return out


def audit(repo, rev='HEAD', also_scores=()):
    head = git(repo, 'rev-parse', rev).decode().strip()
    log_now = blob(repo, head, LOG_PATH)
    bars = bars_of(blob(repo, head, PRICE_PATH))
    dates = [b['date'] for b in bars]
    closes_at = [close_time(d) for d in dates]
    tracked = {e['key']: e for e in audit_log_history(repo, rev)}
    rows, mismatches = [], []
    scoring = dict(horizon_scores=0, not_yet_verifiable=0, final_but_unscored=0,
                   recorded_before_outcome_close=0, differs_from_final_close=0,
                   hit_flag_differs=0, primary_differs=0, primary_hit_flag_differs=0, abs_pct_diffs=[])
    other_changes = {}
    for raw in log_now:
        key = key_of(raw)
        track = tracked[key]
        day = str(raw['t'])[:10]
        idx = anchor_index(dates, day)
        commit_time = track['first_commit_time']
        # Sessions after the entry day whose close was knowable when the entry was first committed.
        after = bisect.bisect_right(dates, day)
        lag = max(0, bisect.bisect_right(closes_at, commit_time) - after)
        score = rescore(raw, bars, dates)
        is_primary = not raw.get('dup') and not raw.get('superseded')
        for h in HORIZONS:
            mine, theirs = score['horizons'][h], raw.get('p%d' % h)
            if theirs is None:
                scoring['final_but_unscored'] += mine is not None     # the scorer has not run since
                continue
            scoring['horizon_scores'] += 1
            if mine is None:        # outcome bar not final in the committed series: cannot be checked yet
                scoring['not_yet_verifiable'] += 1
                continue
            scored_at = track['scored'].get(h, (None, None))[0]
            early = scored_at is not None and scored_at < close_time(mine['date'])
            scoring['recorded_before_outcome_close'] += early
            differs = abs(mine['close'] - theirs) > 0.0015
            flips = mine['hit'] != raw.get('hit%d' % h)
            if differs or flips:
                scoring['differs_from_final_close'] += differs
                scoring['hit_flag_differs'] += flips
                scoring['primary_differs'] += differs and is_primary
                scoring['primary_hit_flag_differs'] += flips and is_primary
                scoring['abs_pct_diffs'].append(abs(theirs - mine['close']) / mine['close'] * 100)
                mismatches.append(dict(key=key, horizon=h, kind='VALUE_DIFFERS', outcome_date=mine['date'],
                                       recomputed=mine['close'], recorded=theirs, recomputed_hit=mine['hit'],
                                       recorded_hit=raw.get('hit%d' % h),
                                       recorded_at=iso(scored_at) if scored_at else None,
                                       recorded_before_outcome_close=early))
        for c in track['changes']:
            if c['field'] not in CORE_FIELDS:
                other_changes[c['field']] = other_changes.get(c['field'], 0) + 1
        core_changes = [c for c in track['changes'] if c['field'] in CORE_FIELDS]
        claimed = raw.get('recordedAt')
        claimed_delta = None
        if claimed:
            try:
                claimed_ts = datetime.datetime.fromisoformat(claimed.replace('Z', '+00:00')).timestamp()
                claimed_delta = int(commit_time - claimed_ts)
            except ValueError:
                claimed_delta = None
        rows.append(dict(
            key=key, t=raw['t'], tilt=raw.get('tilt'), confidence=raw.get('confidence'),
            source=raw.get('source'), recorder=raw.get('recorder'), dup=bool(raw.get('dup')),
            superseded=bool(raw.get('superseded')), anchor_index=idx, score=score,
            first_commit=track['first_commit'][:10], first_commit_time=iso(commit_time),
            first_author=track['first_author'], sessions_closed_before_commit=lag,
            commitment_changes=len(track['changes']), core_changes=len(core_changes),
            seconds_from_claimed_record_time_to_commit=claimed_delta))
    removed = [dict(key=e['key'], removed_at=iso(e['removed_at']['time']), commit=e['removed_at']['commit'][:10],
                    author=e['removed_at']['author'], first_commit_time=iso(e['first_commit_time']),
                    tilt=e['last']['tilt'], confidence=e['last']['confidence'])
               for e in tracked.values() if e['removed_at'] is not None]
    changes = [dict(key=e['key'], field=c['field'], old=c['old'], new=c['new'], time=iso(c['time']),
                    commit=c['commit'][:10], author=c['author'])
               for e in tracked.values() for c in e['changes'] if c['field'] in CORE_FIELDS]
    primary = [r for r in rows if not r['dup'] and not r['superseded']]
    on_record_first = [r for r in primary if r['sessions_closed_before_commit'] == 0 and r['core_changes'] == 0]
    lag_counts = {}
    for r in rows:
        bucket = str(r['sessions_closed_before_commit']) if r['sessions_closed_before_commit'] < 5 else '5+'
        lag_counts[bucket] = lag_counts.get(bucket, 0) + 1
    since = min((str(r['t'])[:10] for r in rows), default='0000-00-00')
    diffs = sorted(scoring.pop('abs_pct_diffs'))
    scoring['median_abs_pct_difference'] = round(diffs[len(diffs) // 2], 2) if diffs else None
    scoring['max_abs_pct_difference'] = round(diffs[-1], 2) if diffs else None
    deltas = [abs(r['seconds_from_claimed_record_time_to_commit']) for r in rows
              if r['seconds_from_claimed_record_time_to_commit'] is not None]
    return dict(
        schema='synapse-forward-log-audit:0', audited_commit=head, log_path=LOG_PATH, price_path=PRICE_PATH,
        entries=len(rows), primary_entries=len(primary), price_bars=len(bars),
        last_price_date=dates[-1] if dates else None,
        precommitment=dict(sessions_closed_before_first_commit=dict(sorted(lag_counts.items())),
                           on_record_before_any_later_close=len([r for r in rows
                                                                 if r['sessions_closed_before_commit'] == 0]),
                           first_authors=_count(r['first_author'] for r in rows)),
        immutability=dict(entries_with_core_field_changes=len({c['key'] for c in changes}),
                          core_field_changes=changes, entries_removed_from_history=removed,
                          entries_with_any_commitment_change=len([r for r in rows if r['commitment_changes']]),
                          other_field_changes=dict(sorted(other_changes.items())),
                          entries_with_claimed_record_time=len(deltas),
                          max_seconds_between_claimed_record_time_and_commit=max(deltas, default=None)),
        reproduction=dict(scoring, mismatches=mismatches),
        price_stability=audit_price_stability(repo, since, rev),
        other_logs={path: verify_scores(blob(repo, head, path), bars, dates) for path in also_scores},
        samples=dict(
            all_primary=dict(entries=len(primary), by_horizon=summarize(primary)),
            on_record_first=dict(entries=len(on_record_first),
                                 first=min((r['t'] for r in on_record_first), default=None),
                                 last=max((r['t'] for r in on_record_first), default=None),
                                 by_horizon=summarize(on_record_first)),
            committed_late=dict(entries=len(primary) - len(on_record_first),
                                by_horizon=summarize([r for r in primary if r not in on_record_first]))),
        rows=rows)


def _count(values):
    out = {}
    for v in values:
        out[v] = out.get(v, 0) + 1
    return dict(sorted(out.items()))


def _pct(x):
    return 'n/a' if x is None else '%.0f%%' % (x * 100)


def report(result):
    """A short Markdown report of the audit result."""
    pre, imm, rep, price = (result[k] for k in ('precommitment', 'immutability', 'reproduction',
                                                'price_stability'))
    lines = ['# Forward-log audit', '',
             'Audited commit `%s`. %d entries (%d primary), %d price bars to %s.' % (
                 result['audited_commit'], result['entries'], result['primary_entries'],
                 result['price_bars'], result['last_price_date']), '',
             '## 1. Precommitment', '',
             '| Later sessions already closed at first commit | Entries |', '|---|---|']
    lines += ['| %s | %d |' % kv for kv in pre['sessions_closed_before_first_commit'].items()]
    lines += ['', 'First committed by: %s.' % ', '.join('%s (%d)' % kv for kv in pre['first_authors'].items()), '',
              '## 2. Immutability', '',
              '- Entries whose direction, confidence or entry price changed after first commit: **%d**' %
              imm['entries_with_core_field_changes'],
              '- Entries removed from the log at some later commit: **%d**' % len(imm['entries_removed_from_history']),
              '- Entries with any other commitment-field change: %d (%s)' % (
                  imm['entries_with_any_commitment_change'],
                  ', '.join('%s x%d' % kv for kv in imm['other_field_changes'].items()) or 'none'),
              '- Largest gap between an entry\'s own claimed record time and its first commit: %s seconds '
              '(%d entries carry a claimed time)' % (imm['max_seconds_between_claimed_record_time_and_commit'],
                                                    imm['entries_with_claimed_record_time']), '']
    for c in imm['core_field_changes'][:40]:
        lines.append('  - `%s` %s: %r -> %r at %s by %s (`%s`)' % (
            c['key'], c['field'], c['old'], c['new'], c['time'], c['author'], c['commit']))
    for e in imm['entries_removed_from_history'][:40]:
        lines.append('  - removed `%s` (%s, %s) at %s by %s (`%s`)' % (
            e['key'], e['tilt'], e['confidence'], e['removed_at'], e['author'], e['commit']))
    lines += ['', '## 3. Reproduction', '',
              '- Horizon scores recorded in the log: %d (%d cannot be checked yet: their outcome bar is '
              'not final in the committed series)' % (rep['horizon_scores'], rep['not_yet_verifiable']),
              '- Final outcome bars the scorer has not scored yet: %d' % rep['final_but_unscored'],
              '- Recorded before the outcome session had closed: **%d**' % rep['recorded_before_outcome_close'],
              '- Recorded price differs from the final committed close: **%d** (%d on primary entries)%s' % (
                  rep['differs_from_final_close'], rep['primary_differs'],
                  '; median %s%%, largest %s%%' % (rep['median_abs_pct_difference'], rep['max_abs_pct_difference'])
                  if rep['mismatches'] else ''),
              '- Hit or miss flag differs from the one the final close gives: **%d** (%d on primary entries)' % (
                  rep['hit_flag_differs'], rep['primary_hit_flag_differs']), '']
    if rep['mismatches']:
        lines += ['First ten:', '']
    for m in rep['mismatches'][:10]:
        lines.append('  - `%s` t+%d, outcome %s: recorded %s at %s, final close %s' % (
            m['key'], m['horizon'], m.get('outcome_date'), m['recorded'], m.get('recorded_at'), m['recomputed']))
    for path, v in sorted(result.get('other_logs', {}).items()):
        lines.append('- `%s`, current scores only: %d scores, %d not yet checkable, **%d** differ from the '
                     'final close, **%d** hit flags differ' % (path, v['horizon_scores'], v['not_yet_verifiable'],
                                                               v['differs_from_final_close'], v['hit_flag_differs']))
    lines += ['', '## 4. Price stability', '',
              '- Final daily closes checked across history: %d' % price['final_bars_checked'],
              '- Closes that later changed: **%d**' % len(price['changed'])]
    for c in price['changed'][:40]:
        lines.append('  - %s: %s (spread %s%%)' % (c['date'], ' -> '.join(str(v['close']) for v in c['values']),
                                                  c['spread_pct']))
    lines += ['', '## 5. Results on the same horizon-calls', '',
              'Scored here from final committed closes. "On record first" means first committed before any '
              'later session closed, with direction, confidence and entry price never changed. Overlapping '
              'windows are not independent: the last two columns give the number of calls in, and the range '
              'of the engine\'s hit rate across, the non-overlapping subsamples.', '']
    for name, title in (('on_record_first', 'On record first'), ('committed_late', 'Committed late'),
                        ('all_primary', 'All primary entries')):
        s = result['samples'][name]
        span = ' (%s to %s)' % (s['first'], s['last']) if s.get('first') else ''
        lines += ['**%s: %d entries%s**' % (title, s['entries'], span), '',
                  '| Horizon | Calls | Engine | Momentum | Always bullish | Brier | Calls per independent subsample | Engine range |',
                  '|---|---|---|---|---|---|---|---|']
        for h, v in s['by_horizon'].items():
            lines.append('| %s | %d | %s | %s | %s | %s | %s | %s to %s |' % (
                h, v['calls'], _pct(v['engine_rate']), _pct(v['momentum_rate']), _pct(v['always_bullish_rate']),
                'n/a' if v['brier'] is None else '%.3f' % v['brier'],
                ', '.join(map(str, v['independent_calls_each'])) or 'none',
                _pct(v['independent_rate_min']), _pct(v['independent_rate_max'])))
        lines.append('')
    found = failures(result)
    lines += ['## 6. Integrity check', '', '**%s**' % ('FAIL' if found else 'PASS'), '']
    lines += ['- ' + f for f in found]
    return '\n'.join(lines)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--repo', required=True)
    parser.add_argument('--rev', default='HEAD')
    parser.add_argument('--out-json', help='full result, including one row per entry')
    parser.add_argument('--summary-json', help='result without the per-entry rows')
    parser.add_argument('--out-md')
    parser.add_argument('--also-scores', nargs='*', default=[], metavar='PATH',
                        help='further logs whose current scores are checked against final closes')
    parser.add_argument('--check', action='store_true', help='exit 2 when an integrity failure is found')
    args = parser.parse_args(argv)
    result = audit(args.repo, args.rev, tuple(args.also_scores))
    result['integrity_failures'] = failures(result)
    text = report(result)
    if args.summary_json:
        with open(args.summary_json, 'w', encoding='utf-8') as f:
            summary = {k: v for k, v in result.items() if k != 'rows'}
            listed = summary['reproduction']['mismatches']
            summary['reproduction'] = dict(summary['reproduction'], mismatches=listed[:20],
                                           mismatches_listed='%d of %d' % (min(20, len(listed)), len(listed)))
            json.dump(summary, f, indent=1, sort_keys=True)
            f.write('\n')
    if args.out_json:
        with open(args.out_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=1, sort_keys=True)
            f.write('\n')
    if args.out_md:
        with open(args.out_md, 'w', encoding='utf-8') as f:
            f.write(text + '\n')
    print(text)
    return 2 if args.check and result['integrity_failures'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
