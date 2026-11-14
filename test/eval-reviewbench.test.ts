// The ReviewBench A/B tooling (eval/reviewbench, docs/eval.md 10): task loading, the judging-input
// adapter, the cell order, the checkout that ends at the PR's head, the A and C arm workflows and the
// report. FakeRunner and temp git repos only; never the network.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARMS,
  armResult,
  type BenchTask,
  type CellRow,
  cells,
  type JudgeResults,
  loadTasks,
  paired,
  prKey,
  reportMarkdown,
  summarize,
  toJudgingInput,
} from '../eval/reviewbench/bench.js';
import { prepareTask } from '../eval/reviewbench/prepare.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-rb-test-'));
  dirs.push(d);
  return d;
}
const root = fileURLToPath(new URL('..', import.meta.url));
const sha = (c: string) => c.repeat(40);
const task = (n: number, over: Partial<BenchTask> = {}): BenchTask => ({
  repo: `https://github.com/o/r${n}`,
  nwo: `o/r${n}`,
  pr_number: n,
  base: sha('a'),
  head: `${String(n).padStart(8, '0')}${'b'.repeat(32)}`,
  title: `t${n}`,
  ...over,
});

describe('tasks and cells', () => {
  it('prKey is the benchmark name: owner_repo_number-head8', () => {
    expect(
      prKey({
        nwo: 'PierreJanineh/TechDebtMCP',
        pr_number: 135,
        head: '16a54f0f85a9091f220418850eac6b4122782be5',
      }),
    ).toBe('PierreJanineh_TechDebtMCP_135-16a54f0f');
  });

  it('loadTasks reads the test set and refuses a row without full SHAs', async () => {
    const bench = await tmp();
    await mkdir(path.join(bench, 'corpus', 'test'), { recursive: true });
    const file = path.join(bench, 'corpus', 'test', 'test.json');
    await writeFile(file, JSON.stringify([task(1), task(2)]));
    expect(loadTasks(bench).map((t) => t.pr_number)).toEqual([1, 2]);
    await writeFile(file, JSON.stringify([task(1), task(2, { head: 'abc123' })]));
    expect(() => loadTasks(bench)).toThrow(/test\.json\[1\]/);
    await writeFile(file, '[]');
    expect(() => loadTasks(bench)).toThrow(/no tasks/);
  });

  it('cells are every PR × arm × repeat once, in an order the seed fixes', () => {
    const tasks = [task(1), task(2), task(3)];
    const a = cells(tasks, ['A', 'B'], 3, 7);
    expect(a).toHaveLength(18);
    expect(new Set(a.map((c) => c.id)).size).toBe(18);
    expect(a.map((c) => c.id)).toEqual(cells(tasks, ['A', 'B'], 3, 7).map((c) => c.id));
    expect(a.map((c) => c.id)).not.toEqual(cells(tasks, ['A', 'B'], 3, 8).map((c) => c.id));
    // Not arm by arm: the first six cells are not all one arm.
    expect(new Set(a.slice(0, 6).map((c) => c.arm)).size).toBe(2);
    expect(a[0]!.id).toMatch(/^[AB]-r[123]-o_r\d_\d-\d{8}$/);
  });
});

