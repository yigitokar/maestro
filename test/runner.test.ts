import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AnthropicRunner,
  RETURN_CONTRACT,
  systemPrompt,
  toStructuredOutputSchema,
  validateValue,
  WRITER_INSTRUCTION,
} from '../src/runner.js';
import { buildTools } from '../src/tools.js';
import { LIMITS, MaestroError, type RunRequest, type ToolDef, type Usage } from '../src/types.js';

// ---- scripted Messages API ------------------------------------------------------------------

type Step =
  | { status: number; body: unknown }
  | ((body: any, signal: AbortSignal | undefined) => Promise<Response> | Response);

let idCounter = 0;
function reply(
  content: unknown[],
  stop_reason: string,
  usage: Partial<Usage> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    status: 200,
    body: {
      id: `msg_${++idCounter}`,
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
      usage: { input_tokens: usage.input_tokens ?? 10, output_tokens: usage.output_tokens ?? 5 },
      ...extra,
    },
  };
}
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const apiError = (status: number, type: string, message: string) => ({
  status,
  body: { type: 'error', error: { type, message } },
});

function scripted(steps: Step[]) {
  const bodies: any[] = [];
  const fetch = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    const step = steps[bodies.length - 1];
    if (!step) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'script exhausted' },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    if (typeof step === 'function') return step(body, init?.signal ?? undefined);
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', 'request-id': `req_${bodies.length}` },
    });
  };
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: fetch as any });
  return { client, bodies };
}

