// The model a runner really sent (RunResult.model): recorded on the agent_end event and the journal row,
// and what `maestro eval` prices a live call at. Mocked transports and a fake Codex binary only.

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/codex-runner.js';
import { diffEvalRuns, runEval } from '../src/eval.js';
import { type GeminiInteractionsClient, GeminiRunner } from '../src/gemini-runner.js';
import { hashCall, makeKey, readEntries } from '../src/journal.js';
import { RoutingRunner } from '../src/routing-runner.js';
import { type FakeHandler, FakeRunner } from '../src/testing/fake-runner.js';
import type { RunRequest, RunResult, WorkflowEvent } from '../src/types.js';
import { run } from '../src/workflow.js';

const fakeCodex = path.join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const MILLION_INPUT = { inputTokensPerTurn: 1_000_000, outputTokensPerTurn: 0 };

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-reported-model-')));
  dirs.push(d);
  return d;
}

/** Points the fake Codex binary at one turn that spends 1M input tokens. */
function stubFakeCodex(cwd: string): void {
  vi.stubEnv('FAKE_CODEX_RECORD', path.join(cwd, 'codex-calls.jsonl'));
  vi.stubEnv(
    'FAKE_CODEX_SCENARIO',
    JSON.stringify({
      finalText: 'done',
      steps: [{ event: { type: 'turn.completed', usage: { input_tokens: 1_000_000, output_tokens: 0 } } }],
    }),
  );
}

/** A runner that sends every call to `sent`, whatever the workflow asked for; null: it cannot name the model. */
class ReportingRunner extends FakeRunner {
  constructor(
    private readonly sent: string | null,
    handler?: FakeHandler,
  ) {
    super(handler);
  }

  override async run(req: RunRequest): Promise<RunResult> {
    return { ...(await super.run(req)), model: this.sent };
  }
}

type AgentEnd = Extract<WorkflowEvent, { type: 'agent_end' }>;

const SCRIPT = `export const meta = { name: 'model', description: 'd' };
return await agent('go', { model: 'asked-model', label: 'one' });`;