describe('findings for the judge', () => {
  it('maps file, line and message, normalizes paths and drops rows the judge would refuse', () => {
    const { input, dropped } = toJudgingInput(
      task(5),
      'maestro-B',
      [
        { file: './src/a.ts', line: 12, claim: 'Off by one.', failure: 'Empty list.' },
        { file: 'src\\win\\b.ts', line: 3, claim: 'Null deref.', failure: '' },
        { file: '', line: 3, claim: 'no file', failure: 'x' },
        { file: 'c.ts', line: 0, claim: 'no line', failure: 'x' },
        { file: 'd.ts', line: 2, claim: '', failure: '' },
      ],
      { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4, cost_usd: 0.5 },
    );
    expect(dropped).toBe(3);
    expect(input).toEqual({
      pr: { repo: 'https://github.com/o/r5', pr_number: 5, base: sha('a'), head: task(5).head },
      agent: 'maestro-B',
      findings: [
        {
          producer: 'maestro-B',
          file: 'src/a.ts',
          start_line: 12,
          end_line: 12,
          message: 'Off by one. Empty list.',
        },
        { producer: 'maestro-B', file: 'src/win/b.ts', start_line: 3, end_line: 3, message: 'Null deref.' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, cached_tokens: 4, cost_usd: 0.5 },
    });
    expect(toJudgingInput(task(5), 'x', []).input.findings).toEqual([]);
  });

  it('an arm that produced no review is failed, an empty review is not', () => {
    expect(armResult(null)).toEqual({ findings: [], failed: true });
    expect(armResult({ findings: [], failed: true }).failed).toBe(true);
    expect(armResult('text').failed).toBe(true);
    expect(armResult({ findings: [] })).toEqual({ findings: [], failed: false });
  });
});

describe('prepareTask', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  it('checks out the head with nothing after it: no remote, no refs, the fix commit is not there', async () => {
    const upstream = await tmp();
    git(upstream, 'init', '-q', '-b', 'main');
    git(upstream, 'config', 'user.email', 't@example.com');
    git(upstream, 'config', 'user.name', 'T');
    git(upstream, 'config', 'commit.gpgsign', 'false');
    git(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const commit = async (name: string, text: string) => {
      await writeFile(path.join(upstream, name), text);
      git(upstream, 'add', '-A');
      git(upstream, 'commit', '-q', '-m', name);
      return git(upstream, 'rev-parse', 'HEAD');
    };
    const base = await commit('a.txt', 'base\n');
    const head = await commit('b.txt', 'the pull request\n');
    const fix = await commit('b.txt', 'the later fix\n');

    const work = await tmp();
    const t = task(1, { base, head });
    const dir = prepareTask(t, path.join(work, 'repo'), [upstream]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('the pull request\n');
    expect(git(dir, 'diff', '--stat', `${base}...${head}`)).toContain('b.txt');
    expect(git(dir, 'remote')).toBe('');
    expect(git(dir, 'for-each-ref')).toBe('');
    expect(existsSync(path.join(dir, '.git', 'FETCH_HEAD'))).toBe(false);
    expect(git(dir, 'log', '--all', '--format=%H').split('\n').sort()).toEqual([base, head].sort());
    expect(() => git(dir, 'cat-file', '-e', `${fix}^{commit}`)).toThrow();

    // A second call reuses the checkout; a half-made directory is rebuilt.
    await writeFile(path.join(dir, 'marker'), 'kept');
    expect(prepareTask(t, dir, ['/nonexistent'])).toBe(dir);
    expect(existsSync(path.join(dir, 'marker'))).toBe(true);
    const half = path.join(work, 'half');
    await mkdir(half);
    git(half, 'init', '-q');
    expect(git(prepareTask(t, half, [upstream]), 'rev-parse', 'HEAD')).toBe(head);
  });

  it('fails with the PR named when no source has the commits, and leaves no directory', async () => {
    const work = await tmp();
    const dir = path.join(work, 'repo');
    expect(() => prepareTask(task(9), dir, [path.join(work, 'missing')])).toThrow(/o\/r9#9/);
    expect(existsSync(dir)).toBe(false);
  });
});

describe('arm workflows', () => {
  const script = (arm: string) => readFileSync(path.join(root, ARMS[arm]!.script), 'utf8');
  const finding = (file: string, line: number) => ({ file, line, claim: `c ${file}`, failure: 'f' });

  it('A is one agent with the default read-only tools; a null agent is a failed review', async () => {
    const dir = await tmp();
    const runner = new FakeRunner(() => ({ result: { findings: [finding('a.ts', 1)] } }));
    const value = await run({ cwd: dir, runner, script: script('A'), args: { diffRef: 'x...y' } }).promise;
    expect(armResult(value)).toEqual({ findings: [finding('a.ts', 1)], failed: false });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.prompt).toContain('"git diff x...y"');
    expect(runner.calls[0]!.tools.map((t) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash']);
    expect(runner.calls[0]!.schema).toBeDefined();

    const dead = await run({
      cwd: await tmp(),
      runner: new FakeRunner(() => ({ result: null, status: 'null' })),
      script: script('A'),
      args: { diffRef: 'x...y' },
    }).promise;
    expect(armResult(dead).failed).toBe(true);
  });

  it('C runs the three finder prompts of review-changes, merges them and drops a repeated file:line', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req) => ({
      result: req.prompt.includes('güvenlik')
        ? { findings: [finding('s.ts', 2), finding('shared.ts', 9)] }
        : req.prompt.includes('Veri kaybı')
          ? null
          : { findings: [finding('c.ts', 1), finding('shared.ts', 9)] },
      ...(req.prompt.includes('Veri kaybı') ? { status: 'null' as const } : {}),
    }));
    const value = await run({ cwd: dir, runner, script: script('C'), args: { diffRef: 'x...y' } }).promise;
    const { findings, failed } = armResult(value);
    expect(failed).toBe(false);
    expect(findings.map((f) => `${f.file}:${f.line}`).sort()).toEqual(['c.ts:1', 's.ts:2', 'shared.ts:9']);
    expect(runner.calls).toHaveLength(3);
    // The finder prompts are the ones B uses, word for word.
    const b = script('B');
    for (const call of runner.calls) {
      const own = call.prompt.slice(call.prompt.indexOf('oku.') + 5);
      expect(b, own).toContain(own);
    }

    const allDead = await run({
      cwd: await tmp(),
      runner: new FakeRunner(() => ({ result: null, status: 'null' })),
      script: script('C'),
      args: { diffRef: 'x...y' },
    }).promise;
    expect(armResult(allDead).failed).toBe(true);
  });
});

describe('report', () => {
  const metrics = (p: number | null, r: number | null, n = 4) => ({
    grounded_precision: p,
    grounded_recall: r,
    candidate_count: n,
  });
  const results = (p: number, r: number, perPr: Record<string, number | null>): JudgeResults => ({
    micro: {
      overall: metrics(p, r),
      by_severity: { high: metrics(p, r / 2) },
      by_category: { correctness: metrics(p, r), security: metrics(p, null) },
    },
    macro: { overall: metrics(p, r), by_severity: {}, by_category: {} },
    pr_count: Object.keys(perPr).length,
    per_pr: Object.entries(perPr).map(([pr_key, rec]) => ({
      pr_key,
      metrics: { overall: metrics(p, rec), by_severity: {}, by_category: {} },
    })),
  });
  const scores = [
    { arm: 'A', repeat: 1, results: results(0.5, 0.2, { p1: 0.2, p2: 0.4, p3: null, p4: 0.5 }) },
    { arm: 'A', repeat: 2, results: results(0.7, 0.4, { p1: 0.4, p2: 0.4, p3: null, p4: 0.5 }) },
    { arm: 'B', repeat: 1, results: results(0.8, 0.6, { p1: 0.6, p2: 0.2, p3: null, p4: 0.5 }) },
  ];
  const rows: CellRow[] = [
    { id: 'A-r1-p1', arm: 'A', repeat: 1, pr: 'p1', status: 'failed', dollars: 0.1 },
    { id: 'A-r1-p1', arm: 'A', repeat: 1, pr: 'p1', status: 'ok', dollars: 0.2, findings: 2 }, // the retry wins
    { id: 'A-r1-p2', arm: 'A', repeat: 1, pr: 'p2', status: 'ok', dollars: 0.4, findings: 4 },
    { id: 'B-r1-p1', arm: 'B', repeat: 1, pr: 'p1', status: 'ok', dollars: 3, findings: 6 },
    { id: 'B-r1-p2', arm: 'B', repeat: 1, pr: 'p2', status: 'failed', dollars: 1 },
  ];

  it('summarize averages the repeats and takes cost and failures from the last row of each cell', () => {
    const [a, b] = summarize(scores, rows);
    expect(a).toMatchObject({ arm: 'A', repeats: 2, cellsOk: 2, cellsFailed: 0, findingsPerPr: 3 });
    expect(a!.precision).toBeCloseTo(0.6);
    expect(a!.recall).toBeCloseTo(0.3);
    expect(a!.dollarsPerPr).toBeCloseTo(0.3);
    expect(a!.recallHigh).toBeCloseTo(0.15);
    expect(a!.recallSecurity).toBeNull();
    expect(a!.f1Range![0]).toBeCloseTo((2 * 0.5 * 0.2) / 0.7);
    expect(a!.f1Range![1]).toBeCloseTo((2 * 0.7 * 0.4) / 1.1);
    expect(b).toMatchObject({ arm: 'B', repeats: 1, cellsOk: 1, cellsFailed: 1, findingsPerPr: 6 });
    expect(b!.dollarsPerPr).toBeCloseTo(2); // the failed cell's dollar counts
  });

  it('paired compares per-PR recall and leaves out a PR without one', () => {
    const p = paired(scores, 'A', 'B');
    // p1: A (0.2+0.4)/2 = 0.3 vs B 0.6; p2: A 0.4 vs B 0.2; p3 has no recall; p4 level.
    expect(p).toMatchObject({ prs: 3, bAhead: 1, aAhead: 1, level: 1 });
    expect(p.meanDiff).toBeCloseTo((0.3 - 0.2 + 0) / 3);
  });

  it('the report is one table row per arm and one sentence per pair', () => {
    const md = reportMarkdown(summarize(scores, rows), [{ a: 'A', b: 'B', p: paired(scores, 'A', 'B') }]);
    expect(md).toContain('| A tek ajan | 2 | 60.0% | 30.0% |');
    expect(md).toContain('| B review-changes | 1 | 80.0% | 60.0% |');
    expect(md).toContain('| – |'); // security recall the judge did not have
    expect(md).toContain('B önde 1, A önde 1, eşit 1');
  });
});
