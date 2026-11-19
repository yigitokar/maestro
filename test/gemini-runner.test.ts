import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Interactions } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GEMINI_MODEL,
  type GeminiInteractionResponse,
  type GeminiInteractionsClient,
  GeminiRunner,
  geminiUsageOf,
  resolveGeminiModel,
  toGeminiThinkingLevel,
} from '../src/gemini-runner.js';
import { COMMIT_REMINDER_MESSAGE, SUBMIT_RESULT_TOOL_NAME } from '../src/runner.js';
import type { AgentProgress, RunRequest, ToolDef, Usage } from '../src/types.js';
import { MaestroError } from '../src/types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

type CreateParams = Interactions.InteractionCreateParams.CreateModelInteractionParamsNonStreaming;

function makeMockClient(
  replies: Array<
    | GeminiInteractionResponse
    | Error
    | ((
        params: CreateParams,
        callIndex: number,
      ) => GeminiInteractionResponse | Promise<GeminiInteractionResponse>)
  >,
) {
  const calls: CreateParams[] = [];
  let idx = 0;
  const client: GeminiInteractionsClient = {
    interactions: {
      async create(params) {
        calls.push(structuredClone(params));
        const item = replies[idx++];
        if (item === undefined) throw new Error(`unexpected create() call #${idx}`);
        if (item instanceof Error) throw item;
        if (typeof item === 'function') return await item(params, idx - 1);
        return item;
      },
    },
  };
  return { client, calls };
}

function makeReq(overrides: Partial<RunRequest> = {}): {
  req: RunRequest;
  usages: Usage[];
  logs: string[];
  progress: AgentProgress[];
  controller: AbortController;
} {
  const controller = new AbortController();
  const usages: Usage[] = [];
  const logs: string[] = [];
  const progress: AgentProgress[] = [];
  const req: RunRequest = {
    prompt: 'Analyze the codebase',
    system: 'Return raw data.',
    tools: [],
    model: 'gemini-4-hydrogen',
    cwd: process.cwd(),
    signal: controller.signal,
    isolated: false,
    onUsage: (u) => usages.push(u),
    log: (m) => logs.push(m),
    onProgress: (p) => progress.push(p),
    ...overrides,
  };
  return { req, usages, logs, progress, controller };
}

describe('GeminiRunner helpers', () => {
  it('resolves Gemini model IDs, strips google/ prefix, and replaces Claude defaults', () => {
    expect(resolveGeminiModel('gemini-4-carbon')).toBe('gemini-4-carbon');
    expect(resolveGeminiModel('google/gemini-4-argon')).toBe('gemini-4-argon');
    expect(resolveGeminiModel('gemma-4-31b-it')).toBe('gemma-4-31b-it');
    expect(resolveGeminiModel('claude-opus-5-5')).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel('anthropic/claude-sonnet-5-5')).toBe(DEFAULT_GEMINI_MODEL);
    expect(resolveGeminiModel('claude-opus-5-5', 'google/gemini-3.5-flash-lite')).toBe(
      'gemini-3.5-flash-lite',
    );
  });

  it('maps Maestro Effort levels to Gemini ThinkingLevel', () => {
    expect(toGeminiThinkingLevel(undefined)).toBeUndefined();
    expect(toGeminiThinkingLevel('low')).toBe('low');
    expect(toGeminiThinkingLevel('medium')).toBe('medium');
    expect(toGeminiThinkingLevel('high')).toBe('high');
    expect(toGeminiThinkingLevel('xhigh')).toBe('high');
    expect(toGeminiThinkingLevel('max')).toBe('high');
  });

  it('converts Gemini usage (subtracting cached input and adding thought tokens to output)', () => {
    expect(
      geminiUsageOf({
        total_input_tokens: 1_000,
        total_cached_tokens: 750,
        total_output_tokens: 120,
        total_thought_tokens: 280,
      }),
    ).toEqual({
      input_tokens: 250,
      cache_read_input_tokens: 750,
      output_tokens: 400,
    });
    expect(geminiUsageOf({ total_input_tokens: 50, total_output_tokens: 10 })).toEqual({
      input_tokens: 50,
      output_tokens: 10,
    });
  });
});

