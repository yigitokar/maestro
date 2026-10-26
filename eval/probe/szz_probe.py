"""Feasibility probe: how many (bug-introducing PR, later fix) pairs does a plain SZZ pass find?
Usage: python3 szz_probe.py <repo> <mainref>"""
import json, re, subprocess, sys
from collections import defaultdict

repo, main = sys.argv[1], sys.argv[2]

def git(*a):
    return subprocess.run(['git', '-C', repo, *a], capture_output=True, text=True).stdout

FIX_RE = re.compile(r'^(fix|hotfix)\b|\bfix(es|ed)?\b|\bbug\b|regression', re.I)

# First-parent merges on main = PRs. Map every PR commit -> merge.
merges = []
for line in git('log', '--first-parent', '--merges', '--format=%H %ct %s', main).splitlines():
    sha, ct, subj = line.split(' ', 2)
    m = re.search(r'#(\d+)', subj)
    merges.append({'sha': sha, 't': int(ct), 'pr': int(m.group(1)) if m else None, 'subj': subj})
owner = {}
for m in merges:
    for c in git('rev-list', f'{m["sha"]}^1..{m["sha"]}^2').split():
        owner.setdefault(c, m['sha'])
by_sha = {m['sha']: m for m in merges}

# Fix commits reachable from main (inside PRs or direct).
fixes = []
for line in git('log', '--no-merges', '--format=%H %ct %s', main).splitlines():
    sha, ct, subj = line.split(' ', 2)
    if FIX_RE.search(subj):
        fixes.append({'sha': sha, 't': int(ct), 'subj': subj})

HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+')
SKIP = re.compile(r'(\.lock$|lock\.json$|\.md$|\.snap$|\.sql$)')
FN_RE = re.compile(r'create\s+or\s+replace\s+function\s+(?:public\.)?"?(\w+)"?', re.I)

def blame(rev, path, a, b):
    out = git('blame', '-l', '-s', '-L', f'{a},{b}', rev, '--', path)
    return {x.split()[0].lstrip('^') for x in out.splitlines() if x.strip()}

# Last migration commit (on main) defining each SQL function, in commit order.
sql_defs = []  # (commit time, commit, fn)
for line in git('log', '--format=COMMIT %H %ct', '-p', '--diff-filter=A', main, '--', '*.sql').splitlines():
    if line.startswith('COMMIT '):
        sha, ct = line[7:].split()
    elif line.startswith('+'):
        sql_defs += [(int(ct), sha, fn.lower()) for fn in FN_RE.findall(line)]

pairs = defaultdict(lambda: defaultdict(set))  # merge sha -> link kind -> {fix}
for f in fixes:
    diff = git('diff', '-U0', '--no-renames', f'{f["sha"]}^', f['sha'])
    path = None
    intro = defaultdict(set)  # kind -> introducing commits
    for l in diff.splitlines():
        if l.startswith('--- '):
            path = None if l == '--- /dev/null' else l[6:]
        elif l.startswith('+++ ') and l.endswith('.sql'):
            path = None
        elif path and not SKIP.search(path) and (h := HUNK.match(l)):
            start, n = int(h.group(1)), int(h.group(2) or 1)
            if n > 0:
                intro['modified'] |= blame(f'{f["sha"]}^', path, start, start + n - 1)
            elif start > 0:
                # Pure addition after line `start`: blame the neighbours (missing-guard class).
                intro['added'] |= blame(f'{f["sha"]}^', path, start, start)
        elif l.startswith('+') and not l.startswith('+++'):
            # New migration redefining a function: link to the commit that last defined it.
            for fn in FN_RE.findall(l):
                prev = [c for t, c, g in sql_defs if g == fn.lower() and t < f['t']]
                if prev:
                    intro['sql_fn'].add(prev[-1])
    fix_owner = owner.get(f['sha'])
    for kind, commits in intro.items():
        for c in commits:
            m = owner.get(c)
            if not m or m == fix_owner:
                continue  # direct commit to main, or bug fixed inside its own PR
            if f['t'] - by_sha[m]['t'] < 86400:
                continue  # fixed within a day: probably not "found later"
            pairs[m][kind].add(f['sha'])

def size(m):
    s = git('diff', '--shortstat', f'{m}^1', m)
    nums = [int(x) for x in re.findall(r'(\d+) (?:insertion|deletion)', s)]
    return sum(nums)

def bucket(n):
    return '<=200' if n <= 200 else '201-800' if n <= 800 else '801-2000' if n <= 2000 else '>2000'

rows = []
for m, kinds in pairs.items():
    # Strongest link wins: modified lines > SQL function redefinition > neighbour of an addition.
    kind = next(k for k in ('modified', 'sql_fn', 'added') if k in kinds)
    rows.append({'pr': by_sha[m]['pr'], 'merge': m[:9], 'lines': size(m), 'kind': kind,
                 'fixes': len(set().union(*kinds.values()))})
table = defaultdict(lambda: defaultdict(int))
for r in rows:
    table[r['kind']][bucket(r['lines'])] += 1
tip = max(m['t'] for m in merges)
old_untouched = [m for m in merges if m['sha'] not in pairs and tip - m['t'] >= 90 * 86400]
print(json.dumps({
    'merges': len(merges), 'fix_commits': len(fixes), 'sql_function_defs': len(sql_defs),
    'prs_with_later_fix': len(rows), 'by_link_kind_and_size': table,
    'untraced_prs_merged_90d_before_tip': len(old_untouched),
    'prs_with_any_link': {k: sum(1 for v in pairs.values() if k in v) for k in ('modified', 'sql_fn', 'added')},
    'known_fix_2a877f1a': [{'pr': by_sha[m]['pr'], 'kinds': sorted(k for k, s in v.items() if any(x.startswith('2a877f1a') for x in s))}
                           for m, v in pairs.items() if any(x.startswith('2a877f1a') for s in v.values() for x in s)],
    'sample_small': sorted(rows, key=lambda r: r['lines'])[:6],
}, indent=1))
