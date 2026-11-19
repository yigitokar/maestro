import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { CodexRunner } from '../src/codex-runner.js';
import { GatewayRunner } from '../src/gateway-runner.js';
import { GeminiRunner } from '../src/gemini-runner.js';
import { RoutingRunner } from '../src/routing-runner.js';
import { AnthropicRunner } from '../src/runner.js';
import type { RunRequest, ToolDef } from '../src/types.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true });
});

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'Scan the project',
    system: 'Return only the requested answer.',
    tools: [],
    model: 'gemini-2.5-flash',
    cwd: process.cwd(),
    isolated: false,
    signal: new AbortController().signal,
    onUsage: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function reply(parts: unknown[]) {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 100,
      cachedContentTokenCount: 20,
      candidatesTokenCount: 6,
      thoughtsTokenCount: 4,
      toolUsePromptTokenCount: 3,
    },
  };
}

function mockGemini(...responses: unknown[]) {
  const requests: Array<{ url: string; headers: Headers; body: any; signal: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
        signal: init.signal,
      });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected Gemini request');
      return response instanceof Response ? response : Response.json(response);
    }),
  );
  return requests;
}

const readNote: ToolDef = {
  name: 'read_note',
  description: 'Read a note',
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  write: false,
  run: async ({ name }) => name,
};
const schema = {
  type: 'object',
  properties: { count: { type: 'integer', minimum: 2 } },
  required: ['count'],
};

