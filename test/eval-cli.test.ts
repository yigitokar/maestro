import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import {
  diffEvalRecords,
  diffEvalRuns,
  estimateCostUsd,
  evaluateExpectation,
  formatEvalDiff,
  loadEvalCases,
  runEval,
} from '../src/eval.js';
import { RoutingRunner } from '../src/routing-runner.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-eval-cli-'));
  dirs.push(d);
  return d;
}

describe('eval helpers', () => {
  it('loads JSON arrays, { cases } objects, and JSONL files while rejecting duplicate IDs', async () => {
    const dir = await tmp();
    const jsonl = path.join(dir, 'cases.jsonl');
    await writeFile(jsonl, '{"id":"c1","args":{"x":1}}\n{"id":"c2","args":{"x":2}}\n');
    expect((await loadEvalCases(jsonl)).map((c) => c.id)).toEqual(['c1', 'c2']);

    const wrapped = path.join(dir, 'wrapped.json');
    await writeFile(wrapped, JSON.stringify({ cases: [{ id: 'a', expected: 1 }] }));
    expect((await loadEvalCases(wrapped)).map((c) => c.id)).toEqual(['a']);

    const dup = path.join(dir, 'dup.json');
    await writeFile(dup, JSON.stringify([{ id: 'same' }, { id: 'same' }]));
    await expect(loadEvalCases(dup)).rejects.toThrow(/duplicate eval case id "same"/);
  });

  it('evaluates declarative expectations (equals, match, contains, notContains, regex)', () => {
    expect(evaluateExpectation({ equals: { ok: true } }, { ok: true }).pass).toBe(true);
    expect(evaluateExpectation({ match: { status: 'ok' } }, { status: 'ok', extra: 42 }).pass).toBe(true);
    expect(evaluateExpectation({ contains: ['alpha', 'beta'] }, 'alpha and beta').pass).toBe(true);
    expect(evaluateExpectation({ notContains: 'ERROR' }, 'all good').pass).toBe(true);
    expect(evaluateExpectation({ regex: '^v\\d+\\.\\d+$' }, 'v1.4').pass).toBe(true);

    const bad = evaluateExpectation({ contains: 'missing', notContains: 'bad' }, 'bad value');
    expect(bad.pass).toBe(false);
    expect(bad.reason).toContain('missing expected substring');
    expect(bad.reason).toContain('found forbidden substring');
  });

  it('estimates USD cost for known Claude and Gemini models and returns null for unknown models', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 500_000 };
    expect(estimateCostUsd(usage, 'claude-sonnet-5-5')).toBeCloseTo(3.05, 4);
    expect(estimateCostUsd(usage, 'google/gemini-4-hydrogen')).toBeCloseTo(0.825, 4);
    expect(estimateCostUsd(usage, 'unknown-local-model')).toBeNull();
  });
});

