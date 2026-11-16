// Tool adapter: strict tool definition, exactly-one source rule, errors as is_error content, background run.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../src/testing/fake-runner.js';
import {
  handleWorkflowToolCall,
  liveWorkflowAgents,
  maestroToolDefinition,
  sendWorkflowAgentMessage,
  skipWorkflowAgent,
  stopWorkflowRun,
  toToolResultBlock,
  type WorkflowOutcome,
  type WorkflowToolContext,
} from '../src/tool.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'maestro-tool-'));
  dirs.push(d);
  return d;
}

const SCRIPT = `export const meta = { name: 't', description: 'd' };
const r = await agent('hello ' + args.who);
return { r, who: args.who };`;

function ctx(
  dir: string,
  onComplete?: WorkflowToolContext['onComplete'],
  runner: FakeRunner = new FakeRunner(),
): WorkflowToolContext {
  return {
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    runner,
    concurrency: 2,
    onComplete,
  };
}

function completion(dir: string, runner?: FakeRunner) {
  let resolve!: (v: { runId: string; outcome: WorkflowOutcome }) => void;
  const done = new Promise<{ runId: string; outcome: WorkflowOutcome }>((r) => {
    resolve = r;
  });
  return { done, ctx: ctx(dir, (runId, outcome) => resolve({ runId, outcome }), runner) };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

async function journalRows(dir: string, runId: string): Promise<any[]> {
  const raw = await readFile(path.join(dir, 'state', 'runs', runId, 'journal.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

/** Every object node is strict: additionalProperties false and required listing every property. */
function assertStrict(schema: any, at = '$'): void {
  if (schema && typeof schema === 'object' && (schema.type === 'object' || schema.properties)) {
    expect(schema.additionalProperties, `${at}.additionalProperties`).toBe(false);
    expect([...(schema.required ?? [])].sort(), `${at}.required`).toEqual(
      Object.keys(schema.properties ?? {}).sort(),
    );
    for (const [k, v] of Object.entries(schema.properties ?? {})) assertStrict(v, `${at}.${k}`);
  }
}

describe('maestroToolDefinition', () => {
  it('is a strict Workflow tool whose schema satisfies the strict rules', () => {
    const def = maestroToolDefinition() as any;
    expect(def.name).toBe('Workflow');
    expect(def.strict).toBe(true);
    expect(def.input_schema.type).toBe('object');
    assertStrict(def.input_schema);
    expect(Object.keys(def.input_schema.properties).sort()).toEqual(
      ['args', 'cwd', 'name', 'resumeFromRunId', 'script', 'scriptPath'].sort(),
    );
    // Policy text lives in the description: when to use, when not, meta, inline script.
    expect(def.description).toMatch(/Do not use it/);
    expect(def.description).toMatch(/export const meta/);
    expect(def.description).toMatch(/inline/);
  });
});

describe('handleWorkflowToolCall', () => {
  it('starts in the background, returns runId + persisted scriptPath, and reports completion', async () => {
    const dir = await tmp();
    const { done, ctx: c } = completion(dir);
    const res = await handleWorkflowToolCall(
      { script: SCRIPT, scriptPath: null, name: null, args: '{"who":"yigit"}', resumeFromRunId: null },
      c,
    );
    expect('is_error' in res).toBe(false);
    if ('is_error' in res) return;
    expect(res.status).toBe('started');
    expect(res.scriptPath).toBe(path.join(dir, 'state', 'runs', res.runId, 'script.js'));
    const { runId, outcome } = await done;
    expect(runId).toBe(res.runId);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect((outcome.result as any).who).toBe('yigit');
  });

  it('enforces exactly one of script, scriptPath, name', async () => {
    const dir = await tmp();
    const none = await handleWorkflowToolCall({ script: null, scriptPath: null, name: null }, ctx(dir));
    expect(none).toMatchObject({ is_error: true });
    const two = await handleWorkflowToolCall({ script: SCRIPT, name: 'x' }, ctx(dir));
    expect(two).toMatchObject({ is_error: true, content: expect.stringMatching(/exactly one/) });
    const three = await handleWorkflowToolCall({ script: SCRIPT, scriptPath: 'a.js', name: 'x' }, ctx(dir));
    expect(three).toMatchObject({ is_error: true });
  });

  it('returns is_error content (never throws) for bad input, missing meta, impure meta, syntax errors', async () => {
    const dir = await tmp();
    for (const input of [
      null,
      'nope',
      [],
      { script: 'const x = 1; return x' },
      { script: 'const n = "x"; export const meta = { name: n, description: "d" }' },
      { script: 'export const meta = { name: "a", description: "d" }\nreturn (' },
      { script: SCRIPT, args: '{not json' },
      { scriptPath: 'missing.js' },
      { name: '../escape' },
    ]) {
      const res = await handleWorkflowToolCall(input, ctx(dir));
      expect(res, JSON.stringify(input)).toMatchObject({ is_error: true, content: expect.any(String) });
    }
  });

  it('resolves a registered name from .maestro/workflows/<name>.js and a scriptPath relative to cwd', async () => {
    const dir = await tmp();
    await mkdir(path.join(dir, 'state', 'workflows'), { recursive: true });
    await writeFile(path.join(dir, 'state', 'workflows', 'greet.js'), SCRIPT);
    await writeFile(path.join(dir, 'w.js'), SCRIPT);
    for (const input of [{ name: 'greet' }, { scriptPath: 'w.js' }]) {
      const { done, ctx: c } = completion(dir);
      const res = await handleWorkflowToolCall({ ...input, args: '{"who":"a"}' }, c);
      expect(res).toMatchObject({ status: 'started' });
      expect((await done).outcome.ok).toBe(true);
    }
  });

  it('a script that throws at run time reports ok:false through onComplete', async () => {
    const dir = await tmp();
    const { done, ctx: c } = completion(dir);
    const res = await handleWorkflowToolCall(
      { script: `export const meta = { name: 't', description: 'd' };\nthrow new Error('boom')` },
      c,
    );
    expect(res).toMatchObject({ status: 'started' });
    const { outcome } = await done;
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/boom/) });
  });

  it('resume with the stored script reuses script.js and args.json; journaled agents are cached', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const first = completion(dir, runner);
    const res = await handleWorkflowToolCall({ script: SCRIPT, args: '{"who":"a"}' }, first.ctx);
    if ('is_error' in res) throw new Error(res.content);
    const one = await first.done;
    expect(one.outcome.ok).toBe(true);
    expect(runner.liveCalls).toBe(1);

    const again = completion(dir, runner);
    const resumed = await handleWorkflowToolCall(
      { script: null, scriptPath: null, name: null, args: null, resumeFromRunId: res.runId },
      again.ctx,
    );
    expect(resumed).toEqual({ runId: res.runId, scriptPath: res.scriptPath, status: 'started' });
    const two = await again.done;
    expect(two).toEqual(one);
    expect(runner.liveCalls).toBe(1);
  });

  it('resume with an edited script: unchanged agent() calls are cached, the edited one runs live', async () => {
    const dir = await tmp();
    const runner = new FakeRunner();
    const first = completion(dir, runner);
    const res = await handleWorkflowToolCall({ script: SCRIPT, args: '{"who":"a"}' }, first.ctx);
    if ('is_error' in res) throw new Error(res.content);
    await first.done;

    const edited = `${SCRIPT.replace(/return .*$/m, '')}const extra = await agent('second ' + args.who);
return { r, extra, edited: true };`;
    const again = completion(dir, runner);
    const resumed = await handleWorkflowToolCall({ script: edited, resumeFromRunId: res.runId }, again.ctx);
    expect(resumed).toMatchObject({ runId: res.runId, status: 'started' });
    const { outcome } = await again.done;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toMatchObject({ edited: true, extra: expect.any(String) });
    // 'hello a' came from the journal, only 'second a' hit the runner.
    expect(runner.calls.map((c) => c.prompt)).toEqual(['hello a', 'second a']);
    expect(await readFile(res.scriptPath, 'utf8')).toBe(edited);
  });

  it('resume of an unknown, unsafe or script-less runId is is_error at once (no started result)', async () => {
    const dir = await tmp();
    let completed = false;
    const c = ctx(dir, () => {
      completed = true;
    });
    const unknown = await handleWorkflowToolCall({ resumeFromRunId: 'nope-123' }, c);
    expect(unknown).toMatchObject({ is_error: true, content: expect.stringMatching(/no run nope-123/) });
    const withScript = await handleWorkflowToolCall({ script: SCRIPT, resumeFromRunId: 'nope-123' }, c);
    expect(withScript).toMatchObject({ is_error: true, content: expect.stringMatching(/no run nope-123/) });
    const unsafe = await handleWorkflowToolCall({ resumeFromRunId: '../state' }, c);
    expect(unsafe).toMatchObject({
      is_error: true,
      content: expect.stringMatching(/invalid resumeFromRunId/),
    });
    await mkdir(path.join(dir, 'state', 'runs', 'empty-1'), { recursive: true });
    const bare = await handleWorkflowToolCall({ resumeFromRunId: 'empty-1' }, c);
    expect(bare).toMatchObject({ is_error: true, content: expect.stringMatching(/no stored script\.js/) });
    await new Promise((r) => setTimeout(r, 20));
    expect(completed).toBe(false);
  });

  it('stopWorkflowRun stops a tool-started run: the script rejects with run_stopped, the journal stays', async () => {
    const dir = await tmp();
    const { done, ctx: c } = completion(dir, new FakeRunner(() => ({ delayMs: 5_000 })));
    const res = await handleWorkflowToolCall({ script: SCRIPT, args: '{"who":"a"}' }, c);
    if ('is_error' in res) throw new Error(res.content);
    await until(() => (liveWorkflowAgents(res.runId) ?? []).length === 1);
    expect(liveWorkflowAgents(res.runId)![0]!.canMessage).toBe(false);
    expect(sendWorkflowAgentMessage(res.runId, 0, 'Unsupported runner.')).toBeNull();
    expect(stopWorkflowRun(res.runId, 'enough')).toBe(true);
    const { outcome } = await done;
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/stopped: enough/) });
    expect((await journalRows(dir, res.runId)).map((r) => r.status)).toEqual(['skipped']);
    // Settled runs leave the registry.
    expect(stopWorkflowRun(res.runId)).toBe(false);
    expect(liveWorkflowAgents(res.runId)).toBeNull();
    expect(sendWorkflowAgentMessage(res.runId, 0, 'Too late.')).toBeNull();
    expect(stopWorkflowRun('never-started')).toBe(false);
    expect(sendWorkflowAgentMessage('never-started', 0, 'Unknown.')).toBeNull();
  });

  it('skipWorkflowAgent skips one live agent: agent() returns null, its row is skipped, the run goes on', async () => {
    const dir = await tmp();
    const runner = new FakeRunner((req) => (req.prompt === 'slow' ? { delayMs: 5_000 } : {}));
    const { done, ctx: c } = completion(dir, runner);
    const res = await handleWorkflowToolCall(
      {
        script: `export const meta = { name: 's', description: 'd' };
const [slow, fast] = await parallel([() => agent('slow', { label: 'slow' }), () => agent('fast')]);
return { slow, fast };`,
      },
      c,
    );
    if ('is_error' in res) throw new Error(res.content);
    await until(() => (liveWorkflowAgents(res.runId) ?? []).some((a) => a.label === 'slow'));
    const slow = liveWorkflowAgents(res.runId)!.find((a) => a.label === 'slow')!;
    expect(skipWorkflowAgent(res.runId, slow.id)).toBe(true);
    expect(skipWorkflowAgent(res.runId, 999)).toBe(false);
    const { outcome } = await done;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toEqual({ slow: null, fast: expect.any(String) });
    const rows = await journalRows(dir, res.runId);
    expect(rows.map((r) => r.status).sort()).toEqual(['ok', 'skipped']);
    expect(skipWorkflowAgent('never-started', 0)).toBe(false);
  });

  it('toToolResultBlock maps errors to is_error tool_result blocks', () => {
    expect(toToolResultBlock('tu_1', { is_error: true, content: 'bad' })).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      is_error: true,
      content: 'bad',
    });
    const ok = toToolResultBlock('tu_2', { runId: 'r', scriptPath: '/x', status: 'started' });
    expect(ok.is_error).toBeUndefined();
    expect(JSON.parse(ok.content as string)).toEqual({ runId: 'r', scriptPath: '/x', status: 'started' });
  });
});
