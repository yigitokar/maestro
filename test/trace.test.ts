// Journal trace (v1.1): the runner's tool calls and final text, journaled per row (64 KB blob rule) and
// printed by `maestro show`. Scripted fetch and FakeRunner only; never the network.

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { Journal, readEntries, readTrace } from '../src/journal.js';
import { AnthropicRunner, systemPrompt } from '../src/runner.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { buildTools } from '../src/tools.js';
import type { Entry, RunRequest, Trace } from '../src/types.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-trace-')));
  dirs.push(d);
  return d;
}

let n = 0;
function reply(content: unknown[], stop_reason: string) {
  return {
    id: `msg_${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function scripted(steps: unknown[]) {
  let i = 0;
  const fetch = async (): Promise<Response> =>
    new Response(JSON.stringify(steps[i++]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: fetch as any });
}

function req(cwd: string, overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'look',
    system: systemPrompt({ cwd, writer: false }),
    tools: buildTools(undefined, false),
    model: 'claude-opus-5-5',
    cwd,
    signal: new AbortController().signal,
    isolated: false,
    onUsage: () => {},
    log: () => {},
    ...overrides,
  };
}

describe('AnthropicRunner trace', () => {
  it('records tool calls in order (ok / failed, input cut at 200 chars) and the final text', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'a.txt'), 'hello\n');
    const longPattern = 'x'.repeat(500);
    const client = scripted([
      reply(
        [
          { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } },
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'missing.txt' } },
        ],
        'tool_use',
      ),
      reply([{ type: 'tool_use', id: 't3', name: 'grep', input: { pattern: longPattern } }], 'tool_use'),
      reply([{ type: 'text', text: `found nothing ${'y'.repeat(3000)}` }], 'end_turn'),
    ]);
    const res = await new AnthropicRunner({ client, retryDelayMs: 0 }).run(req(dir));
    expect(res.status).toBe('ok');
    const trace = res.trace!;
    expect(trace.toolCalls.map((c) => [c.tool, c.ok])).toEqual([
      ['read_file', true],
      ['read_file', false],
      ['grep', expect.any(Boolean)],
    ]);
    expect(trace.toolCalls[0]!.inputSummary).toBe('{"path":"a.txt"}');
    expect(trace.toolCalls[2]!.inputSummary).toHaveLength(200);
    expect(trace.finalText).toHaveLength(2000);
    expect(trace.finalText.startsWith('found nothing ')).toBe(true);
  });

  it('with a schema the final text is the last stage-1 assistant text, not the structured reply', async () => {
    const dir = await tmp();
    const client = scripted([
      reply([{ type: 'text', text: 'nothing suspicious in the diff' }], 'end_turn'),
      reply([{ type: 'text', text: '{"findings":[]}' }], 'end_turn'),
    ]);
    const schema = {
      type: 'object',
      properties: { findings: { type: 'array', items: { type: 'string' } } },
      required: ['findings'],
    };
    const res = await new AnthropicRunner({ client, retryDelayMs: 0 }).run(req(dir, { schema }));
    expect(res).toMatchObject({ status: 'ok', result: { findings: [] } });
    expect(res.trace).toEqual({ toolCalls: [], finalText: 'nothing suspicious in the diff' });
  });

  it('a failed agent still carries its trace', async () => {
    const dir = await tmp();
    const client = scripted([
      reply([{ type: 'tool_use', id: 't1', name: 'glob', input: { pattern: '*.ts' } }], 'tool_use'),
    ]);
    const res = await new AnthropicRunner({ client, retryDelayMs: 0, maxTurns: 1 }).run(req(dir));
    expect(res.status).toBe('null');
    expect(res.trace!.toolCalls.map((c) => c.tool)).toEqual(['glob']);
  });
});

describe('journal trace', () => {
  const base = (key: string, trace: Trace): Entry => ({
    index: 0,
    hash: 'h',
    n: 0,
    key,
    label: 'find:x',
    result: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    status: 'null',
    trace,
  });

  it('a small trace stays inline; one over 64 KB goes to blobs/<key>.trace.json', async () => {
    const dir = await tmp();
    const j = await Journal.open(dir);
    const small: Trace = { toolCalls: [{ tool: 'grep', inputSummary: '{}', ok: true }], finalText: 'f' };
    const big: Trace = {
      toolCalls: Array.from({ length: 400 }, () => ({
        tool: 'grep',
        inputSummary: 'z'.repeat(200),
        ok: true,
      })),
      finalText: 'f',
    };
    await j.append(base('k1:0', small));
    await j.append(base('k2:0', big));
    await j.close();
    const rows = await readEntries(dir);
    expect(rows[0]!.trace).toEqual(small);
    expect(rows[1]).toMatchObject({ trace: { blob: 'k2:0' }, traceBlob: true });
    expect(existsSync(path.join(dir, 'blobs', 'k2:0.trace.json'))).toBe(true);
    expect(await readTrace(dir, rows[1]!)).toEqual(big);
  });

  it('run() journals the runner trace on the row', async () => {
    const dir = await tmp();
    const trace: Trace = {
      toolCalls: [{ tool: 'read_file', inputSummary: '{"path":"x"}', ok: false }],
      finalText: '',
    };
    const handle = run({
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      runner: new FakeRunner(() => ({ trace })),
      script: `export const meta = { name: 't', description: 'd' };\nreturn agent('a', { label: 'a' });`,
    });
    await handle.promise;
    const line = readFileSync(path.join(handle.runDir, 'journal.jsonl'), 'utf8').trim();
    expect(JSON.parse(line).trace).toEqual(trace);
  });
});

describe('maestro show', () => {
  async function cli(argv: string[], cwd: string) {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, {
      cwd,
      env: {},
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s), isTTY: false },
    });
    return { code, stdout, stderr };
  }

  async function seed(dir: string): Promise<string> {
    const handle = run({
      cwd: dir,
      runId: 'r1',
      runner: new FakeRunner([
        {
          match: 'empty',
          respond: {
            result: { findings: [] },
            trace: {
              toolCalls: [
                { tool: 'bash', inputSummary: '{"command":"git diff a b"}', ok: true },
                { tool: 'read_file', inputSummary: '{"path":"lib/q.ts"}', ok: false },
              ],
              finalText: 'The diff only renames a variable.',
            },
          },
        },
      ]),
      script: `export const meta = { name: 't', description: 'd' };
await agent('empty finder', { label: 'find:security' });
return agent('other', { label: 'other' });`,
    });
    await handle.promise;
    return handle.runId;
  }

  it('lists the agents of a run', async () => {
    const dir = await tmp();
    const runId = await seed(dir);
    const res = await cli(['show', runId], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('#0 find:security [ok] 50 in, 100 out, 2 tool calls');
    expect(res.stdout).toContain('#1 other [ok]');
  });

  it("prints one agent's trace by label", async () => {
    const dir = await tmp();
    const runId = await seed(dir);
    const res = await cli(['show', runId, 'find:security'], dir);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('tool calls (2):');
    expect(res.stdout).toContain('  ✓ bash {"command":"git diff a b"}');
    expect(res.stdout).toContain('  ✗ read_file {"path":"lib/q.ts"}');
    expect(res.stdout).toContain('  The diff only renames a variable.');
    expect(res.stdout).toContain('"findings": []');
  });

  it('a row without a trace says so; unknown label and run fail with 1', async () => {
    const dir = await tmp();
    const runId = await seed(dir);
    expect((await cli(['show', runId, 'other'], dir)).stdout).toContain('trace: none');
    const missing = await cli(['show', runId, 'nope'], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no agent labelled "nope"');
    expect((await cli(['show', 'no-such-run'], dir)).code).toBe(1);
    expect((await cli(['show'], dir)).code).toBe(1);
  });
});