describe('GeminiRunner', () => {
  it('executes only allowed tools and preserves call IDs, signatures and per-turn usage', async () => {
    const parts = [
      { thought: true, text: 'private' },
      { functionCall: { id: 'a', name: 'read_note', args: { name: 'notes' } }, thoughtSignature: 'opaque' },
      { functionCall: { id: 'b', name: 'other', args: {} } },
      { functionCall: { id: 'c', name: 'read_note', args: {} } },
    ];
    const requests = mockGemini(reply(parts), reply([{ thought: true, text: 'private' }, { text: 'done' }]));
    const tool = { ...readNote, run: vi.fn(readNote.run) };
    const req = request({ tools: [tool], model: 'google/gemini-2.5-flash' });
    const res = await new GeminiRunner({ apiKey: 'test-key' }).run(req);
    expect(res).toMatchObject({
      result: 'done',
      status: 'ok',
      turns: 2,
      usage: { input_tokens: 166, output_tokens: 20, cache_read_input_tokens: 40 },
      trace: {
        finalText: 'done',
        toolCalls: [
          { tool: 'read_note', ok: true },
          { tool: 'other', ok: false },
          { tool: 'read_note', ok: false },
        ],
      },
    });
    expect(tool.run).toHaveBeenCalledExactlyOnceWith({ name: 'notes' }, { cwd: req.cwd, signal: req.signal });
    expect(req.onUsage).toHaveBeenCalledTimes(2);
    expect(requests[0]!.headers.get('x-goog-api-key')).toBe('test-key');
    expect(requests[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(requests[0]!.signal).toBe(req.signal);
    expect(requests[0]!.body.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(tool.inputSchema);
    expect(requests[1]!.body.contents[1].parts).toEqual(parts);
    expect(requests[1]!.body.contents[2].parts).toEqual([
      { functionResponse: { id: 'a', name: 'read_note', response: { output: 'notes' } } },
      {
        functionResponse: {
          id: 'b',
          name: 'other',
          response: { error: expect.stringContaining('Unknown tool') },
        },
      },
      {
        functionResponse: {
          id: 'c',
          name: 'read_note',
          response: { error: expect.stringContaining('required') },
        },
      },
    ]);
  });

  it('sends ordered PDFs as native Gemini parts and invalidates the run cache when one changes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-gemini-pdfs-'));
    dirs.push(cwd);
    const pdf = (name: string) => Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF`).toString('base64');
    const runner = new RoutingRunner({ gemini: { apiKey: 'test-key' } });
    const script = `export const meta = { name: 'compare', description: 'compare two reports' };
      const call = agent('Compare the two reports.', { model: 'gemini-3.6-flash', tools: [], pdfs: args.pdfs });
      args.pdfs.reverse();
      return await call;`;
    const requests = mockGemini(reply([{ text: 'first' }]), reply([{ text: 'updated' }]));
    const args = { pdfs: [pdf('first report'), pdf('second report')] };
    const h = run({ cwd, runner, script, args });
    expect(await h.promise).toBe('first');
    const resume = (pdfs: string[]) => run({ cwd, runner, resumeFromRunId: h.runId, args: { pdfs } }).promise;
    expect(await resume([pdf('first report'), pdf('second report')])).toBe('first');
    expect(await resume([pdf('first report'), pdf('corrected report')])).toBe('updated');
    expect(requests).toHaveLength(2);
    const parts = (second: string) => [
      { inlineData: { mimeType: 'application/pdf', data: pdf('first report') } },
      { inlineData: { mimeType: 'application/pdf', data: pdf(second) } },
      { text: 'Compare the two reports.' },
    ];
    expect(requests[0]!.body.contents[0].parts).toEqual(parts('second report'));
    expect(requests[1]!.body.contents[0].parts).toEqual(parts('corrected report'));
  });

  it('rejects PDF inputs on text-only routes before starting a provider or Codex process', async () => {
    const req = request({ pdfs: [Buffer.from('%PDF-1.4').toString('base64')] });
    const requests = mockGemini();
    const codex = new CodexRunner({ bin: '/nonexistent-codex' });
    const router = new RoutingRunner({ codex });
    for (const [runner, model] of [
      [new AnthropicRunner(), 'claude-model'],
      [codex, 'gpt-model'],
      [new GatewayRunner(), 'google/gemini-3.6-flash'],
      [router, 'gpt-model'],
      [router, 'claude-model'],
    ] as const) {
      expect(await runner.run({ ...req, model })).toMatchObject({
        status: 'null',
        turns: 0,
        error: expect.stringContaining('PDF inputs require the Gemini runner'),
      });
    }
    expect(requests).toHaveLength(0);
  });

  it('rejects a file path passed as PDF data without contacting Gemini', async () => {
    const requests = mockGemini();
    expect(
      await new GeminiRunner({ apiKey: 'test-key' }).run(request({ pdfs: ['./report.pdf'] })),
    ).toMatchObject({
      status: 'null',
      turns: 0,
      error: expect.stringContaining('pdfs[0] must be a non-empty base64-encoded PDF'),
    });
    expect(requests).toHaveLength(0);
  });

  it('requests native JSON separately from tools, validates it locally and retries once', async () => {
    const requests = mockGemini(
      reply([{ functionCall: { id: 'count', name: 'read_note', args: { name: 'notes' } } }]),
      reply([{ text: 'Two entries.' }]),
      reply([{ text: '{"count":1}' }]),
      reply([{ text: '{"count":2}' }]),
    );
    const res = await new GeminiRunner({ apiKey: 'test-key', maxTokens: 1024 }).run(
      request({ tools: [readNote], schema }),
    );
    expect(res).toMatchObject({
      status: 'ok',
      result: { count: 2 },
      turns: 4,
      trace: { finalText: 'Two entries.' },
    });
    expect(requests[0]!.body.generationConfig.responseFormat).toBeUndefined();
    expect(requests[1]!.body.contents.at(-1).parts[0].functionResponse).toEqual({
      id: 'count',
      name: 'read_note',
      response: { output: 'notes' },
    });
    expect(requests[2]!.body.tools).toBeUndefined();
    expect(requests[2]!.body.generationConfig).toEqual({
      responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema } },
      maxOutputTokens: 1024,
    });
    expect(requests[3]!.body.contents.at(-1).parts[0].text).toContain('below minimum');
  });

  it('retains invalid raw output for diagnosis when the repair also fails', async () => {
    const requests = mockGemini(reply([{ text: 'bad' }]), reply([{ text: 'still bad' }]));
    const res = await new GeminiRunner({ apiKey: 'test-key' }).run(request({ schema }));
    expect(res).toMatchObject({
      result: null,
      status: 'null',
      error: expect.stringMatching(/invalid JSON/),
      raw: 'still bad',
    });
    expect(requests[0]!.body.generationConfig.responseFormat.text.schema).toEqual(schema);
  });

  it('preserves a truncated public response for inspection without running partial tool calls', async () => {
    const tool = { ...readNote, run: vi.fn(readNote.run) };
    mockGemini({
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          finishMessage: 'Truncated the tool arguments',
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'private' },
              { text: 'partial output' },
              { functionCall: { name: 'read_note', args: { name: 'foo' } } },
            ],
          },
        },
      ],
    });
    const res = await new GeminiRunner({ apiKey: 'test-key' }).run(request({ tools: [tool] }));
    expect(res).toMatchObject({
      status: 'null',
      result: null,
      raw: 'partial output',
      error: expect.stringContaining('(MAX_TOKENS): Truncated the tool arguments'),
    });
    expect(tool.run).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain('private');
  });

  it('preserves prompt blocking and cancellation and redacts API keys echoed by errors', async () => {
    const requests = mockGemini(
      { promptFeedback: { blockReason: 'SAFETY' } },
      reply([{ text: 'done' }]),
      Response.json({ error: { message: 'invalid test-key' } }, { status: 403 }),
    );
    const runner = new GeminiRunner({ apiKey: 'test-key' });
    expect(await runner.run(request())).toMatchObject({
      status: 'null',
      error: expect.stringContaining('SAFETY'),
    });
    const controller = new AbortController();
    expect(
      await runner.run(request({ signal: controller.signal, onUsage: () => controller.abort() })),
    ).toMatchObject({ status: 'skipped', usage: { output_tokens: 10 } });
    expect(await runner.run(request())).toMatchObject({
      status: 'null',
      error: 'Gemini API error 403: invalid [REDACTED]',
    });
    expect(requests).toHaveLength(3);
  });

  it('rejects missing credentials, malformed models and unisolated writers before fetch', async () => {
    const requests = mockGemini();
    const runner = new GeminiRunner({ apiKey: 'test-key' });
    expect((await new GeminiRunner({ apiKey: ' ' }).run(request())).error).toContain('GEMINI_API_KEY');
    expect((await runner.run(request({ model: 'gemini-path/escape' }))).error).toContain('gemini-* model ID');
    await expect(runner.run(request({ tools: [{ ...readNote, write: true }] }))).rejects.toHaveProperty(
      'code',
      'write_tool_without_isolation',
    );
    expect(requests).toHaveLength(0);
  });

  it.each(['gemini', 'auto'])(
    'selects a Gemini default and per-agent override through --runner %s',
    async (runner) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-cli-gemini-'));
      dirs.push(cwd);
      const filename = path.join(cwd, 'flow.js');
      await writeFile(
        filename,
        `export const meta = { name: 'gemini-cli', description: 'd' };
      const a = await agent('first');
      return [a, await agent('second', { model: 'google/gemini-2.5-pro' })];`,
      );
      const requests = mockGemini(reply([{ text: 'a' }]), reply([{ text: 'b' }]));
      const stdout = new PassThrough();
      const code = await main(['run', filename, '--runner', runner, '--model', 'gemini-2.5-flash'], {
        cwd,
        env: { GEMINI_API_KEY: 'cli-key' },
        stderr: new PassThrough(),
        stdout,
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout.read().toString())).toEqual(['a', 'b']);
      expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
        '/v1beta/models/gemini-2.5-flash:generateContent',
        '/v1beta/models/gemini-2.5-pro:generateContent',
      ]);
      expect(requests.every((r) => r.headers.get('x-goog-api-key') === 'cli-key')).toBe(true);
    },
  );
});
