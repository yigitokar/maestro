// Tool adapter: strict tool definition, exactly-one source rule, errors as is_error content, background run.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../src/testing/fake-runner.js';
import {
  handleWorkflowToolCall,
  maestroToolDefinition,
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

function ctx(dir: string, onComplete?: WorkflowToolContext['onComplete']): WorkflowToolContext {
  return {
    cwd: dir,
    stateDir: path.join(dir, 'state'),
    runner: new FakeRunner(),
    concurrency: 2,
    onComplete,
  };
}

function completion(dir: string) {
  let resolve!: (v: { runId: string; outcome: WorkflowOutcome }) => void;
  const done = new Promise<{ runId: string; outcome: WorkflowOutcome }>((r) => {
    resolve = r;
  });
  return { done, ctx: ctx(dir, (runId, outcome) => resolve({ runId, outcome })) };
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
      ['args', 'name', 'resumeFromRunId', 'script', 'scriptPath'].sort(),
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