describe('GeminiRunner execution', () => {
  it('rejects write tools without worktree isolation immediately', async () => {
    const { client } = makeMockClient([]);
    const runner = new GeminiRunner({ client });
    const writeTool: ToolDef = {
      name: 'write_file',
      description: 'write',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      write: true,
      run: async () => 'ok',
    };
    const { req } = makeReq({ tools: [writeTool], isolated: false });
    await expect(runner.run(req)).rejects.toBeInstanceOf(MaestroError);
  });

  it('runs a multi-turn tool loop, preserves thought steps, records traces, and reports per-turn usage', async () => {
    const readTool: ToolDef = {
      name: 'lookup',
      description: 'Lookup a key',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      write: false,
      async run(input) {
        if (input.key === 'boom') throw new Error('not found');
        return `value:${input.key}`;
      },
    };
    const { client, calls } = makeMockClient([
      {
        status: 'requires_action',
        steps: [
          { type: 'thought', signature: 'sig-1', summary: [{ type: 'text', text: 'checking' }] },
          { type: 'function_call', id: 'c1', name: 'lookup', arguments: { key: 'alpha' } },
          { type: 'function_call', id: 'c2', name: 'lookup', arguments: { key: 'boom' } },
        ],
        usage: {
          total_input_tokens: 400,
          total_cached_tokens: 100,
          total_output_tokens: 30,
          total_thought_tokens: 20,
        },
      },
      {
        status: 'completed',
        output_text: 'final answer',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'final answer' }] }],
        usage: { total_input_tokens: 600, total_cached_tokens: 400, total_output_tokens: 15 },
      },
    ]);

    const runner = new GeminiRunner({ client });
    const { req, usages, progress } = makeReq({ tools: [readTool], effort: 'high' });
    const res = await runner.run(req);

    expect(res.status).toBe('ok');
    expect(res.result).toBe('final answer');
    expect(res.turns).toBe(2);
    expect(usages).toEqual([
      { input_tokens: 300, cache_read_input_tokens: 100, output_tokens: 50 },
      { input_tokens: 200, cache_read_input_tokens: 400, output_tokens: 15 },
    ]);
    expect(res.usage).toEqual({ input_tokens: 500, cache_read_input_tokens: 500, output_tokens: 65 });
    expect(res.trace).toEqual({
      toolCalls: [
        { tool: 'lookup', inputSummary: '{"key":"alpha"}', ok: true },
        { tool: 'lookup', inputSummary: '{"key":"boom"}', ok: false },
      ],
      finalText: 'final answer',
    });
    expect(progress.some((p) => p.activity === 'tool' && p.tool === 'lookup')).toBe(true);

    // Second request includes thought step (with signature) and both function_result steps.
    const secondInput = calls[1]!.input as Interactions.Step[];
    expect(secondInput.some((s) => s.type === 'thought' && s.signature === 'sig-1')).toBe(true);
    const fnResults = secondInput.filter((s) => s.type === 'function_result');
    expect(fnResults).toEqual([
      { type: 'function_result', call_id: 'c1', name: 'lookup', result: 'value:alpha' },
      { type: 'function_result', call_id: 'c2', name: 'lookup', result: 'not found', is_error: true },
    ]);
    expect(calls[0]!.generation_config?.thinking_level).toBe('high');
    expect(calls[0]!.store).toBe(false);
  });

  it('supports two-stage structured output with retry and raised max_output_tokens on incomplete', async () => {
    const schema = {
      type: 'object',
      properties: { score: { type: 'integer', minimum: 1 } },
      required: ['score'],
    };
    const { client, calls } = makeMockClient([
      {
        status: 'completed',
        output_text: 'Analysis prose',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Analysis prose' }] }],
        usage: { total_input_tokens: 100, total_output_tokens: 40 },
      },
      {
        status: 'incomplete',
        output_text: '{"score":',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"score":' }] }],
        usage: { total_input_tokens: 150, total_output_tokens: 100 },
      },
      {
        status: 'completed',
        output_text: '{"score": 5}',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"score": 5}' }] }],
        usage: { total_input_tokens: 150, total_output_tokens: 10 },
      },
    ]);

    const runner = new GeminiRunner({ client, maxTokens: 1_000, structuredMode: 'two-stage' });
    const { req } = makeReq({ schema });
    const res = await runner.run(req);

    expect(res.status).toBe('ok');
    expect(res.result).toEqual({ score: 5 });
    expect(calls[1]!.response_format).toMatchObject({ type: 'text', mime_type: 'application/json' });
    expect(calls[1]!.generation_config?.max_output_tokens).toBe(1_000);
    expect(calls[2]!.generation_config?.max_output_tokens).toBe(2_000);
  });

  it('supports submit-tool structured mode (fast path and validation retry)', async () => {
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, note: { type: 'string' } },
      required: ['verdict'],
    };
    const { client, calls } = makeMockClient([
      {
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'sub1',
            name: SUBMIT_RESULT_TOOL_NAME,
            arguments: { verdict: 'maybe', note: null },
          },
        ],
        usage: { total_input_tokens: 80, total_output_tokens: 20 },
      },
      {
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'sub2',
            name: SUBMIT_RESULT_TOOL_NAME,
            arguments: { verdict: 'pass', note: null },
          },
        ],
        usage: { total_input_tokens: 120, total_output_tokens: 15 },
      },
    ]);

    const runner = new GeminiRunner({ client, structuredMode: 'submit-tool' });
    const { req } = makeReq({ schema });
    const res = await runner.run(req);

    expect(res.status).toBe('ok');
    // Synthetic null on optional `note` is stripped.
    expect(res.result).toEqual({ verdict: 'pass' });
    expect(calls).toHaveLength(2);
    const secondInput = calls[1]!.input as Interactions.Step[];
    expect(secondInput.some((s) => s.type === 'function_result' && s.is_error === true)).toBe(true);
  });

  it('supports single-stage structured mode and falls back to stage 2 on validation error', async () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 10 } },
      required: ['count'],
    };
    const { client, calls } = makeMockClient([
      {
        status: 'completed',
        output_text: '{"count": 2}',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"count": 2}' }] }],
        usage: { total_input_tokens: 50, total_output_tokens: 10 },
      },
      {
        status: 'completed',
        output_text: '{"count": 12}',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"count": 12}' }] }],
        usage: { total_input_tokens: 70, total_output_tokens: 10 },
      },
    ]);

    const runner = new GeminiRunner({ client, structuredMode: 'single-stage' });
    const { req } = makeReq({ schema });
    const res = await runner.run(req);

    expect(res.status).toBe('ok');
    expect(res.result).toEqual({ count: 12 });
    expect(calls[0]!.response_format).toMatchObject({ type: 'text', mime_type: 'application/json' });
  });

  it('retries once on transient 429/5xx errors and fails cleanly on 400', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    const { client } = makeMockClient([
      err429,
      {
        status: 'completed',
        output_text: 'recovered',
        usage: { total_input_tokens: 10, total_output_tokens: 5 },
      },
    ]);
    const runner = new GeminiRunner({ client, retryDelayMs: 1 });
    const { req, logs } = makeReq();
    const res = await runner.run(req);
    expect(res.status).toBe('ok');
    expect(res.result).toBe('recovered');
    expect(logs.some((l) => l.includes('429') && l.includes('retrying once'))).toBe(true);

    const err400 = Object.assign(new Error('bad schema'), { status: 400 });
    const { client: client2, calls: calls2 } = makeMockClient([err400]);
    const runner2 = new GeminiRunner({ client: client2, retryDelayMs: 1 });
    const { req: req2 } = makeReq();
    const res2 = await runner2.run(req2);
    expect(res2.status).toBe('null');
    expect(res2.error).toContain('400 bad request');
    expect(calls2).toHaveLength(1);
  });

  it('delivers live follow-up messages before the next model turn and rejects undelivered on finish', async () => {
    let sendLive: ((msg: string) => Promise<void>) | undefined;
    const { client, calls } = makeMockClient([
      async () => {
        // Queue a follow-up while turn 1 is completing.
        void sendLive?.('Focus on edge cases.');
        return {
          status: 'completed',
          output_text: 'first pass',
          steps: [{ type: 'model_output', content: [{ type: 'text', text: 'first pass' }] }],
          usage: { total_input_tokens: 20, total_output_tokens: 10 },
        };
      },
      {
        status: 'completed',
        output_text: 'refined pass',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'refined pass' }] }],
        usage: { total_input_tokens: 30, total_output_tokens: 10 },
      },
    ]);

    const runner = new GeminiRunner({ client });
    const { req } = makeReq({
      registerMessageHandler(handler) {
        sendLive = handler;
        return () => {
          sendLive = undefined;
        };
      },
    });
    const res = await runner.run(req);
    expect(res.status).toBe('ok');
    expect(res.result).toBe('refined pass');
    const secondInput = calls[1]!.input as Interactions.Step[];
    expect(
      secondInput.some(
        (s) =>
          s.type === 'user_input' &&
          s.content?.some((c) => c.type === 'text' && c.text === 'Focus on edge cases.'),
      ),
    ).toBe(true);
  });

  it('prompts isolated writers once when uncommitted changes remain', async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), 'maestro-gemini-git-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted\n');

    const writerTool: ToolDef = {
      name: 'write_file',
      description: 'write',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      write: true,
      run: async () => 'ok',
    };
    const { client, calls } = makeMockClient([
      {
        status: 'completed',
        output_text: 'done editing',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'done editing' }] }],
        usage: { total_input_tokens: 10, total_output_tokens: 5 },
      },
      {
        status: 'completed',
        output_text: 'committed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'committed' }] }],
        usage: { total_input_tokens: 20, total_output_tokens: 5 },
      },
    ]);
    const runner = new GeminiRunner({ client });
    const { req } = makeReq({ cwd: repo, isolated: true, tools: [writerTool] });
    const res = await runner.run(req);

    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(2);
    const secondInput = calls[1]!.input as Interactions.Step[];
    expect(
      secondInput.some(
        (s) =>
          s.type === 'user_input' &&
          s.content?.some((c) => c.type === 'text' && c.text === COMMIT_REMINDER_MESSAGE),
      ),
    ).toBe(true);
  });

  it('redacts apiKey from errors and fails gracefully when credentials are missing', async () => {
    const secret = 'AIza-super-secret-test-key';
    const { client } = makeMockClient([new Error(`upstream rejected ${secret}`)]);
    const runner = new GeminiRunner({ client, apiKey: secret });
    const { req, logs } = makeReq();
    const res = await runner.run(req);
    expect(res.status).toBe('null');
    expect(res.error).not.toContain(secret);
    expect(res.error).toContain('[REDACTED]');
    expect(logs.join('\n')).not.toContain(secret);

    const noKeyRunner = new GeminiRunner({ apiKey: '' });
    const { req: req2 } = makeReq();
    const res2 = await noKeyRunner.run(req2);
    expect(res2.status).toBe('null');
    expect(res2.error).toContain('GEMINI_API_KEY');
  });

  it('returns status skipped when aborted', async () => {
    const { client } = makeMockClient([]);
    const runner = new GeminiRunner({ client });
    const { req, controller } = makeReq();
    controller.abort();
    const res = await runner.run(req);
    expect(res.status).toBe('skipped');
    expect(res.result).toBeNull();
  });
});