describe('a run records the model its runner reported', () => {
  it('on the agent_end event, in events.jsonl and on the journal row, leaving the cache key alone', async () => {
    const cwd = await tmp();
    const ends: AgentEnd[] = [];
    const first = run({ cwd, runner: new ReportingRunner('sent-model'), script: SCRIPT });
    first.events.on('agent_end', (e: AgentEnd) => ends.push(e));
    await first.promise;

    const key = makeKey(hashCall('go', { model: 'asked-model' }), 0);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ key, cached: false, model: 'sent-model' });
    const [row] = await readEntries(first.runDir);
    expect(row).toMatchObject({ key, status: 'ok', model: 'sent-model' });
    const logged = (await readFile(path.join(first.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === 'agent_end');
    expect(logged).toEqual([expect.objectContaining({ key, model: 'sent-model' })]);

    // A resume finds the row under the same key although its runner would report another model.
    const again = new ReportingRunner('another-model');
    const resumed = run({ cwd, resumeFromRunId: first.runId, runner: again });
    const cachedEnds: AgentEnd[] = [];
    resumed.events.on('agent_end', (e: AgentEnd) => cachedEnds.push(e));
    await resumed.promise;
    expect(again.liveCalls).toBe(0);
    expect(cachedEnds).toEqual([expect.objectContaining({ key, cached: true })]);
    expect(cachedEnds[0]).not.toHaveProperty('model');
  });

  it('a runner that reports no model leaves the field out', async () => {
    const cwd = await tmp();
    const ends: AgentEnd[] = [];
    const handle = run({ cwd, runner: new FakeRunner(), script: SCRIPT });
    handle.events.on('agent_end', (e: AgentEnd) => ends.push(e));
    await handle.promise;
    expect(ends[0]).not.toHaveProperty('model');
    expect((await readEntries(handle.runDir))[0]).not.toHaveProperty('model');
  });

  it('records null when the runner says it cannot name the model it sent to', async () => {
    const cwd = await tmp();
    const ends: AgentEnd[] = [];
    const handle = run({
      cwd,
      runner: new ReportingRunner(null, () => ({ result: null, error: 'boom' })),
      script: SCRIPT,
    });
    handle.events.on('agent_end', (e: AgentEnd) => ends.push(e));
    await handle.promise;
    expect(ends[0]?.model).toBeNull();
    const [row] = await readEntries(handle.runDir);
    expect(row?.model).toBeNull();
    // The failed call's input keeps the model that was asked for: there is no better name for it.
    expect(row?.failureInput?.model).toBe('asked-model');
    const logged = (await readFile(path.join(handle.runDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((line) => line.type === 'agent_end');
    expect(logged.model).toBeNull();
  });

  it('stores the reported model as failureInput.model, and the requested one when none was reported', async () => {
    const failing: FakeHandler = () => ({ result: null, error: 'boom' });
    const reported = run({
      cwd: await tmp(),
      runner: new ReportingRunner('sent-model', failing),
      script: SCRIPT,
    });
    await reported.promise;
    expect((await readEntries(reported.runDir))[0]?.failureInput?.model).toBe('sent-model');

    const silent = run({ cwd: await tmp(), runner: new FakeRunner(failing), script: SCRIPT });
    await silent.promise;
    expect((await readEntries(silent.runDir))[0]?.failureInput?.model).toBe('asked-model');
  });
});

describe('eval prices a live call at the recorded model', () => {
  it('prices a GeminiRunner with a model override at the override, and an older log as before', async () => {
    const cwd = await tmp();
    const sentModels: string[] = [];
    const client: GeminiInteractionsClient = {
      interactions: {
        async create(params) {
          sentModels.push(params.model as string);
          return {
            status: 'completed',
            output_text: 'ok',
            usage: { total_input_tokens: 1_000_000, total_output_tokens: 0 },
          };
        },
      },
    };
    const record = await runEval({
      cwd,
      runner: new GeminiRunner({ client, model: 'gemini-4-carbon' }),
      script: `export const meta = { name: 'override', description: 'd' };
return await agent('go', { model: 'gemini-4-hydrogen' });`,
      cases: [{ id: 'one' }],
    });
    expect(sentModels).toEqual(['gemini-4-carbon']);
    // 1M input tokens on gemini-4-carbon; the requested gemini-4-hydrogen would be $0.50.
    expect(record.cases[0]?.estimatedCostUsd).toBe(2.5);
    expect(record.summary.estimatedCostUsd).toBe(2.5);

    // The same run as an older Maestro wrote it: no model on agent_end, so the requested model is priced.
    const runId = record.cases[0]!.runId;
    const stateDir = path.join(cwd, '.maestro');
    const eventsFile = path.join(stateDir, 'runs', runId, 'events.jsonl');
    const lines = (await readFile(eventsFile, 'utf8')).trim().split('\n');
    const legacy = lines.map((line) => {
      const event = JSON.parse(line);
      if (event.type === 'agent_end') delete event.model;
      return JSON.stringify(event);
    });
    expect((await diffEvalRuns(stateDir, runId, runId)).costUsd.costA).toBe(2.5);
    await writeFile(eventsFile, `${legacy.join('\n')}\n`);
    expect((await diffEvalRuns(stateDir, runId, runId)).costUsd.costA).toBe(0.5);
  });

  it('prices a routed call at what its runner reported, not at the requested model', async () => {
    const record = await runEval({
      cwd: await tmp(),
      runner: new RoutingRunner({
        route: () => new ReportingRunner('gemini-4-carbon', () => MILLION_INPUT),
      }),
      script: `export const meta = { name: 'custom-route', description: 'd' }; return await agent('go');`,
      cases: [{ id: 'one' }],
    });
    // The run's default claude-opus-5-5 would be $4.00.
    expect(record.summary.estimatedCostUsd).toBe(2.5);
  });

  it('gives no estimate for a call whose runner could not name the model, instead of guessing one', async () => {
    const record = await runEval({
      cwd: await tmp(),
      runner: new ReportingRunner(null, () => MILLION_INPUT),
      script: `export const meta = { name: 'unnamed', description: 'd' };
return [await agent('known', { model: 'gemini-4-hydrogen' }), await agent('unknown')];`,
      cases: [{ id: 'one' }],
    });
    // Both requested models are priced ($0.50 and $4.00), so a guess would have produced a number.
    expect(record.summary.tokens.input).toBe(2_000_000);
    expect(record.cases[0]?.estimatedCostUsd).toBeNull();
    expect(record.summary.estimatedCostUsd).toBeNull();
  });

  it('gives no estimate for Codex on its configuration default, however the call reached Codex', async () => {
    const cwd = await tmp();
    stubFakeCodex(cwd);
    const opts = {
      cwd,
      script: `export const meta = { name: 'codex-default', description: 'd' }; return await agent('go');`,
      cases: [{ id: 'one' }],
    };
    const codex = { bin: fakeCodex, ignoreUserConfig: true };
    // Neither run names CodexRunner as its runner, so only the runner's own report can say that the
    // requested claude-opus-5-5 ($4.00 here) is not what ran.
    const routed = await runEval({ ...opts, runner: new RoutingRunner({ codex, route: () => 'codex' }) });
    expect(routed.summary.tokens.input).toBe(1_000_000);
    expect(routed.summary.estimatedCostUsd).toBeNull();

    class WrappedCodex extends CodexRunner {}
    const subclassed = await runEval({ ...opts, runner: new WrappedCodex(codex) });
    expect(subclassed.summary.tokens.input).toBe(1_000_000);
    expect(subclassed.summary.estimatedCostUsd).toBeNull();
  });

  it('prices a CodexRunner at its own model, and gives no estimate on the Codex configuration default', async () => {
    const cwd = await tmp();
    stubFakeCodex(cwd);
    const opts = {
      cwd,
      script: `export const meta = { name: 'codex', description: 'd' }; return await agent('go');`,
      cases: [{ id: 'one' }],
      prices: { 'gpt-priced': { input: 3, output: 0 } },
    };
    // ignoreUserConfig keeps the runner on `codex exec`, which is what the fixture speaks.
    const overridden = await runEval({
      ...opts,
      runner: new CodexRunner({ bin: fakeCodex, ignoreUserConfig: true, model: 'gpt-priced' }),
    });
    expect(overridden.summary.tokens.input).toBe(1_000_000);
    expect(overridden.summary.estimatedCostUsd).toBe(3);

    // The request carries Maestro's Claude default, which Codex never receives: the model is unknown.
    const configDefault = await runEval({
      ...opts,
      runner: new CodexRunner({ bin: fakeCodex, ignoreUserConfig: true }),
    });
    expect(configDefault.summary.tokens.input).toBe(1_000_000);
    expect(configDefault.cases[0]?.estimatedCostUsd).toBeNull();
    expect(configDefault.summary.estimatedCostUsd).toBeNull();
  });
});