let cwd: string;
beforeAll(async () => {
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-runner-')));
  await fs.writeFile(path.join(cwd, 'notes.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(cwd, 'CLAUDE.md'), 'Always answer in lowercase.\n');
});
afterAll(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function makeReq(overrides: Partial<RunRequest> = {}) {
  const usages: Usage[] = [];
  const logs: string[] = [];
  const req: RunRequest = {
    prompt: 'do the thing',
    system: systemPrompt({ cwd, writer: false }),
    tools: buildTools(undefined, false),
    model: 'claude-opus-5-5',
    cwd,
    signal: new AbortController().signal,
    isolated: false,
    onUsage: (u) => usages.push(u),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { req, usages, logs };
}

const runnerFor = (client: Anthropic, opts: { maxTurns?: number } = {}) =>
  new AnthropicRunner({ client, retryDelayMs: 0, ...opts });

const lastMessage = (body: any) => body.messages[body.messages.length - 1];

// ---- tests ----------------------------------------------------------------------------------

describe('AnthropicRunner: tool loop', () => {
  it('returns the final text; request carries strict tools, system prompt and effort', async () => {
    const { client, bodies } = scripted([reply([text('the '), text('answer')], 'end_turn')]);
    const { req, usages } = makeReq({ effort: 'low' });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: 'the answer', status: 'ok', turns: 1 });
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(usages).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.messages).toEqual([{ role: 'user', content: 'do the thing' }]);
    expect(body.tools.map((t: any) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash']);
    for (const t of body.tools) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect([...t.input_schema.required].sort()).toEqual(Object.keys(t.input_schema.properties).sort());
    }
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toContain(RETURN_CONTRACT);
    expect(body.system[0].text).toContain('Always answer in lowercase.');
  });

  it('omits output_config when no effort is given', async () => {
    const { client, bodies } = scripted([reply([text('x')], 'end_turn')]);
    await runnerFor(client).run(makeReq().req);
    expect(bodies[0].output_config).toBeUndefined();
  });

  it('runs a tool and sends its result back', async () => {
    const { client, bodies } = scripted([
      reply([toolUse('tu_1', 'read_file', { path: 'notes.txt', offset: null, limit: null })], 'tool_use'),
      reply([text('done')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq().req);
    expect(res).toMatchObject({ result: 'done', status: 'ok', turns: 2 });
    const tr = lastMessage(bodies[1]).content[0];
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('tu_1');
    expect(tr.is_error).toBeUndefined();
    expect(JSON.stringify(tr.content)).toContain('beta');
  });

  it('tool error (missing file) → tool_result is_error:true and the agent continues', async () => {
    const { client, bodies } = scripted([
      reply([toolUse('tu_1', 'read_file', { path: 'missing.txt', offset: null, limit: null })], 'tool_use'),
      reply([text('file is missing')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq().req);
    expect(res).toMatchObject({ result: 'file is missing', status: 'ok', turns: 2 });
    const tr = lastMessage(bodies[1]).content[0];
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: true });
    expect(JSON.stringify(tr.content)).toContain('ENOENT');
  });

  it('calls onUsage once per model turn with that turn’s tokens, immediately', async () => {
    const seenAtRequest: number[] = [];
    let usageCount = 0;
    const { client } = scripted([
      (_b) => {
        seenAtRequest.push(usageCount);
        return new Response(
          JSON.stringify(
            reply([toolUse('t1', 'glob', { pattern: '*.txt' })], 'tool_use', { output_tokens: 7 }).body,
          ),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
      (_b) => {
        seenAtRequest.push(usageCount);
        return new Response(
          JSON.stringify(reply([text('ok')], 'end_turn', { output_tokens: 11, input_tokens: 3 }).body),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    ]);
    const { req, usages } = makeReq({
      onUsage: (u) => {
        usageCount++;
        usages.push(u);
      },
    });
    const res = await runnerFor(client).run(req);
    expect(usages.map((u) => u.output_tokens)).toEqual([7, 11]);
    expect(seenAtRequest).toEqual([0, 1]); // turn 1 reported before turn 2 was requested
    expect(res.usage).toEqual({ input_tokens: 13, output_tokens: 18 });
    expect(res.turns).toBe(2);
  });

  it('40 tool_use turns → null and a "turn cap" log line', async () => {
    const steps = Array.from({ length: 41 }, (_, i) =>
      reply([toolUse(`t${i}`, 'glob', { pattern: '*.none' })], 'tool_use'),
    );
    const { client, bodies } = scripted(steps);
    const { req, logs, usages } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(res.result).toBeNull();
    expect(res.status).toBe('null');
    expect(res.turns).toBe(40);
    expect(bodies).toHaveLength(40);
    expect(usages).toHaveLength(40);
    expect(logs.some((l) => l.includes('turn cap'))).toBe(true);
  });

  it('refusal → null, exactly one request, category logged', async () => {
    const { client, bodies } = scripted([
      reply([], 'refusal', {}, { stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' } }),
      reply([text('should not be reached')], 'end_turn'),
    ]);
    const { req, logs } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', turns: 1 });
    expect(bodies).toHaveLength(1);
    expect(logs.join('\n')).toContain('cyber');
  });

  it('max_tokens → exactly one "continue" request, texts joined', async () => {
    const { client, bodies } = scripted([
      reply([text('part one, ')], 'max_tokens'),
      reply([text('part two')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq().req);
    expect(res).toMatchObject({ result: 'part one, part two', status: 'ok', turns: 2 });
    expect(bodies).toHaveLength(2);
    const msgs = bodies[1].messages;
    expect(msgs[msgs.length - 2]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'part one, ' }],
    });
    expect(msgs[msgs.length - 1].role).toBe('user');
    expect(msgs[msgs.length - 1].content).toMatch(/devam et.*continue/);
  });

  it('second max_tokens → null, no third request', async () => {
    const { client, bodies } = scripted([
      reply([text('a')], 'max_tokens'),
      reply([text('b')], 'max_tokens'),
      reply([text('c')], 'end_turn'),
    ]);
    const { req, logs } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', turns: 2 });
    expect(bodies).toHaveLength(2);
    expect(logs.join('\n')).toContain('max_tokens');
  });

  it('max_tokens with a cut-off tool_use drops that block before continuing', async () => {
    const { client, bodies } = scripted([
      reply([text('thinking '), toolUse('t1', 'glob', { pattern: '*' })], 'max_tokens'),
      reply([text('fin')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq().req);
    expect(res.result).toBe('thinking fin');
    expect(JSON.stringify(bodies[1].messages)).not.toContain('tool_use');
  });

  it('400 → null immediately, error text logged, no retry', async () => {
    const { client, bodies } = scripted([
      apiError(400, 'invalid_request_error', 'bad schema somewhere'),
      reply([text('x')], 'end_turn'),
    ]);
    const { req, logs } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', turns: 0 });
    expect(bodies).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/400.*bad schema somewhere/);
  });

  it('429 once → runner-level retry succeeds', async () => {
    const { client, bodies } = scripted([
      apiError(429, 'rate_limit_error', 'slow down'),
      reply([text('ok')], 'end_turn'),
    ]);
    const { req, logs } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: 'ok', status: 'ok', turns: 1 });
    expect(bodies).toHaveLength(2);
    expect(logs.join('\n')).toContain('429');
  });

  it('429 twice → null after one runner-level retry', async () => {
    const { client, bodies } = scripted([
      apiError(429, 'rate_limit_error', 'slow down'),
      apiError(529, 'overloaded_error', 'overloaded'),
      reply([text('ok')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq().req);
    expect(res).toMatchObject({ result: null, status: 'null' });
    expect(bodies).toHaveLength(2);
  });

  it('retry mid-loop continues from the transcript without re-running finished tools', async () => {
    let runs = 0;
    const counting: ToolDef = {
      name: 'count',
      description: 'counts',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      write: false,
      async run() {
        runs++;
        return `run ${runs}`;
      },
    };
    const { client, bodies } = scripted([
      reply([toolUse('t1', 'count', {})], 'tool_use'),
      apiError(500, 'api_error', 'boom'),
      reply([text('done')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq({ tools: [counting] }).req);
    expect(res).toMatchObject({ result: 'done', status: 'ok', turns: 2 });
    expect(runs).toBe(1);
    expect(bodies[2].messages).toEqual(bodies[1].messages);
    expect(lastMessage(bodies[2]).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'run 1',
    });
  });

  it('budget abort mid-run (signal aborted from onUsage after turn 1) → skipped, no further requests', async () => {
    const ac = new AbortController();
    const { client, bodies } = scripted([
      reply([toolUse('t1', 'read_file', { path: 'notes.txt', offset: null, limit: null })], 'tool_use'),
      reply([text('never')], 'end_turn'),
    ]);
    const { req } = makeReq({ signal: ac.signal, onUsage: () => ac.abort() });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 1 });
    expect(res.usage.output_tokens).toBe(5);
    expect(bodies).toHaveLength(1);
  });

  it('abort while a request is in flight cancels it → skipped', async () => {
    const ac = new AbortController();
    let sawAbort = false;
    const { client, bodies } = scripted([
      (_b, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    ]);
    const { req } = makeReq({ signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'skipped', turns: 0 });
    expect(sawAbort).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it('already-aborted signal → skipped without any request', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, bodies } = scripted([reply([text('x')], 'end_turn')]);
    const res = await runnerFor(client).run(makeReq({ signal: ac.signal }).req);
    expect(res.status).toBe('skipped');
    expect(bodies).toHaveLength(0);
  });

  it('write tool without isolation throws (runner-level enforcement)', async () => {
    const { client, bodies } = scripted([reply([text('x')], 'end_turn')]);
    const tools = buildTools(['read_file', 'write_file'], true);
    const runner = runnerFor(client);
    await expect(runner.run(makeReq({ tools, isolated: false }).req)).rejects.toThrowError(MaestroError);
    await runner.run(makeReq({ tools, isolated: false }).req).catch((e) => {
      expect(e.code).toBe('write_tool_without_isolation');
    });
    expect(bodies).toHaveLength(0);
    const ok = await runner.run(makeReq({ tools, isolated: true }).req);
    expect(ok.status).toBe('ok');
  });
});

describe('AnthropicRunner: prompt caching', () => {
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  };

  it('breakpoint on the system block (tools + system), automatic breakpoint for the transcript', async () => {
    const { client, bodies } = scripted([
      reply([toolUse('t1', 'read_file', { path: 'notes.txt' })], 'tool_use'),
      reply([text('done')], 'end_turn'),
    ]);
    const { req } = makeReq({ prompt: 'volatile prompt with args {"x":1}' });
    const res = await runnerFor(client).run(req);
    expect(res.status).toBe('ok');
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      // Render order is tools → system → messages: the stable part ends at the last system block.
      expect(body.system).toEqual([{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]);
      expect(body.cache_control).toEqual({ type: 'ephemeral' });
      expect(body.tools.some((t: any) => 'cache_control' in t)).toBe(false);
      // The prompt is volatile and stays after the breakpoint, unmarked.
      expect(body.messages[0]).toEqual({ role: 'user', content: 'volatile prompt with args {"x":1}' });
    }
    // Same prefix on both turns: the second request only appends to the first.
    expect(bodies[1].tools).toEqual(bodies[0].tools);
    expect(bodies[1].system).toEqual(bodies[0].system);
    expect(bodies[1].messages.slice(0, 1)).toEqual(bodies[0].messages);
  });

  it('stage 2 keeps only the system breakpoint (no automatic write of the whole transcript)', async () => {
    const { client, bodies } = scripted([
      reply([text('looked')], 'end_turn'),
      reply([text('{"ok":true}')], 'end_turn'),
    ]);
    const { req } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ status: 'ok', result: { ok: true } });
    const stage2 = bodies[1];
    expect(stage2.system).toEqual([{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }]);
    expect(stage2.cache_control).toBeUndefined();
  });

  it('cache figures reach onUsage per turn and the summed usage', async () => {
    const { client } = scripted([
      reply(
        [toolUse('t1', 'read_file', { path: 'notes.txt' })],
        'tool_use',
        {},
        {
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 900,
          },
        },
      ),
      reply(
        [text('done')],
        'end_turn',
        {},
        {
          usage: {
            input_tokens: 30,
            output_tokens: 7,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 40,
          },
        },
      ),
    ]);
    const { req, usages } = makeReq();
    const res = await runnerFor(client).run(req);
    expect(usages).toEqual([
      { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 },
      { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 },
    ]);
    expect(res.usage).toEqual({
      input_tokens: 50,
      output_tokens: 12,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 940,
    });
  });
});

describe('AnthropicRunner: structured final (stage 2)', () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      items: {
        type: 'array',
        items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    required: ['count', 'items'],
  };

  it('first structured answer does not match → second parse returns the object; turns +2', async () => {
    const { client, bodies } = scripted([
      reply([text('I looked around.')], 'end_turn'),
      reply([text('{"count":"three","items":[]}')], 'end_turn'),
      reply([text('{"count":3,"items":[{"name":"a"}]}')], 'end_turn'),
    ]);
    const original = structuredClone(schema);
    const { req, usages } = makeReq({ schema, effort: 'high' });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: { count: 3, items: [{ name: 'a' }] }, status: 'ok', turns: 3 });
    expect(usages).toHaveLength(3);
    expect(bodies).toHaveLength(3);
    for (const body of bodies.slice(1)) {
      expect(lastMessage(body)).toEqual({
        role: 'user',
        content: expect.stringMatching(/Bulgularını şemaya göre döndür.*schema/),
      });
      expect(body.messages[body.messages.length - 2]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'I looked around.' }],
      });
      expect(body.output_config.effort).toBe('high');
      expect(body.output_config.format.type).toBe('json_schema');
      const s = body.output_config.format.schema;
      expect(s.additionalProperties).toBe(false);
      expect(s.properties.items.items.additionalProperties).toBe(false);
      expect(body.tool_choice).toEqual({ type: 'none' });
      expect(body.tools.every((t: any) => t.strict === true)).toBe(true);
    }
    expect(schema).toEqual(original); // the script's schema is not mutated
  });

  it('parse fails twice → null, status null, raw text kept', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([text('not json')], 'end_turn'),
      reply([text('{"count": 1')], 'end_turn'),
      reply([text('{"count":1,"items":[]}')], 'end_turn'),
    ]);
    const { req, logs } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', raw: '{"count": 1', turns: 3 });
    expect(bodies).toHaveLength(3);
    expect(logs.join('\n')).toContain('schema parse failed twice');
  });

  it('stage-2 transcript carries the tool calls of stage 1', async () => {
    const { client, bodies } = scripted([
      reply([toolUse('t1', 'glob', { pattern: '*.txt' })], 'tool_use'),
      reply([text('found notes')], 'end_turn'),
      reply([text('{"count":1,"items":[{"name":"notes.txt"}]}')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq({ schema }).req);
    expect(res).toMatchObject({
      status: 'ok',
      turns: 3,
      result: { count: 1, items: [{ name: 'notes.txt' }] },
    });
    const msgs = bodies[2].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(bodies[2].tools.map((t: any) => t.name)).toEqual(['read_file', 'grep', 'glob', 'bash']);
  });

  it('refusal during stage 2 → null without retry', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([], 'refusal', {}, { stop_details: { type: 'refusal', category: 'bio', explanation: null } }),
      reply([text('{"count":1,"items":[]}')], 'end_turn'),
    ]);
    const { req, logs } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', turns: 2 });
    expect(bodies).toHaveLength(2);
    expect(logs.join('\n')).toContain('bio');
  });

  it('429 during stage 2 → one retry of the same parse request', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      apiError(429, 'rate_limit_error', 'slow'),
      reply([text('{"count":2,"items":[]}')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq({ schema }).req);
    expect(res).toMatchObject({ result: { count: 2, items: [] }, status: 'ok', turns: 2 });
    expect(bodies[2].messages).toEqual(bodies[1].messages);
  });
});

describe('systemPrompt and schema helpers', () => {
  it('contains the return contract and CLAUDE.md; writer gets the commit instruction', async () => {
    const reader = systemPrompt({ cwd, writer: false });
    expect(reader).toContain('Son mesajın bu çağrının dönüş değeridir');
    expect(reader).toContain('return value');
    expect(reader).toContain('Always answer in lowercase.');
    expect(reader).not.toContain('git_commit');
    const writer = systemPrompt({ cwd, writer: true });
    expect(writer).toContain(WRITER_INSTRUCTION);
    expect(writer).toContain('git_commit');
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-nomd-'));
    expect(systemPrompt({ cwd: empty, writer: false })).toBe(RETURN_CONTRACT);
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('toStructuredOutputSchema closes every object and moves unsupported constraints', () => {
    const s = toStructuredOutputSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 1 },
        maybe: { type: ['object', 'null'], properties: { a: { type: 'string', minLength: 2 } } },
        alt: { oneOf: [{ type: 'object', properties: {} }, { type: 'string' }] },
      },
      required: ['n'],
      additionalProperties: true,
    }) as any;
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.n).toEqual({ type: 'integer', description: '{minimum: 1}' });
    expect(s.properties.maybe.additionalProperties).toBe(false);
    expect(s.properties.maybe.properties.a.minLength).toBeUndefined();
    expect(s.properties.alt.anyOf[0].additionalProperties).toBe(false);
  });

  it('validateValue checks types, required, enums, nested items', () => {
    const schema = {
      type: 'object',
      properties: { k: { enum: ['a', 'b'] }, xs: { type: 'array', items: { type: 'integer' } } },
      required: ['k'],
    };
    expect(validateValue(schema, { k: 'a', xs: [1, 2] })).toEqual([]);
    expect(validateValue(schema, { xs: [1] }).join()).toContain('required');
    expect(validateValue(schema, { k: 'c' }).join()).toContain('enum');
    expect(validateValue(schema, { k: 'a', xs: [1.5] }).join()).toContain('integer');
  });

  it('validateValue does not take inherited Object.prototype names for properties', () => {
    const strict = { type: 'object', properties: {}, required: ['constructor'], additionalProperties: false };
    expect(validateValue(strict, {}).join()).toContain('required');
    const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(validateValue(closed, { a: 'x', toString: 1 }).join()).toContain('additional property');
  });

  it('validateValue checks anyOf and oneOf when a schema has both', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'number' }], oneOf: [{ type: 'number' }] };
    expect(validateValue(schema, 1)).toEqual([]);
    expect(validateValue(schema, 'x').join()).toContain('matches no alternative');
  });
});

