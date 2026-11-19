import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { diffEvals, formatEvalDiff, readEval, runEval } from '../src/eval.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { DEFAULT_MODEL } from '../src/types.js';

let cwd: string;
const header = "export const meta = { name: 'suite', description: 'eval fixture' };\n";
const scriptPath = 'workflow.js';
const casesPath = 'cases.json';

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'maestro-eval-')));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function script(body: string) {
  await writeFile(path.join(cwd, scriptPath), header + body);
}
async function cases(rows: unknown[]) {
  await writeFile(path.join(cwd, casesPath), JSON.stringify(rows));
}
async function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    cwd,
    env: {},
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  });
  return { code, stdout, stderr };
}

const runSuite = (runner = new FakeRunner()) => runEval({ cwd, scriptPath, casesPath, runner });

describe('native eval', () => {
  it('grades workflow results as JSON, keeps running after errors, and stores ordinary child run IDs', async () => {
    await script(`await agent('read'); if (args === 'error') throw new Error('case failed'); return args;`);
    await cases([
      { id: 'object', args: { b: 2, a: 1 }, expected: { a: 1, b: 2 } },
      { id: 'bad', args: 'error', expected: 1 },
      { id: 'mismatch', args: false, expected: 0 },
      { id: 'missing args', expected: null },
    ]);
    const report = await runSuite(
      new FakeRunner(() => ({ inputTokensPerTurn: 5, outputTokensPerTurn: 3, cacheReadTokensPerTurn: 15 })),
    );
    expect(report).toMatchObject({
      passed: 2,
      total: 4,
      hits: 0,
      calls: 4,
      tokens: 92,
      journalHitRatio: 0,
      promptCacheRatio: 0.75,
    });
    expect(report.cases.map((c) => c.status)).toEqual(['pass', 'fail', 'fail', 'pass']);
    expect(report.cases[1]!.error).toMatch(/case failed/);
    expect(report.cases[2]!.mismatch).toEqual({ expected: 0, actual: false });
    expect(await readEval(path.join(cwd, '.maestro'), report.id)).toEqual(report);
    for (const row of report.cases) {
      const outcome = JSON.parse(
        await readFile(path.join(cwd, '.maestro', 'runs', row.runId, 'outcome.json'), 'utf8'),
      );
      expect(outcome.ok).toBe(row.id !== 'bad');
    }
  });

  it('validates every case before running any, including duplicate IDs and missing expectations', async () => {
    await script(`return await agent('load');`);
    const runner = new FakeRunner();
    await cases([
      { id: 'same', expected: true },
      { id: 'same', expected: false },
    ]);
    await expect(runSuite(runner)).rejects.toThrow('duplicate eval case ID');
    await cases([{ id: 'good', expected: true }, { id: 'missing' }]);
    await expect(runSuite(runner)).rejects.toThrow('expected');
    await expect(readEval(cwd, '../escape')).rejects.toThrow('invalid eval ID');
    expect(runner.liveCalls).toBe(0);
  });

  it('aligns reordered, changed, added and removed fixtures, and computes token deltas', async () => {
    const firstCases = ['fixed', 'regressed', 'removed', 'changed'].map((id) => ({
      id,
      args: id,
      expected: true,
    }));
    await cases(firstCases);
    await script(`return args === 'regressed';`);
    const a = await runSuite();
    await cases([
      { id: 'added', expected: false },
      { ...firstCases[3], expected: false },
      firstCases[1],
      firstCases[0],
    ]);
    await script(`await agent('check'); return args === 'fixed';`);
    const b = await runSuite();
    const diff = diffEvals(a, b);
    expect(diff.delta).toEqual({ passed: 2, tokens: 600 });
    expect(Object.fromEntries(diff.cases.map((c) => [c.id, c.change]))).toEqual({
      fixed: 'fixed',
      regressed: 'regressed',
      removed: 'removed',
      changed: 'case changed',
      added: 'added',
    });
    expect(formatEvalDiff(diff)).toContain('1/4 → 3/4 (+2)');
    expect(formatEvalDiff(diff)).toContain('[CACHE HIT]: 0/0 (n/a) → 0/4 (0.0%)');
    expect(formatEvalDiff(diff)).toContain('Prompt cache: n/a → n/a');
  });

  it('charges a numeric budget once across all cases', async () => {
    await script(`return await agent('read');`);
    const row = { expected: 'fake result for: read' };
    await cases([
      { id: 'first', ...row },
      { id: 'second', ...row },
    ]);
    const runner = new FakeRunner();
    const report = await runEval({ cwd, scriptPath, casesPath, runner, budget: 5000 });
    expect(report.passed).toBe(1);
    expect(report.cases[1]?.error).toMatch(/budget exceeded/);
    expect(runner.liveCalls).toBe(1);
  });

  it('handles eval and diff at the CLI including CI exit codes and a custom state directory', async () => {
    await cases([{ id: 'sample', args: 'yes', expected: 'yes' }]);
    const argv = ['eval', scriptPath, '--cases', casesPath, '--dry-run', '--json', '--state-dir', 'state'];
    await script(`return 'no';`);
    const fail = await cli(...argv);
    expect(fail.code, fail.stderr).toBe(1);
    const a = JSON.parse(fail.stdout);
    expect(fail.stderr).toContain(`case "sample" run ${a.cases[0].runId}`);
    expect(a.cases[0]).toMatchObject({
      id: 'sample',
      status: 'fail',
      mismatch: { expected: 'yes', actual: 'no' },
    });
    await script(`return args;`);
    const pass = await cli(...argv);
    expect(pass.code, pass.stderr).toBe(0);
    const b = JSON.parse(pass.stdout);
    const result = await cli('eval', 'diff', a.id, b.id, '--state-dir', 'state');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('0/1 → 1/1');
    expect(result.stdout).toContain('fixed  "sample"');
    expect(result.stdout).toContain(b.cases[0].runId);
    const bad = await cli(...argv, '--resume', a.id);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--resume is not an eval option');
    const machine = await cli('eval', 'diff', a.id, b.id, '--state-dir', 'state', '--json');
    expect(JSON.parse(machine.stdout).cases[0]).toEqual({
      beforeRunId: a.cases[0].runId,
      afterRunId: b.cases[0].runId,
      id: 'sample',
      before: 'fail',
      after: 'pass',
      change: 'fixed',
    });
  });

  it('replays matching inputs against a baseline, reruns modified inputs, and excludes cache hits from tokens', async () => {
    const upstream = `const value = await agent('read ' + args, {label:'read'});`;
    const step = `await agent('check: ' + value, {label:'check'});`;
    await script(`${upstream}\n${step}\nreturn 'v1';`);
    await cases([
      { id: 'unchanged', args: 1, expected: 'v2' },
      { id: 'different args', args: 2, expected: 'v2' },
    ]);
    const a = await runEval({
      cwd,
      scriptPath,
      casesPath,
      runner: new FakeRunner(),
      model: 'baseline-model',
    });
    await script(`${upstream}\n${step}\nreturn 'v2';`);
    await cases([
      { id: 'unchanged', args: 1, expected: 'v2' },
      { id: 'different args', args: 3, expected: 'v2' },
      { id: 'new', args: 4, expected: 'v2' },
    ]);
    const runner = new FakeRunner();
    const b = await runEval({ cwd, scriptPath, casesPath, runner, baseline: a.id, from: 'check' });
    expect(runner.calls.every((request) => request.model === DEFAULT_MODEL)).toBe(true);
    expect(runner.calls.map((r) => r.prompt)).toEqual([
      'check: fake result for: read 1',
      'read 3',
      'check: fake result for: read 3',
      'read 4',
      'check: fake result for: read 4',
    ]);
    expect(b).toMatchObject({ passed: 3, total: 3, calls: 6, hits: 1, tokens: 750, journalHitRatio: 1 / 6 });
    expect(await readEval(path.join(cwd, '.maestro'), a.id)).toEqual(a);
  });
});
