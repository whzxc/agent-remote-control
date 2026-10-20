#!/usr/bin/env python3
"""Profile where Codex turns spend wall time, from ~/.codex/sessions rollout logs.

Each tool call is charged with the model time since the previous event plus its own
execution time, under a category inferred from the call input. Categories are
heuristic (one exec call may bundle several actions); treat results as ±5 pp.

Usage:
  rollout-profile.py --thread <threadId>
  rollout-profile.py --cwd sacp-client --days 3 --min-minutes 30
"""
import argparse
import collections
import datetime as dt
import glob
import json
import os

RULES = [
    ('code', ['*** begin patch', 'apply_patch', 'writefile(', 'write_file']),
    ('commit', ['git commit', 'git add ', 'git rm ']),
    ('check', ['check type', 'typecheck', 'lint', 'bun run test', 'bun test', 'vitest', 'rsbuild',
               'tsc ', 'cargo ', 'go test', 'npm run', 'pnpm ', 'bun run build', 'bun run check']),
    ('visual', ['screenshot', 'capture', 'cdp', 'ui run', 'getcomputedstyle', '.png', 'viewport',
                'playwright', 'cua.', 'desktop_', 'browser']),
    ('wait', ['sleep', 'write_stdin', 'wait_agent', '"wait"']),
    ('read', ['rg ', 'sed -n', 'cat ', 'read', 'ls ', 'find ', 'git diff', 'git status', 'git log',
              'git show', 'head ', 'wc ', 'nl ', 'grep ']),
]
KEYS = ['code', 'read', 'check', 'visual', 'wait', 'commit', 'compact', 'other', 'final']


def ts(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def category(name, text):
    s = f'{name} {text}'.lower()
    if name in ('sleep', 'write_stdin', 'wait'):
        return 'wait'
    for cat, keys in RULES:
        if any(k in s for k in keys):
            return cat
    return 'other'


def turns(path):
    cur, last, pend, cwd, title = None, None, {}, '', ''
    for line in open(path, encoding='utf-8'):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        pl = e.get('payload') or {}
        ty, t = pl.get('type'), ts(e['timestamp'])
        if e['type'] == 'session_meta':
            cwd = pl.get('cwd', '')
        if ty == 'task_started':
            cur = {'turn': pl.get('turn_id'), 'start': t, 'c': collections.Counter(), 'exec': 0.0,
                   'calls': 0, 'compactions': 0, 'cwd': cwd}
            last, pend, title = t, {}, ''
            continue
        if cur is None:
            continue
        if ty == 'item_completed' and not title:
            item = pl.get('item', {})
            if item.get('type') == 'UserMessage':
                title = ''.join(x.get('text', '') for x in item.get('content', []) if isinstance(x, dict))
        if ty in ('task_complete', 'turn_aborted'):
            cur['c']['final'] += t - last
            cur['end'], cur['title'] = t, title[:60].replace('\n', ' ')
            yield cur
            cur = None
            continue
        if e['type'] == 'compacted':
            cur['c']['compact'] += t - last
            cur['compactions'] += 1
            last = t
            continue
        if ty in ('function_call', 'custom_tool_call'):
            cat = category(pl.get('name', ''), pl.get('arguments') or pl.get('input') or '')
            if not pend:
                cur['c'][cat] += t - last
            pend[pl.get('call_id')] = (t, cat)
            cur['calls'] += 1
            last = t
            continue
        if ty in ('function_call_output', 'custom_tool_call_output'):
            start, cat = pend.pop(pl.get('call_id'), (t, 'other'))
            cur['c'][cat] += t - start
            cur['exec'] += t - start
            last = t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--thread')
    ap.add_argument('--cwd', default='')
    ap.add_argument('--days', type=int, default=3)
    ap.add_argument('--min-minutes', type=float, default=0)
    a = ap.parse_args()
    root = os.path.expanduser('~/.codex/sessions')
    if a.thread:
        files = glob.glob(f'{root}/**/rollout-*{a.thread}.jsonl', recursive=True)
    else:
        today = dt.date.today()
        days = [today - dt.timedelta(d) for d in range(a.days + 1)]
        files = [f for d in days for f in glob.glob(f'{root}/{d:%Y/%m/%d}/rollout-*.jsonl')]
    rows = [r for f in files for r in turns(f)
            if a.cwd in r['cwd'] and r['end'] - r['start'] >= a.min_minutes * 60]
    rows.sort(key=lambda r: r['start'])
    total, agg, ex = 0.0, collections.Counter(), 0.0
    for r in rows:
        d = max(r['end'] - r['start'], 1e-9)
        total += d
        ex += r['exec']
        agg.update(r['c'])
        pct = ' '.join(f"{k}={r['c'][k] / d * 100:.0f}" for k in KEYS)
        when = dt.datetime.fromtimestamp(r['start']).strftime('%m-%d %H:%M')
        print(f"{when} {d / 60:5.0f}m calls={r['calls']:4d} exec={r['exec'] / d * 100:3.0f}% "
              f"compact={r['compactions']} {pct} | {os.path.basename(r['cwd'])} | {r['title']}")
    if not rows:
        print('no turns')
        return
    s = sum(agg.values())
    print(f'TOTAL {len(rows)} turns, {total / 3600:.1f} h, tool exec {ex / total * 100:.0f}%')
    for k in KEYS:
        print(f'  {k:8s} {agg[k] / 3600:5.2f} h  {agg[k] / s * 100:3.0f}%')


if __name__ == '__main__':
    main()