describe('AnthropicRunner: stage-2 max_tokens (spec 3.2)', () => {
  const schema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] };

  it('a structured reply cut by max_tokens is a failed parse; the retry raises max_tokens', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([text('{"count": 12')], 'max_tokens'),
      reply([text('{"count":12}')], 'end_turn'),
    ]);
    const { req, logs } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: { count: 12 }, status: 'ok', turns: 3 });
    expect(bodies.map((b) => b.max_tokens)).toEqual([16_000, 16_000, 32_000]);
    // No "continue" turn: the retry is the same parse request apart from max_tokens.
    expect(bodies[2].messages).toEqual(bodies[1].messages);
    expect(logs.join('\n')).toContain('cut by max_tokens; retrying with max_tokens 32000');
  });

  it('a plain parse failure retries with the same max_tokens', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([text('not json')], 'end_turn'),
      reply([text('{"count":1}')], 'end_turn'),
    ]);
    const res = await runnerFor(client).run(makeReq({ schema }).req);
    expect(res.status).toBe('ok');
    expect(bodies[2].max_tokens).toBe(bodies[1].max_tokens);
  });

  it('max_tokens on the last attempt only → null, no raise announced', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([text('not json')], 'end_turn'),
      reply([text('{"count": 1')], 'max_tokens'),
    ]);
    const { req, logs } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res.status).toBe('null');
    expect(bodies[2].max_tokens).toBe(bodies[1].max_tokens);
    expect(logs.join('\n')).not.toContain('retrying with max_tokens');
  });

  it('max_tokens on both parse attempts → null, no third request', async () => {
    const { client, bodies } = scripted([
      reply([text('notes')], 'end_turn'),
      reply([text('{"count": 1')], 'max_tokens'),
      reply([text('{"count": 1')], 'max_tokens'),
      reply([text('{"count":1}')], 'end_turn'),
    ]);
    const { req, logs } = makeReq({ schema });
    const res = await runnerFor(client).run(req);
    expect(res).toMatchObject({ result: null, status: 'null', raw: '{"count": 1', turns: 3 });
    expect(bodies).toHaveLength(3);
    expect(logs.join('\n')).toContain('schema parse failed twice');
  });

  it('the raise is capped; a maxTokens at or above the cap is not raised', () => {
    expect(new AnthropicRunner()).toMatchObject({
      maxTokens: LIMITS.maxTokensPerTurn,
      maxRequestTokens: LIMITS.maxTokensPerTurnRaised,
    });
    expect(new AnthropicRunner({ maxTokens: 20_000 }).maxRequestTokens).toBe(LIMITS.maxTokensPerTurnRaised);
    expect(new AnthropicRunner({ maxTokens: 50_000 }).maxRequestTokens).toBe(50_000);
  });
});

