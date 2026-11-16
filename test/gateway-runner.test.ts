import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayRunner, type GatewayRunnerOptions } from '../src/index.js';
import { AnthropicRunner, SUBMIT_RESULT_TOOL_NAME } from '../src/runner.js';
import type { RunRequest, Usage } from '../src/types.js';
import { run } from '../src/workflow.js';
import { mockGateway, textReply, toolReply } from './gateway-helpers.js';

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-gateway-')));
  vi.stubEnv('AI_GATEWAY_API_KEY', 'gateway-env-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated-anthropic-key');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'unrelated-anthropic-token');
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unrelated.invalid');
  vi.stubEnv('ANTHROPIC_LOG', 'debug');
  mockGateway();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

function request(overrides: Partial<RunRequest> = {}) {
  const usages: Usage[] = [];
  const logs: string[] = [];
  const req: RunRequest = {
    prompt: 'hello',
    system: 'Return a result.',
    model: 'openai/gpt-5.4',
    tools: [],
    cwd,
    isolated: false,
    signal: new AbortController().signal,
    onUsage: (u) => usages.push(u),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { req, usages, logs };
}

const schema = {
  type: 'object',
  properties: { count: { type: 'integer', minimum: 2 }, note: { type: 'string' } },
  required: ['count'],
  additionalProperties: false,
};

describe('GatewayRunner', () => {
  it.each([
    'openai/gpt-5.4',
    'anthropic/claude-sonnet-4.6',
    'google/gemini-3.1-pro-preview',
    'future/new-model',
  ])('sends %s unchanged to the fixed endpoint with isolated credentials', async (model) => {
    const { requests } = mockGateway(textReply());
    const opts: GatewayRunnerOptions = { apiKey: 'explicit-gateway-key', maxTokens: 1234 };
    const runner = new GatewayRunner(opts);
    const res = await runner.run(request({ model, effort: 'low' }).req);
    expect(res).toMatchObject({ result: 'done', status: 'ok', turns: 1 });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.url).toBe('https://ai-gateway.vercel.sh/v1/messages');
    expect(sent.headers.get('authorization')).toBe('Bearer explicit-gateway-key');
    expect(sent.headers.has('x-api-key')).toBe(false);
    expect(JSON.stringify([...sent.headers])).not.toContain('unrelated');
    expect(sent.body).toMatchObject({ model, max_tokens: 1234, output_config: { effort: 'low' } });
    expect(sent.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(sent.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(runner.maxRequestTokens).toBe(2468);
    expect(runner.client.logLevel).toBe('off');
  });

  it('uses only AI_GATEWAY_API_KEY as its environment fallback and constructs the client lazily', async () => {
    const { fetch, requests } = mockGateway(textReply());
    const runner = new GatewayRunner();
    expect(fetch).not.toHaveBeenCalled();
    await runner.run(request().req);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer gateway-env-key');
  });

  it.each([undefined, '', ' \n '])(
    'rejects a missing/blank key (%j) without Anthropic fallback',
    async (key) => {
      vi.stubEnv('AI_GATEWAY_API_KEY', key);
      const { fetch } = mockGateway();
      const { req, logs } = request();
      const res = await new GatewayRunner().run(req);
      expect(res).toMatchObject({ status: 'null', result: null, turns: 0 });
      expect(res.error).toContain('AI_GATEWAY_API_KEY is missing or blank');
      expect(res.error).toContain('apiKey');
      expect(logs.join(' ')).not.toContain('unrelated');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('an explicit blank key does not fall back to the environment', async () => {
    expect((await new GatewayRunner({ apiKey: ' ' }).run(request().req)).error).toContain('missing or blank');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'claude-opus-5-5',
    'gpt-5.4',
    'openai/',
    '/gpt-5.4',
    'openai/gpt 5.4',
    ' openai/gpt-5.4',
    'a/b/c',
  ])('rejects invalid model %j with every supported selection path', async (model) => {
    await expect(new GatewayRunner().run(request({ model }).req)).rejects.toMatchObject({
      message: expect.stringMatching(/--model.*run\(\{ model \}\).*agent opts.model/),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the real tool result loop, context, usage and traces', async () => {
    const tool = {
      name: 'echo',
      description: 'Echo a string',
      write: false,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      run: vi.fn(async (input: { text: string }) => `echo: ${input.text}`),
    };
    const { requests } = mockGateway(toolReply('echo', { text: 'hi' }), textReply());
    const { req, usages } = request({ tools: [tool] });
    const res = await new GatewayRunner().run(req);
    expect(tool.run).toHaveBeenCalledExactlyOnceWith({ text: 'hi' }, { cwd, signal: req.signal });
    expect(requests[1]!.body.messages.at(-1).content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_gateway', content: 'echo: hi' },
    ]);
    expect(res).toMatchObject({
      status: 'ok',
      result: 'done',
      turns: 2,
      usage: {
        input_tokens: 20,
        output_tokens: 10,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 6,
      },
      trace: { toolCalls: [{ tool: 'echo', inputSummary: '{"text":"hi"}', ok: true }], finalText: 'done' },
    });
    expect(usages).toHaveLength(2);
    expect(requests[0]!.body.tools[0].strict).toBe(true);
  });

  it('defaults to strict submit-tool, strips synthetic nulls and validates original constraints', async () => {
    const { requests } = mockGateway(
      toolReply(SUBMIT_RESULT_TOOL_NAME, { count: 1, note: null }),
      toolReply(SUBMIT_RESULT_TOOL_NAME, { count: 2, note: null }),
    );
    const runner = new GatewayRunner();
    expect(runner.structuredMode).toBe('submit-tool');
    expect(new AnthropicRunner().structuredMode).toBe('two-stage');
    const { req, logs } = request({ schema });
    const res = await runner.run(req);
    expect(res).toMatchObject({ status: 'ok', result: { count: 2 }, turns: 2 });
    expect(logs.join(' ')).toContain('below minimum');
    const submit = requests[0]!.body.tools[0];
    expect(submit).toMatchObject({
      name: SUBMIT_RESULT_TOOL_NAME,
      strict: true,
      input_schema: {
        required: ['count', 'note'],
        additionalProperties: false,
        properties: { note: { type: ['string', 'null'] } },
      },
    });
    expect(submit.input_schema.properties.count.minimum).toBeUndefined();
    expect(requests[0]!.body.output_config).toBeUndefined();
    expect(requests[1]!.body.messages.at(-1).content[0].is_error).toBe(true);
  });

  it.each(['single-stage', 'two-stage'] as const)(
    'honors explicit %s output mode',
    async (structuredMode) => {
      const replies =
        structuredMode === 'two-stage'
          ? [textReply('findings'), textReply('{"count":2}')]
          : [textReply('{"count":2}')];
      const { requests } = mockGateway(...replies);
      const res = await new GatewayRunner({ structuredMode }).run(request({ schema }).req);
      expect(res).toMatchObject({ status: 'ok', result: { count: 2 } });
      expect(requests.at(-1)!.body.output_config.format.type).toBe('json_schema');
      expect(requests[0]!.body.tools.some((t: any) => t.name === SUBMIT_RESULT_TOOL_NAME)).toBe(false);
    },
  );

  it('retains isolation enforcement before making requests', async () => {
    await expect(
      new GatewayRunner().run(
        request({
          tools: [
            {
              name: 'write',
              description: 'Write',
              write: true,
              inputSchema: { type: 'object' },
              run: async () => 'done',
            },
          ],
        }).req,
      ),
    ).rejects.toMatchObject({ code: 'write_tool_without_isolation' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains pre-abort and usage-budget cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await new GatewayRunner({ apiKey: '' }).run(request({ signal: controller.signal }).req),
    ).toMatchObject({ status: 'skipped', turns: 0 });
    expect(fetch).not.toHaveBeenCalled();
    const active = new AbortController();
    const { requests } = mockGateway(textReply());
    const res = await new GatewayRunner().run(
      request({ signal: active.signal, onUsage: () => active.abort() }).req,
    );
    expect(res).toMatchObject({ status: 'skipped', turns: 1, usage: { output_tokens: 5 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards cancellation to an in-flight SDK request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      throw new Error('request aborted');
    });
    vi.stubGlobal('fetch', fetch);
    const result = await new GatewayRunner().run(request({ signal: controller.signal }).req);
    expect(result).toMatchObject({ status: 'skipped', turns: 0, error: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains SDK retries followed by the runner retry', async () => {
    const transient = () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      });
    const { requests } = mockGateway(transient(), transient(), transient(), textReply());
    const res = await new GatewayRunner({ retryDelayMs: 0 }).run(request().req);
    expect(res).toMatchObject({ status: 'ok', result: 'done' });
    expect(requests).toHaveLength(4);
  });

  it('redacts a key echoed by an API error from diagnostics', async () => {
    mockGateway(
      new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'bad gateway-env-key' },
        }),
        { status: 401 },
      ),
    );
    const { req, logs } = request();
    const res = await new GatewayRunner().run(req);
    expect(res.status).toBe('null');
    expect(res.error).toContain('[REDACTED]');
    expect(JSON.stringify({ res, logs })).not.toContain('gateway-env-key');
  });

  it('library workflows select a default and override it per agent', async () => {
    const { requests } = mockGateway(textReply('a'), textReply('b'));
    const handle = run({
      cwd,
      runner: new GatewayRunner(),
      model: 'openai/gpt-5.4',
      script: `
export const meta = { name: 'gateway', description: 'd' };
const a = await agent('default');
const b = await agent('override', { model: 'google/gemini-3.1-pro-preview' });
return { a, b };`,
    });
    expect(await handle.promise).toEqual({ a: 'a', b: 'b' });
    expect(requests.map((r) => r.body.model)).toEqual(['openai/gpt-5.4', 'google/gemini-3.1-pro-preview']);
  });
});
