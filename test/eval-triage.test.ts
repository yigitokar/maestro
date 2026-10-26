// eval/workflows/triage.js through run() with FakeRunner (one agent per candidate, fix cap, null agent,
// acceptance log), eval/review.ts (bugs deduped across fixes, review order, sheet, decisions to the set)
// and eval/materialize.ts on a real temporary repo (nothing after the commit is reachable). Never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { materialize } from '../eval/materialize.js';
import type { MineResult } from '../eval/mine.js';
import {
  cleanRecord,
  distinctBugs,
  type Labels,
  labelsSkeleton,
  pickClean,
  pickSet,
  reviewOrder,
  reviewSheet,
  SEED,
  type SetRecord,
  type TriageReport,
  type TriageRow,
} from '../eval/review.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { RunRequest, WorkflowEvent } from '../src/types.js';
import { run } from '../src/workflow.js';

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const script = readFileSync(fileURLToPath(new URL('../eval/workflows/triage.js', import.meta.url)), 'utf8');

const sha = (n: number) => n.toString(16).padStart(40, '0');
const fix = (n: number) => ({
  sha: sha(n),
  subject: `fix: ${n}`,
  date: '',
  kinds: ['modified' as const],
  gapDays: n,
});
const candidate = (id: string, pr: number | null, fixes: number[]) => ({
  id,
  pr,
  merge: sha(9000 + fixes[0]!),
  base: sha(8000 + fixes[0]!),
  lines: 40,
  files: 2,
  kind: 'modified' as const,
  fixes: fixes.map(fix),
});

/** Verdict for every SHA in the prompt; the first one is a bug unless `none`. */
function verdict(req: RunRequest, none = false) {
  const shas = [...req.prompt.matchAll(/^- ([0-9a-f]{40}) /gm)].map((m) => m[1]!);
  return {
    fixes: shas.map((s, i) => ({
      sha: s,
      defect: !none && i === 0,
      introducedHere: !none && i === 0,
      visibleFromDiff: !none && i === 0,
      reason: 'test',
      bugs: !none && i === 0 ? [{ file: 'a.ts', line: 3, description: 'd', trigger: 't' }] : [],
    })),
  };
}

describe('triage workflow', () => {
  it('asks one agent per candidate with its fixes and returns verdicts by id', async () => {
    const cwd = await tmp('maestro-triage-');
    const runner = new FakeRunner([
      { match: 'PR #3', respond: { result: null, status: 'null', error: 'api error' } },
      { match: 'PR #2', respond: (req) => ({ result: verdict(req, true) }) },
      { match: 'etiketleme', respond: (req) => ({ result: verdict(req) }) },
    ]);
    const candidates = [
      candidate('r-1', 1, [1, 2]),
      candidate('r-2', 2, [3]),
      candidate('r-3', 3, [4]),
      candidate(
        'r-x',
        null,
        Array.from({ length: 10 }, (_, i) => 10 + i),
      ),
    ];
    const handle = run({ script, args: { candidates }, cwd, stateDir: path.join(cwd, 'state'), runner });
    const logs: string[] = [];
    handle.events.on('log', (e: WorkflowEvent & { type: 'log' }) => logs.push(e.message));
    const results = (await handle.promise) as { id: string; triage: ReturnType<typeof verdict> | null }[];

    expect(results.map((r) => r.id)).toEqual(['r-1', 'r-2', 'r-3', 'r-x']);
    expect(results[0]!.triage!.fixes.map((f) => f.sha)).toEqual([sha(1), sha(2)]);
    expect(results[2]!.triage).toBeNull();
    expect(results[3]!.triage!.fixes).toHaveLength(8); // capped, nearest to the merge first

    const req = runner.calls.find((c) => c.prompt.includes('PR #1'))!;
    expect(req.prompt).toContain(`"git diff ${sha(8001)} ${sha(9001)}"`);
    expect(req.prompt).toContain(`"git show ${sha(9001)}:<dosya>"`);
    expect(req.effort).toBe('medium');
    expect(runner.calls.find((c) => c.prompt.includes('merge 000000000'))).toBeDefined();
    expect(logs).toContain("r-x: 10 fix'ten ilk 8'i soruluyor");
    expect(logs).toContain('2/4 aday kabul edildi, 1 null');
  });

  it('passes args.effort and an empty list through', async () => {
    const cwd = await tmp('maestro-triage-');
    const runner = new FakeRunner([{ match: 'etiketleme', respond: (req) => ({ result: verdict(req) }) }]);
    const opts = { cwd, stateDir: path.join(cwd, 'state'), runner };
    await run({ script, args: { candidates: [candidate('r-1', 1, [1])], effort: 'high' }, ...opts }).promise;
    expect(runner.calls[0]!.effort).toBe('high');
    expect(await run({ script, args: { candidates: [] }, ...opts }).promise).toEqual([]);
  });
});