describe('AnthropicRunner: default client keeps the SDK retries (spec 3.2 Hata halleri)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('persistent 529: 3 SDK attempts × 2 runner tries = 6 requests, then null', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-dummy');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
    // Never reach Anthropic, even if the fetch stub were bypassed.
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9');
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      urls.push(String(url));
      // retry-after-ms keeps the SDK's own backoff at 1 ms.
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        {
          status: 529,
          headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
        },
      );
    });
    const runner = new AnthropicRunner({ retryDelayMs: 0 });
    expect(runner.client.maxRetries).toBe(2);
    const { req, logs } = makeReq();
    const res = await runner.run(req);
    expect(res).toMatchObject({ result: null, status: 'null' });
    expect(urls).toHaveLength(6);
    expect(urls.every((u) => u.startsWith('http://127.0.0.1:9/'))).toBe(true);
    expect(logs.join('\n')).toMatch(/529.*retrying once/);
  });
});

describe('writer system prompt: no package installs (spec 3.6)', () => {
  it('the writer is told not to run npm install; a reader is not', () => {
    const writer = systemPrompt({ cwd, writer: true });
    expect(writer).toContain('Do not run npm install');
    expect(writer).toContain('node_modules');
    expect(systemPrompt({ cwd, writer: false })).not.toContain('npm install');
  });
});
