import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { OpenAIRunner, openaiModelId } from '../src/index.js';
import { COMMIT_REMINDER_MESSAGE, SUBMIT_RESULT_TOOL_NAME } from '../src/runner.js';
import type { RunRequest, ToolDef, Usage } from '../src/types.js';
import { run } from '../src/workflow.js';

const execFileAsync = promisify(execFile);

// ---- Responses API fakes ----------------------------------------------------------------------

const USAGE = { input_tokens: 30, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } };

function response(output: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 'resp_1', object: 'response', status: 'completed', output, usage: USAGE, ...extra };
}
const message = (text: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
const textReply = (text = 'done') => response([message(text)]);
const callReply = (name: string, args: unknown, callId = 'call_1') =>
  response([
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
    {
      type: 'function_call',
      id: `fc_${callId}`,
      call_id: callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      status: 'completed',
    },
  ]);
const errorReply = (status: number, msg: string, code?: string) =>
  new Response(JSON.stringify({ error: { message: msg, type: 'error', code: code ?? null } }), { status });

function mockOpenAI(...replies: Array<unknown | Response>) {
  const requests: Array<{ url: string; headers: Headers; body: any; signal: unknown }> = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
    });
    const reply = replies.shift();
    if (reply === undefined) throw new Error('Unexpected OpenAI request');
    return reply instanceof Response
      ? reply
      : new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, requests };
}