describe('runEval & diffEvalRuns (end-to-end eval refinement loop)', () => {
  it('prices live usage by routed model and propagates unpriced usage to the summary', async () => {
    const cwd = await tmp();
    const fake = new FakeRunner(() => ({ inputTokensPerTurn: 1_000_000, outputTokensPerTurn: 0 }));
    const opts = {
      cwd,
      runner: new RoutingRunner({ anthropic: fake, gemini: fake, codex: fake }),
      script: `export const meta = { name: 'prices', description: 'd' };
return await Promise.all([agent('first', { model: args.model }), agent('second')]);`,
      cases: [{ id: 'mixed', args: { model: 'gemini-4-hydrogen' } }],
    };
    const mixed = await runEval(opts);
    expect(mixed.cases[0]?.estimatedCostUsd).toBe(4.5);
    expect(mixed.summary.estimatedCostUsd).toBe(4.5);
    const extra = { id: 'other', args: { model: 'other-model' } };
    const cases = [...opts.cases, extra];
    const unknown = await runEval({ ...opts, cases });
    expect(unknown.cases.map((c) => c.estimatedCostUsd)).toEqual([4.5, null]);
    expect(unknown.summary.estimatedCostUsd).toBeNull();
    const replay = await runEval({ ...opts, cases, fromEvalId: unknown.evalId });
    expect(replay.summary.journalCacheHits).toBe(4);
    expect(replay.summary.estimatedCostUsd).toBe(0);
    const custom = await runEval({ ...opts, cases, prices: { 'other-model': { input: 1, output: 0 } } });
    expect(custom.summary.estimatedCostUsd).toBe(9.5);
  });

  it.each([
    [class GeminiRunner extends FakeRunner {}, 0.5],
    [class CodexRunner extends FakeRunner {}, null],
  ] as const)('resolves the implicit model for %s', async (Runner, cost) => {
    const record = await runEval({
      cwd: await tmp(),
      runner: new Runner(() => ({ inputTokensPerTurn: 1_000_000, outputTokensPerTurn: 0 })),
      script: `export const meta = { name: 'implicit', description: 'd' }; return await agent('go');`,
      cases: [{ id: 'implicit' }],
    });
    expect(record.summary.estimatedCostUsd).toBe(cost);
  });

  it('reports edits to args, expect or expected separately and compares legacy cases', async () => {
    const cwd = await tmp();
    const opts = {
      cwd,
      runner: new FakeRunner(),
      script: `export const meta = { name: 'same', description: 'd' }; return 1;`,
    };
    const before = await runEval({
      ...opts,
      cases: [
        { id: 'args', args: 1 },
        { id: 'expect', expect: { equals: 0 } },
        { id: 'expected', expected: 1 },
        { id: 'reordered', args: { a: 1, b: 2 } },
      ],
    });
    const after = await runEval({
      ...opts,
      cases: [
        { id: 'args', args: 2 },
        { id: 'expect', expect: { equals: 1 } },
        { id: 'expected', expected: 0 },
        { id: 'reordered', args: { b: 2, a: 1 } },
      ],
    });
    const diff = await diffEvalRuns(path.join(cwd, '.maestro'), before.evalId, after.evalId);
    expect(diff.cases.changed.map((c) => c.id)).toEqual(['args', 'expect', 'expected']);
    expect(diff.cases.fixed).toEqual([]);
    expect(diff.cases.regressions).toEqual([]);
    expect(diff.cases.stillPassing).toBe(1);
    expect(formatEvalDiff(diff)).toMatch(/### Changed[^\n]*[\s\S]*`expected`: pass → fail/);
    const exitCode = await main(['eval', 'diff', before.evalId, after.evalId, '--fail-on-regression'], {
      cwd,
      stdout: { write: () => {} },
    });
    expect(exitCode).toBe(0);
    for (const c of before.cases) {
      delete c.argsHash;
      delete c.expectationHash;
    }
    expect(diffEvalRecords(before, after).cases.regressions.map((c) => c.id)).toEqual(['expected']);
  });

  it('drops failures of abandoned nodes on resume, retaining legacy behavior without run_start', async () => {
    const cwd = await tmp();
    const opts = {
      cwd,
      script: `export const meta = { name: 'resume', description: 'd' }; return await agent('old');`,
    };
    const old = run({ ...opts, runner: new FakeRunner(() => ({ result: null })) });
    await old.promise;
    await run({
      cwd,
      resumeFromRunId: old.runId,
      runner: new FakeRunner(),
      script: opts.script.replace("'old'", "'new'"),
    }).promise;
    const stateDir = path.join(cwd, '.maestro');
    expect((await diffEvalRuns(stateDir, old.runId, old.runId)).score.passedB).toBe(1);
    await rm(path.join(old.runDir, 'events.jsonl'));
    expect((await diffEvalRuns(stateDir, old.runId, old.runId)).score.passedB).toBe(0);
  });

  it('runs v1, replays v2 with --from-eval cache reuse, and diffs fixed cases, regressions, tokens and [CACHE HIT] ratio', async () => {
    const cwd = await tmp();
    const cases = [
      { id: 'case-1', args: { q: 'auth' }, expect: { match: { verdict: 'ok' } } },
      { id: 'case-2', args: { q: 'sql' }, expect: { match: { verdict: 'ok' } } },
      { id: 'case-3', args: { q: 'xss' }, expect: { match: { verdict: 'ok' } } },
      { id: 'case-4', args: { q: 'csrf' }, expect: { match: { verdict: 'ok' } } },
    ];

    const scriptV1 = `export const meta = { name: 'triage', description: 'v1' };
const ctx = await agent('ingest:' + args.q, { label: 'ingest' });
return await agent('v1-answer:' + ctx, { label: 'answer' });`;

    const scriptV2 = `export const meta = { name: 'triage', description: 'v2' };
const ctx = await agent('ingest:' + args.q, { label: 'ingest' });
return await agent('v2-answer:' + ctx, { label: 'answer' });`;

    // v1 passes case-1 and case-4 (2/4); v2 fixes case-2 and case-3, but regresses case-4 (3/4).
    const runner = new FakeRunner((req) => {
      if (req.prompt.startsWith('ingest:')) {
        return {
          result: req.prompt.slice('ingest:'.length),
          inputTokensPerTurn: 1_000,
          outputTokensPerTurn: 200,
          cacheReadTokensPerTurn: 500,
        };
      }
      if (req.prompt.startsWith('v1-answer:')) {
        const q = req.prompt.slice('v1-answer:'.length);
        return {
          result: { verdict: q === 'auth' || q === 'csrf' ? 'ok' : 'bad' },
          inputTokensPerTurn: 400,
          outputTokensPerTurn: 100,
        };
      }
      if (req.prompt.startsWith('v2-answer:')) {
        const q = req.prompt.slice('v2-answer:'.length);
        return {
          result: { verdict: q === 'csrf' ? 'bad' : 'ok' },
          inputTokensPerTurn: 400,
          outputTokensPerTurn: 100,
        };
      }
      return { result: null };
    });

    const v1 = await runEval({
      cwd,
      evalId: 'v1',
      script: scriptV1,
      cases,
      runner,
      model: 'gemini-4-hydrogen',
    });
    expect(v1.summary.passed).toBe(2);
    expect(v1.summary.total).toBe(4);
    expect(v1.summary.journalCacheHits).toBe(0);
    expect(v1.summary.agentCalls).toBe(8);

    // v2 replays from v1 starting at `answer`: all 4 `ingest` calls hit cache (4/8 = 50% [CACHE HIT])!
    const v2 = await runEval({
      cwd,
      evalId: 'v2',
      script: scriptV2,
      cases,
      fromEvalId: 'v1',
      fromNode: 'answer',
      runner,
      model: 'gemini-4-hydrogen',
    });
    expect(v2.summary.passed).toBe(3);
    expect(v2.summary.total).toBe(4);
    expect(v2.summary.journalCacheHits).toBe(4);
    expect(v2.summary.agentCalls).toBe(8);
    expect(v2.summary.journalCacheHitRatio).toBe(0.5);
    // Live tokens dropped dramatically because all 4 ingest calls were served from cache.
    expect(v1.summary.tokens).toEqual({
      input: 5600,
      output: 1200,
      cacheRead: 2000,
      cacheWrite: 0,
      totalInput: 7600,
      total: 8800,
    });
    expect(v1.summary.promptCacheRatio).toBe(2000 / 7600);
    expect(v2.summary.tokens).toEqual({
      input: 1600,
      output: 400,
      cacheRead: 0,
      cacheWrite: 0,
      totalInput: 1600,
      total: 2000,
    });
    expect(v2.summary.promptCacheRatio).toBeNull();
    for (const c of v2.cases) expect(c.usage).toEqual(c.liveUsage);

    const diff = await diffEvalRuns(path.join(cwd, '.maestro'), 'v1', 'v2');
    expect(diff.score.passedA).toBe(2);
    expect(diff.score.passedB).toBe(3);
    expect(diff.score.passedDelta).toBe(1);
    expect(diff.cases.fixed.map((c) => c.id)).toEqual(['case-2', 'case-3']);
    expect(diff.cases.regressions.map((c) => c.id)).toEqual(['case-4']);
    expect(diff.cases.stillPassing).toBe(1);
    expect(diff.tokens.totalDelta).toBe(-6800);
    expect(diff.cache.journalHitRatioB).toBe(0.5);

    const md = formatEvalDiff(diff);
    expect(md).toContain('2/4 (50%)');
    expect(md).toContain('3/4 (75%)');
    expect(md).toContain('### Fixed (2)');
    expect(md).toContain('### Regressions (1)');
    expect(md).toContain('`case-4`');
    expect(md).toContain('maestro inspect');
    expect(md).toContain('[CACHE HIT] Ratio');
  });

  it('supports CLI `maestro eval`, custom `--grader`, `maestro eval ls`, and `maestro eval diff --fail-on-regression`', async () => {
    const cwd = await tmp();
    await writeFile(
      path.join(cwd, 'wf.js'),
      `export const meta = { name: 'echo', description: 'd' };
return await agent('say ' + args.word, { label: 'say' });`,
    );
    await writeFile(
      path.join(cwd, 'cases.jsonl'),
      '{"id":"w1","args":{"word":"apple"}}\n{"id":"w2","args":{"word":"banana"}}\n',
    );
    await writeFile(
      path.join(cwd, 'grader.mjs'),
      `export default function grade({ case: c, output }) {
  const pass = typeof output === 'string' && output.includes(c.args.word);
  return { pass, reason: pass ? undefined : 'missing word' };
}\n`,
    );

    const runCli = async (argv: string[]) => {
      let stdout = '';
      let stderr = '';
      const code = await main(argv, {
        cwd,
        stdout: { write: (s) => (stdout += s) },
        stderr: { write: (s) => (stderr += s), isTTY: false },
      });
      return { code, stdout, stderr };
    };

    const e1 = await runCli([
      'eval',
      'wf.js',
      '--cases',
      'cases.jsonl',
      '--grader',
      'grader.mjs',
      '--name',
      'baseline',
      '--dry-run',
    ]);
    expect(e1.code, e1.stderr).toBe(0);
    expect(e1.stdout).toContain('score: 2/2 (100%)');

    // Break workflow on w2 to trigger a regression.
    await writeFile(
      path.join(cwd, 'wf-broken.js'),
      `export const meta = { name: 'echo', description: 'd' };
return args.word === 'banana' ? 'wrong' : await agent('say ' + args.word, { label: 'say' });`,
    );
    const e2 = await runCli([
      'eval',
      'wf-broken.js',
      '--cases',
      'cases.jsonl',
      '--grader',
      'grader.mjs',
      '--name',
      'candidate',
      '--from-eval',
      'baseline',
      '--dry-run',
    ]);
    expect(e2.code).toBe(1); // 1/2 failed
    expect(e2.stdout).toContain('score: 1/2 (50%)');
    expect(e2.stdout).toContain('[CACHE HIT]');

    const diffRes = await runCli(['eval', 'diff', 'baseline', 'candidate', '--fail-on-regression']);
    expect(diffRes.code).toBe(1);
    expect(diffRes.stdout).toContain('Regressions (1)');
    expect(diffRes.stdout).toContain('`w2`');

    const lsRes = await runCli(['eval', 'ls']);
    expect(lsRes.code, lsRes.stderr).toBe(0);
    expect(lsRes.stdout).toContain('baseline');
    expect(lsRes.stdout).toContain('candidate');
  });

  it('can also diff two individual workflow runIds directly via `maestro eval diff`', async () => {
    const cwd = await tmp();
    const rFail = run({
      cwd,
      runId: 'single-v1',
      runner: new FakeRunner(() => ({ status: 'null', result: null, error: 'boom' })),
      script: `export const meta = { name: 'solo', description: 'd' }; return await agent('go');`,
    });
    await rFail.promise;
    const rOk = run({
      cwd,
      runId: 'single-v2',
      runner: new FakeRunner(() => ({ result: 'ok' })),
      script: `export const meta = { name: 'solo', description: 'd' }; return await agent('go');`,
    });
    await rOk.promise;

    const diff = await diffEvalRuns(path.join(cwd, '.maestro'), 'single-v1', 'single-v2');
    expect(diff.kind).toBe('run');
    expect(diff.score.passedA).toBe(0);
    expect(diff.score.passedB).toBe(1);
    expect(diff.cases.fixed).toHaveLength(1);
  });
});