describe('materialize', () => {
  it('holds the commit and its ancestors only', async () => {
    const src = await tmp('maestro-materialize-src-');
    git(src, 'init', '-q', '-b', 'main');
    git(src, 'config', 'user.name', 'Test');
    git(src, 'config', 'user.email', 'test@example.com');
    for (const n of [1, 2, 3]) {
      await writeFile(path.join(src, 'f.txt'), `${n}\n`);
      git(src, 'add', '-A');
      git(src, 'commit', '-q', '-m', `c${n}`);
    }
    const [c3, c2, c1] = git(src, 'log', '--format=%H').split('\n');
    const dir = path.join(await tmp('maestro-materialize-'), 'cell');

    expect(materialize(src, c2!, dir)).toBe(dir);
    expect(git(dir, 'log', '--all', '--format=%H').split('\n')).toEqual([c2, c1]);
    expect(() => git(dir, 'cat-file', '-t', c3!)).toThrow();
    expect(git(dir, 'for-each-ref')).toBe('');
    expect(git(dir, 'remote')).toBe('');
    expect(existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('2\n');

    expect(materialize(src, c2!, dir)).toBe(dir); // reused
    expect(() => materialize(src, c3!, dir)).toThrow(/another commit/);
  });
});

describe('review sheet', () => {
  const bug = (line: number) => ({ file: 'a.ts', line, description: `d${line}`, trigger: 't' });
  const fixOf = (n: number, keep: boolean, lines: number[]) => ({
    sha: sha(n),
    defect: true,
    introducedHere: keep,
    visibleFromDiff: true,
    reason: `r${n}`,
    bugs: lines.map(bug),
  });
  const row = (id: string, lines: number, fixes: ReturnType<typeof fixOf>[] | null): TriageRow => ({
    ...candidate(id, 1, [1]),
    kind: 'modified' as const,
    fixes: [fix(1)],
    mergedAt: '2026-06-12T00:00:00.000Z',
    subject: 'Merge',
    lines,
    triage: fixes && { fixes },
  });

  it('merges one bug reported by several fixes and ignores rejected fixes', () => {
    const r = row('r-1', 40, [fixOf(1, true, [3]), fixOf(2, true, [3, 9]), fixOf(3, false, [12])]);
    expect(distinctBugs(r)).toEqual([
      { ...bug(3), fixes: [sha(1), sha(2)] },
      { ...bug(9), fixes: [sha(2)] },
    ]);
  });

  it('splits accepted from rejected and lists the clean pool', () => {
    const triage: TriageReport = {
      runId: 'run-1',
      model: 'm',
      effort: 'medium',
      summary: { dollars: 1.5 },
      results: [
        row('r-big', 500, [fixOf(1, true, [3])]),
        row('r-no', 20, [fixOf(2, false, [])]),
        row('r-null', 30, null),
      ],
    };
    const clean = {
      id: 'r-c',
      pr: 9,
      merge: sha(9),
      lines: 50,
      added: 4,
      surviving: 3,
      mergedAt: '2026-01-01',
      subject: 's',
    };
    const mined = { clean: [clean] } as unknown as MineResult;
    const md = reviewSheet(triage, mined);
    expect(md).toContain(
      '3 aday, 1 kabul (≤200: 0, 201-800: 1, 801-2000: 0), 0 önceki turda kabul edilmişti, 1 null',
    );
    expect(md).toContain('## 1: 201–800 satır');
    expect(md).toContain('### 1. r-big: #1, 500 satır, 2 dosya\n');
    expect(md).toContain('## Reddedilenler (2)');
    expect(md).not.toContain('bu turda red');
    expect(md).toContain('| r-null | 30 | fix: 1 | null (ajan sonuç vermedi) |');
    expect(md).toContain('| r-c | 50 | <=200 | 75% (3/4) |');

    // An earlier round accepted r-no on fixes 2 and 5: it moves out of the rejected table into the order
    // (first, being small) with the earlier bugs, and each of those fixes shows this round's verdict on the
    // same SHA (5 was not asked this time).
    const earlier: TriageReport = {
      ...triage,
      results: [row('r-no', 20, [fixOf(2, true, [7]), fixOf(5, true, [8])])],
    };
    const md2 = reviewSheet(triage, mined, earlier);
    expect(md2).toContain('1 önceki turda kabul edilmişti');
    expect(md2).toContain('## 1: ≤200 satır');
    expect(md2).toContain('### 1. r-no: #1, 20 satır, 2 dosya (önceki turda kabul, bu turda red)');
    expect(md2).toContain('### 2. r-big:');
    expect(md2).toContain('- `a.ts:7` d7');
    expect(md2).toContain('`: kusur / - / görülür, r2');
    expect(md2).toContain('`: sorulmadı (8 fix sınırı ya da null)');
    expect(md2).toContain('## Reddedilenler (1)');
  });

  const report = (results: TriageRow[]): TriageReport => ({
    runId: 'r',
    model: 'm',
    effort: 'e',
    summary: {},
    results,
  });

  it('orders small candidates by size, then each larger group shuffled by the seed', () => {
    const sizes = { s1: 150, s2: 30, m1: 300, m2: 400, m3: 500, m4: 600, m5: 700, b1: 900, b2: 1000 };
    const rows = Object.entries(sizes).map(([id, lines]) => row(id, lines, [fixOf(1, true, [3])]));
    const ids = (seed = SEED, results = rows) =>
      reviewOrder(report(results), undefined, seed).map((i) => i.row.id);

    const order = ids();
    expect(order.slice(0, 2)).toEqual(['s2', 's1']);
    expect(order.slice(2, 7).sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(order.slice(7).sort()).toEqual(['b1', 'b2']);
    expect(ids(SEED, [...rows].reverse())).toEqual(order); // independent of input order
    expect(ids(1)).not.toEqual(order);
    expect(reviewOrder(report(rows)).map((i) => [i.order, i.group])[2]).toEqual([3, '201-800']);
  });

  it('writes undecided labels and takes accepted candidates in order up to the target', () => {
    const a = { ...row('a', 10, [fixOf(1, true, [3]), fixOf(2, true, [3, 9])]) };
    a.fixes = [fix(1), { ...fix(2), kinds: ['sql_fn' as const, 'added' as const] }];
    const rows = [a, row('b', 20, [fixOf(1, true, [4])]), row('c', 30, [fixOf(1, true, [5])])];
    const labels: Labels = labelsSkeleton(
      reviewOrder(report([...rows, row('d', 40, [fixOf(1, true, [6])])])),
      'lula',
    );
    expect(labels.candidates.map((c) => [c.order, c.id, c.decision])).toEqual([
      [1, 'a', null],
      [2, 'b', null],
      [3, 'c', null],
      [4, 'd', null],
    ]);
    expect(labels.candidates[0]!.bugs).toEqual([
      { ...bug(3), fix: sha(1), link: 'modified' },
      { ...bug(9), fix: sha(2), link: 'sql_fn+added' },
    ]);

    labels.target = 2;
    expect(pickSet(labels)).toMatchObject({ set: [], rejected: 0, next: { id: 'a' } });
    labels.candidates[0]!.decision = 'accept';
    labels.candidates[1]!.decision = 'reject';
    let picked = pickSet(labels);
    expect(picked).toMatchObject({ rejected: 1, next: { id: 'c' } });
    expect(picked.set).toEqual([
      {
        id: 'a',
        repo: 'lula',
        merge: sha(9001),
        base: sha(8001),
        kind: 'bug',
        lines: 10,
        bugs: [
          { id: 'a-a', ...bug(3), fix: sha(1), link: 'modified' },
          { id: 'a-b', ...bug(9), fix: sha(2), link: 'sql_fn+added' },
        ],
      },
    ]);
    labels.candidates[2]!.decision = 'accept';
    picked = pickSet(labels);
    expect(picked.set.map((r) => r.id)).toEqual(['a', 'c']); // complete: d is never needed
    expect(picked.next).toBeNull();

    labels.candidates[2]!.bugs = [];
    expect(() => pickSet(labels)).toThrow(/c: accepted without a bug/);
    labels.candidates[2]!.decision = 'kabul' as never;
    expect(() => pickSet(labels)).toThrow(/decision must be/);
  });
});

describe('clean picks', () => {
  const clean = (id: string, lines: number, surviving: number) => ({
    id,
    pr: 1,
    merge: sha(1),
    base: sha(2),
    lines,
    files: 1,
    added: 10,
    surviving,
    mergedAt: '2026-01-01',
    subject: 's',
  });
  const bugRecord = (lines: number): SetRecord => ({
    id: `b${lines}`,
    repo: 'lula',
    merge: sha(3),
    base: sha(4),
    kind: 'bug',
    lines,
    bugs: [],
  });

  it('follows the bug set size split by survival, for the set and then the pilot', () => {
    const pool = [
      clean('s1', 50, 10),
      clean('s2', 60, 5),
      clean('s3', 70, 10),
      clean('s4', 80, 9),
      clean('m1', 300, 10),
      clean('m2', 400, 8),
      clean('m3', 500, 10),
      clean('m4', 600, 6),
      clean('m5', 700, 9),
      clean('m6', 750, 1),
    ];
    // 1 small and 3 mid bug PRs: 5 x 1/4 = 1.25 and 5 x 3/4 = 3.75, the larger remainder rounds up.
    const picked = pickClean(pool, [bugRecord(100), bugRecord(300), bugRecord(400), bugRecord(500)]);
    const ids = picked.set.map((c) => c.id);
    expect(ids).toHaveLength(5);
    expect(ids.slice(1, 3).sort()).toEqual(['m1', 'm3']); // the survival tie, in seed order
    expect(ids.slice(3)).toEqual(['m5', 'm2']);
    expect(['s1', 's3']).toContain(ids[0]);
    // The pilot's 2 split 0.5 / 1.5: the tied remainders go to the smaller group first.
    expect(picked.pilot.map((c) => c.id)).toEqual([ids[0] === 's1' ? 's3' : 's1', 'm4']);
    expect(pickClean(pool, [bugRecord(100), bugRecord(300), bugRecord(400), bugRecord(500)])).toEqual(picked);
    expect(cleanRecord(pool[0]!, 'lula')).toEqual({
      id: 's1',
      repo: 'lula',
      merge: sha(1),
      base: sha(2),
      kind: 'clean',
      lines: 50,
      bugs: [],
    });
  });

  it('passes a short group share to the best of the rest', () => {
    const pool = [clean('s1', 50, 10), clean('s2', 60, 9), clean('s3', 70, 8), clean('m1', 300, 1)];
    const picked = pickClean(pool, [bugRecord(300)], 3, 0);
    expect(picked.set.map((c) => c.id)).toEqual(['m1', 's1', 's2']);
    expect(picked.pilot).toEqual([]);
  });

  it('never picks a PR without added lines and caps survival at 1', () => {
    const empty = { ...clean('s0', 40, 0), added: 0 };
    const over = clean('s9', 45, 30); // 30 of 10: blame credits more than was added
    const picked = pickClean([empty, over, clean('s1', 50, 10), clean('s2', 60, 9)], [bugRecord(50)], 3, 0);
    expect(picked.set.map((c) => c.id).sort()).toEqual(['s1', 's2', 's9']);
    expect(picked.set[2]!.id).toBe('s2'); // s9 and s1 tie at 100%
  });
});