let cwd: string;
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-openai-')));
  vi.stubEnv('OPENAI_API_KEY', 'sk-env-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'unrelated-anthropic-key');
  vi.stubEnv('AI_GATEWAY_API_KEY', 'unrelated-gateway-key');
  mockOpenAI();
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
    model: 'gpt-6.2-astra',
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

const echo = (): ToolDef & { run: ReturnType<typeof vi.fn> } => ({
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
});

// ---- Tests ------------------------------------------------------------------------------------

describe('OpenAIRunner', () => {
  it('sends a stateless Responses request with the OpenAI key only', async () => {
    const { requests } = mockOpenAI(textReply());
    const runner = new OpenAIRunner({ apiKey: 'sk-explicit', maxTokens: 1234 });
    const { req, usages } = request({ model: 'openai/gpt-6.2-astra', effort: 'max' });
    const res = await runner.run(req);
    expect(res).toMatchObject({ result: 'done', status: 'ok', turns: 1, trace: { finalText: 'done' } });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.url).toBe('https://api.openai.com/v1/responses');
    expect(sent.headers.get('authorization')).toBe('Bearer sk-explicit');
    expect(JSON.stringify([...sent.headers])).not.toContain('unrelated');
    expect(sent.body).toEqual({
      model: 'gpt-6.2-astra',
      instructions: 'Return a result.',
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'max' },
      input: [{ role: 'user', content: 'hello' }],
      max_output_tokens: 1234,
    });
    // Cached tokens are inside OpenAI's input_tokens; Maestro counts them separately.
    expect(usages).toEqual([{ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 }]);
    expect(runner.maxRequestTokens).toBe(2468);
  });

  it('uses OPENAI_API_KEY as its environment fallback and honors baseURL', async () => {
    const { requests } = mockOpenAI(textReply());
    await new OpenAIRunner({ baseURL: 'https://proxy.example/v1/' }).run(request().req);
    expect(requests[0]!.url).toBe('https://proxy.example/v1/responses');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sk-env-key');
  });

  it.each([undefined, '', ' \n '])('fails a missing/blank key (%j) without a request', async (key) => {
    vi.stubEnv('OPENAI_API_KEY', key);
    const { fetch } = mockOpenAI();
    const res = await new OpenAIRunner().run(request().req);
    expect(res).toMatchObject({ status: 'null', result: null, turns: 0 });
    expect(res.error).toContain('OPENAI_API_KEY is missing or blank');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['claude-opus-5-5', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.1-pro'])(
    'rejects non-OpenAI model %j',
    async (model) => {
      const { fetch } = mockOpenAI();
      await expect(new OpenAIRunner().run(request({ model }).req)).rejects.toMatchObject({
        message: expect.stringMatching(/OpenAI model ID.*--model.*agent opts.model/),
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('normalizes Gateway-style openai/ IDs', () => {
    expect(openaiModelId('openai/gpt-6.2-astra')).toBe('gpt-6.2-astra');
    expect(openaiModelId(' gpt-6-luna ')).toBe('gpt-6-luna');
  });

  it('runs the tool loop and passes reasoning and function call items back', async () => {
    const tool = echo();
    const { requests } = mockOpenAI(callReply('echo', { text: 'hi' }), textReply());
    const { req, usages } = request({ tools: [tool] });
    const res = await new OpenAIRunner().run(req);
    expect(tool.run).toHaveBeenCalledExactlyOnceWith({ text: 'hi' }, { cwd, signal: req.signal });
    expect(requests[0]!.body.tools).toEqual([
      {
        type: 'function',
        name: 'echo',
        description: 'Echo a string',
        parameters: tool.inputSchema,
        strict: true,
      },
    ]);
    const second = requests[1]!.body.input;
    expect(second.map((i: any) => i.type ?? i.role)).toEqual([
      'user',
      'reasoning',
      'function_call',
      'function_call_output',
    ]);
    expect(second[1].encrypted_content).toBe('enc');
    expect(second[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'echo: hi' });
    expect(res).toMatchObject({
      status: 'ok',
      result: 'done',
      turns: 2,
      usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 40 },
      trace: { toolCalls: [{ tool: 'echo', inputSummary: '{"text":"hi"}', ok: true }] },
    });
    expect(usages).toHaveLength(2);
  });

  it('reports tool errors, unknown tools and bad JSON to the model and continues', async () => {
    const tool = echo();
    tool.run.mockRejectedValueOnce(new Error('boom'));
    const { requests } = mockOpenAI(
      callReply('echo', { text: 'a' }),
      callReply('nope', {}),
      callReply('echo', '{not json'),
      textReply(),
    );
    const res = await new OpenAIRunner().run(request({ tools: [tool] }).req);
    expect(res.status).toBe('ok');
    const outputs = requests.slice(1).map((r) => r.body.input.at(-1).output);
    expect(outputs).toEqual([
      'Error: boom',
      'Error: unknown tool nope.',
      'Error: the arguments of echo were not valid JSON.',
    ]);
    expect(res.trace!.toolCalls.map((c) => c.ok)).toEqual([false, false, false]);
  });

  it('defaults to submit-tool, strips synthetic nulls and validates the original schema', async () => {
    const { requests } = mockOpenAI(
      callReply(SUBMIT_RESULT_TOOL_NAME, { count: 1, note: null }),
      callReply(SUBMIT_RESULT_TOOL_NAME, { count: 2, note: null }),
    );
    const runner = new OpenAIRunner();
    expect(runner.structuredMode).toBe('submit-tool');
    const { req, logs } = request({ schema });
    const res = await runner.run(req);
    expect(res).toMatchObject({ status: 'ok', result: { count: 2 }, turns: 2 });
    expect(res.result).toEqual({ count: 2 });
    expect(logs.join(' ')).toContain('below minimum');
    const submit = requests[0]!.body.tools[0];
    expect(submit).toMatchObject({
      name: SUBMIT_RESULT_TOOL_NAME,
      strict: true,
      parameters: {
        required: ['count', 'note'],
        additionalProperties: false,
        properties: { note: { type: ['string', 'null'] } },
      },
    });
    expect(requests[0]!.body.instructions).toContain(SUBMIT_RESULT_TOOL_NAME);
    expect(requests[0]!.body.text).toBeUndefined();
    expect(requests[1]!.body.input.at(-1).output).toMatch(/^Error: Output failed schema validation/);
  });

  it('submit-tool accepts raw JSON text, else reminds once, then fails with raw', async () => {
    mockOpenAI(textReply('{"count":3}'));
    expect(await new OpenAIRunner().run(request({ schema }).req)).toMatchObject({ result: { count: 3 } });
    const { requests } = mockOpenAI(textReply('prose'), textReply('more prose'));
    const res = await new OpenAIRunner().run(request({ schema }).req);
    expect(res).toMatchObject({ status: 'null', error: 'schema parse failed twice', raw: 'more prose' });
    expect(requests[1]!.body.input.at(-1).content).toContain(SUBMIT_RESULT_TOOL_NAME);
  });

  it('two-stage asks for the schema in a second request with tools disabled', async () => {
    const tool = echo();
    const { requests } = mockOpenAI(
      callReply('echo', { text: 'hi' }),
      textReply('findings'),
      textReply('{"count":2,"note":null}'),
    );
    const res = await new OpenAIRunner({ structuredMode: 'two-stage' }).run(
      request({ schema, tools: [tool] }).req,
    );
    expect(res).toMatchObject({ status: 'ok', result: { count: 2 }, turns: 3 });
    const last = requests[2]!.body;
    expect(last.tool_choice).toBe('none');
    expect(last.text.format).toMatchObject({ type: 'json_schema', name: 'result', strict: true });
    expect(last.input.at(-1)).toEqual({
      role: 'user',
      content: 'Return your findings in the required schema.',
    });
    expect(requests[0]!.body.text).toBeUndefined();
  });

  it('single-stage formats every turn and falls back to one stage-2 request', async () => {
    const { requests } = mockOpenAI(textReply('{"count":1}'), textReply('{"count":2}'));
    const { req, logs } = request({ schema });
    const res = await new OpenAIRunner({ structuredMode: 'single-stage' }).run(req);
    expect(res).toMatchObject({ status: 'ok', result: { count: 2 } });
    expect(requests[0]!.body.text.format.type).toBe('json_schema');
    expect(logs.join(' ')).toContain('schema parse attempt 1');
  });

  it('continues once after max_output_tokens, dropping a cut-off function call', async () => {
    const cut = response(
      [message('part one, '), { type: 'function_call', call_id: 'c', name: 'echo', arguments: '{"te' }],
      { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    );
    const { requests } = mockOpenAI(cut, textReply('part two'));
    const res = await new OpenAIRunner().run(request({ tools: [echo()] }).req);
    expect(res).toMatchObject({ status: 'ok', result: 'part one, part two' });
    const input = requests[1]!.body.input;
    expect(input.some((i: any) => i.type === 'function_call')).toBe(false);
    expect(input.at(-1).content).toMatch(/^Continue/);
    mockOpenAI(cut, cut);
    expect((await new OpenAIRunner().run(request().req)).error).toBe(
      'max_tokens reached again after one continuation',
    );
  });

  it('turns a refusal or content filter into a null result', async () => {
    mockOpenAI(
      response([{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }]),
    );
    expect(await new OpenAIRunner().run(request().req)).toMatchObject({
      status: 'null',
      error: 'refusal: no',
    });
    mockOpenAI(response([], { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }));
    expect((await new OpenAIRunner().run(request().req)).error).toContain('content_filter');
  });

  it('enforces the turn cap', async () => {
    mockOpenAI(callReply('echo', { text: '1' }), callReply('echo', { text: '2' }));
    const res = await new OpenAIRunner({ maxTurns: 2 }).run(request({ tools: [echo()] }).req);
    expect(res).toMatchObject({ status: 'null', error: 'turn cap: agent still calling tools after 2 turns' });
  });

  it('retries 429/5xx with backoff but not an exhausted quota or a 400', async () => {
    const { requests } = mockOpenAI(errorReply(500, 'busy'), errorReply(429, 'slow down'), textReply());
    const { req, logs } = request();
    expect(await new OpenAIRunner({ retryDelayMs: 0 }).run(req)).toMatchObject({ status: 'ok' });
    expect(requests).toHaveLength(3);
    expect(logs[0]).toContain('API error 500: busy');
    const quota = mockOpenAI(errorReply(429, 'quota', 'insufficient_quota'));
    expect((await new OpenAIRunner({ retryDelayMs: 0 }).run(request().req)).error).toBe(
      'API error 429: quota',
    );
    expect(quota.requests).toHaveLength(1);
    mockOpenAI(errorReply(400, 'bad model'));
    expect((await new OpenAIRunner().run(request().req)).error).toBe('400 bad request: bad model');
  });

  it('drops the encrypted-reasoning include once a model refuses it', async () => {
    const { requests } = mockOpenAI(
      errorReply(400, "Encrypted content is not supported with this model. Remove 'include'."),
      textReply('a'),
      textReply('b'),
    );
    const runner = new OpenAIRunner();
    await runner.run(request().req);
    await runner.run(request().req);
    expect(requests.map((r) => 'include' in r.body)).toEqual([true, false, false]);
  });

  it('redacts a key echoed by an API error from diagnostics', async () => {
    mockOpenAI(errorReply(401, 'Incorrect API key provided: sk-env-key'));
    const { req, logs } = request();
    const res = await new OpenAIRunner().run(req);
    expect(res.error).toContain('[REDACTED]');
    expect(JSON.stringify({ res, logs })).not.toContain('sk-env-key');
  });

  it('retains isolation enforcement and cancellation', async () => {
    const write: ToolDef = { ...echo(), name: 'write', write: true };
    await expect(new OpenAIRunner().run(request({ tools: [write] }).req)).rejects.toMatchObject({
      code: 'write_tool_without_isolation',
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await new OpenAIRunner().run(request({ signal: aborted.signal }).req)).toMatchObject({
      status: 'skipped',
      turns: 0,
    });
    const active = new AbortController();
    mockOpenAI(textReply());
    const res = await new OpenAIRunner().run(
      request({ signal: active.signal, onUsage: () => active.abort() }).req,
    );
    expect(res).toMatchObject({ status: 'skipped', turns: 1 });
  });

  it('delivers a live follow-up before the next model request', async () => {
    let handler: ((m: string) => Promise<void>) | undefined;
    const tool = echo();
    let delivered: Promise<void> | undefined;
    tool.run.mockImplementation(async () => {
      delivered = handler!('also check tests');
      return 'ok';
    });
    const { requests } = mockOpenAI(callReply('echo', { text: 'x' }), textReply());
    const res = await new OpenAIRunner().run(
      request({
        tools: [tool],
        registerMessageHandler: (h) => {
          handler = h;
          return () => {};
        },
      }).req,
    );
    await expect(delivered).resolves.toBeUndefined();
    expect(res.status).toBe('ok');
    expect(requests[1]!.body.input.at(-1)).toEqual({ role: 'user', content: 'also check tests' });
  });

  it('reminds an isolated writer once to commit', async () => {
    await execFileAsync('git', ['init', '-q'], { cwd });
    await writeFile(path.join(cwd, 'dirty.txt'), 'x');
    const { requests } = mockOpenAI(textReply('first'), textReply('second'));
    const write: ToolDef = { ...echo(), name: 'write', write: true };
    const res = await new OpenAIRunner().run(request({ tools: [write], isolated: true }).req);
    expect(res).toMatchObject({ status: 'ok', result: 'second' });
    expect(requests[1]!.body.input.at(-1).content).toBe(COMMIT_REMINDER_MESSAGE);
  });

  it('library workflows select a default model and override it per agent', async () => {
    const { requests } = mockOpenAI(textReply('a'), textReply('b'));
    const handle = run({
      cwd,
      runner: new OpenAIRunner(),
      model: 'gpt-6.2-astra',
      script: `
export const meta = { name: 'openai', description: 'd' };
const a = await agent('default');
const b = await agent('override', { model: 'gpt-6-luna' });
return { a, b };`,
    });
    expect(await handle.promise).toEqual({ a: 'a', b: 'b' });
    expect(requests.map((r) => r.body.model)).toEqual(['gpt-6.2-astra', 'gpt-6-luna']);
  });
});

describe('--runner openai', () => {
  async function cli(flags: string[], env: Record<string, string | undefined>) {
    await writeFile(
      path.join(cwd, 'demo.js'),
      `export const meta = { name: 'openai-cli', description: 'd' };\nreturn await agent('hello');`,
    );
    let stdout = '';
    let stderr = '';
    const code = await main(['run', 'demo.js', '--runner', 'openai', ...flags], {
      cwd,
      env,
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s), isTTY: false },
    });
    return { code, stdout, stderr };
  }

  it('runs with the io.env key and --model', async () => {
    const { requests } = mockOpenAI(textReply('hi'));
    const res = await cli(['--model', 'gpt-6.2-astra'], { OPENAI_API_KEY: 'sk-cli' });
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toBe('hi');
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer sk-cli');
    expect(requests[0]!.body.model).toBe('gpt-6.2-astra');
  });

  it.each([{}, { OPENAI_API_KEY: ' ' }])('preflights a missing/blank key: %j', async (env) => {
    const { fetch } = mockOpenAI();
    const res = await cli(['--model', 'gpt-6.2-astra'], env);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('OPENAI_API_KEY is missing or blank');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects the implicit Claude default model', async () => {
    const { fetch } = mockOpenAI();
    const res = await cli([], { OPENAI_API_KEY: 'sk-cli' });
    expect(JSON.parse(res.stdout)).toBeNull();
    expect(res.stderr).toContain('needs an OpenAI model ID');
    expect(fetch).not.toHaveBeenCalled();
  });
});
