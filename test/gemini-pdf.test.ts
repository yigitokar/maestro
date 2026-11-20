import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Interactions } from '@google/genai';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexRunner } from '../src/codex-runner.js';
import { GatewayRunner } from '../src/gateway-runner.js';
import {
  type GeminiInteractionResponse,
  type GeminiInteractionsClient,
  GeminiRunner,
} from '../src/gemini-runner.js';
import { checkPdfInputs } from '../src/pdf-input.js';
import { RoutingRunner } from '../src/routing-runner.js';
import { AnthropicRunner } from '../src/runner.js';
import type { RunRequest } from '../src/types.js';
import { run } from '../src/workflow.js';

type CreateParams = Interactions.InteractionCreateParams.CreateModelInteractionParamsNonStreaming;

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const pdf = (name: string) => Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF`).toString('base64');

function textReply(text: string): GeminiInteractionResponse {
  return {
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 10, total_output_tokens: 2 },
  } as GeminiInteractionResponse;
}

function mockClient(...replies: GeminiInteractionResponse[]) {
  const calls: CreateParams[] = [];
  const client: GeminiInteractionsClient = {
    interactions: {
      async create(params) {
        calls.push(structuredClone(params));
        const next = replies.shift();
        if (!next) throw new Error(`unexpected create() call #${calls.length}`);
        return next;
      },
    },
  };
  return { client, calls };
}

function request(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    prompt: 'Compare the two reports.',
    system: 'Return only the requested answer.',
    tools: [],
    model: 'gemini-4-hydrogen',
    cwd: process.cwd(),
    isolated: false,
    signal: new AbortController().signal,
    onUsage: () => {},
    log: () => {},
    ...overrides,
  };
}

describe('Gemini PDF inputs', () => {
  it('validates the pdfs option shape', () => {
    expect(() => checkPdfInputs(undefined, false)).not.toThrow();
    expect(() => checkPdfInputs([], false)).not.toThrow();
    expect(() => checkPdfInputs([pdf('a')], true)).not.toThrow();
    expect(() => checkPdfInputs('abc', true)).toThrow(/must be an array/);
    expect(() => checkPdfInputs([''], true)).toThrow(/pdfs\[0\] must be a non-empty base64/);
    expect(() => checkPdfInputs([pdf('a'), 'data:application/pdf;base64,AAAA'], true)).toThrow(/pdfs\[1\]/);
    expect(() => checkPdfInputs([pdf('a')], false)).toThrow(/require the Gemini runner/);
  });

  it('sends ordered PDFs as document blocks before the prompt and keys the cache on their bytes', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-gemini-pdfs-'));
    dirs.push(cwd);
    const { client, calls } = mockClient(textReply('first'), textReply('updated'));
    const runner = new RoutingRunner({ gemini: new GeminiRunner({ client }) });
    const script = `export const meta = { name: 'compare', description: 'compare two reports' };
      const call = agent('Compare the two reports.', { model: 'gemini-4-hydrogen', tools: [], pdfs: args.pdfs });
      args.pdfs.reverse();
      return await call;`;
    const h = run({ cwd, runner, script, args: { pdfs: [pdf('first report'), pdf('second report')] } });
    expect(await h.promise).toBe('first');
    const resume = (pdfs: string[]) => run({ cwd, runner, resumeFromRunId: h.runId, args: { pdfs } }).promise;
    expect(await resume([pdf('first report'), pdf('second report')])).toBe('first');
    expect(await resume([pdf('first report'), pdf('corrected report')])).toBe('updated');
    expect(calls).toHaveLength(2);
    const content = (second: string) => [
      { type: 'document', mime_type: 'application/pdf', data: pdf('first report') },
      { type: 'document', mime_type: 'application/pdf', data: pdf(second) },
      { type: 'text', text: 'Compare the two reports.' },
    ];
    expect(calls[0]!.input).toEqual([{ type: 'user_input', content: content('second report') }]);
    expect(calls[1]!.input).toEqual([{ type: 'user_input', content: content('corrected report') }]);
  });

  it('makes agent() throw at the call site for malformed pdfs', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-gemini-pdfs-'));
    dirs.push(cwd);
    const { client, calls } = mockClient();
    const script = `export const meta = { name: 'bad', description: 'bad pdfs' };
      try { agent('x', { model: 'gemini-4-hydrogen', pdfs: ['./report.pdf'] }); return 'no throw'; }
      catch (e) { return e.message; }`;
    const out = await run({ cwd, runner: new GeminiRunner({ client }), script }).promise;
    expect(out).toMatch(/pdfs\[0\] must be a non-empty base64-encoded PDF/);
    expect(calls).toHaveLength(0);
  });

  it('rejects PDF inputs on text-only runners before contacting a provider', async () => {
    const req = request({ pdfs: [pdf('report')] });
    const codex = new CodexRunner({ bin: '/nonexistent-codex' });
    const router = new RoutingRunner({ codex, anthropic: new AnthropicRunner() });
    for (const [runner, model] of [
      [new AnthropicRunner(), 'claude-model'],
      [codex, 'gpt-model'],
      [new GatewayRunner({ apiKey: 'test-key' }), 'google/gemini-4-hydrogen'],
      [router, 'gpt-model'],
      [router, 'claude-model'],
    ] as const) {
      expect(await runner.run({ ...req, model })).toMatchObject({
        status: 'null',
        turns: 0,
        error: expect.stringContaining('PDF inputs require the Gemini runner'),
      });
    }
  });
});
