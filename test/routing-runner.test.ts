import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GeminiRunner } from '../src/gemini-runner.js';
import { defaultModelRoute, RoutingRunner } from '../src/routing-runner.js';
import { AnthropicRunner } from '../src/runner.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { AgentRunner, RunRequest } from '../src/types.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('RoutingRunner & defaultModelRoute', () => {
  it('defaultModelRoute maps Claude to anthropic, Gemini/Gemma to gemini, and everything else to codex', () => {
    expect(defaultModelRoute('claude-opus-4-7')).toBe('anthropic');
    expect(defaultModelRoute('claude-sonnet-4-6')).toBe('anthropic');
    expect(defaultModelRoute('anthropic/claude-haiku-4-5')).toBe('anthropic');
    expect(defaultModelRoute('gemini-4-hydrogen')).toBe('gemini');
    expect(defaultModelRoute('gemini-4-carbon')).toBe('gemini');
    expect(defaultModelRoute('google/gemini-3.5-flash-lite')).toBe('gemini');
    expect(defaultModelRoute('gemma-4-31b-it')).toBe('gemini');
    expect(defaultModelRoute('gpt-5.4')).toBe('codex');
    expect(defaultModelRoute('o3')).toBe('codex');
    expect(defaultModelRoute('codex-mini-latest')).toBe('codex');
  });

  it('routes heterogeneous models (Gemini + Codex + Anthropic) within one workflow run across shared journal and budget', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-routing-'));
    dirs.push(dir);
    const anthropicFake = new FakeRunner((req) => ({ result: `claude:${req.model}:${req.prompt}` }));
    const codexFake = new FakeRunner((req) => ({ result: `codex:${req.model}:${req.prompt}` }));
    const geminiFake = new FakeRunner((req) => ({ result: `gemini:${req.model}:${req.prompt}` }));
    const router = new RoutingRunner({ anthropic: anthropicFake, codex: codexFake, gemini: geminiFake });

    const handle = run({
      cwd: dir,
      runner: router,
      runId: 'route-1',
      script: `export const meta = { name: 'hybrid', description: 'mixed models' };
const context = await agent('ingest-repo', { model: 'gemini-4-hydrogen', label: 'ingest' });
const findings = await parallel([
  () => agent('scan-a:' + context, { model: 'gpt-5.4', label: 'finder-gpt' }),
  () => agent('scan-b:' + context, { model: 'o3', label: 'finder-o3' }),
]);
const verdict = await agent('judge ' + JSON.stringify(findings), { model: 'claude-opus-4-7', label: 'judge' });
return { context, findings, verdict };`,
    });

    const out = await handle.promise;
    expect(out).toEqual({
      context: 'gemini:gemini-4-hydrogen:ingest-repo',
      findings: [
        'codex:gpt-5.4:scan-a:gemini:gemini-4-hydrogen:ingest-repo',
        'codex:o3:scan-b:gemini:gemini-4-hydrogen:ingest-repo',
      ],
      verdict:
        'claude:claude-opus-4-7:judge ["codex:gpt-5.4:scan-a:gemini:gemini-4-hydrogen:ingest-repo","codex:o3:scan-b:gemini:gemini-4-hydrogen:ingest-repo"]',
    });
    expect(geminiFake.liveCalls).toBe(1);
    expect(codexFake.liveCalls).toBe(2);
    expect(anthropicFake.liveCalls).toBe(1);
  });

  it("returns the routed runner's result as it is, with the model that runner reported", async () => {
    const reporting: AgentRunner = {
      run: async (req) => ({
        result: 'ok',
        status: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 },
        turns: 1,
        model: `sent:${req.model}`,
      }),
    };
    const router = new RoutingRunner({ gemini: reporting, anthropic: new FakeRunner() });
    const request = (model: string): RunRequest => ({
      prompt: 'p',
      system: 's',
      tools: [],
      model,
      cwd: process.cwd(),
      signal: new AbortController().signal,
      isolated: false,
      onUsage: () => {},
      log: () => {},
    });
    expect((await router.run(request('gemini-4-hydrogen'))).model).toBe('sent:gemini-4-hydrogen');
    expect(await router.run(request('claude-opus-5-5'))).not.toHaveProperty('model');
  });

  it('forwards maxRequestTokens from gemini options too', () => {
    const router = new RoutingRunner({
      anthropic: { maxTokens: 8_000 },
      gemini: { maxTokens: 12_000 },
    });
    expect(router.maxRequestTokens).toBe(new GeminiRunner({ maxTokens: 12_000 }).maxRequestTokens);
  });

  it('supports a custom route function returning a third AgentRunner directly and forwards maxRequestTokens', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-routing-custom-'));
    dirs.push(dir);
    const localFake = new FakeRunner((req) => ({ result: `local:${req.prompt}` }));
    const router = new RoutingRunner({
      anthropic: { maxTokens: 10_000 },
      route: (model) => (model.startsWith('local/') ? localFake : defaultModelRoute(model)),
    });
    expect(router.maxRequestTokens).toBe(new AnthropicRunner({ maxTokens: 10_000 }).maxRequestTokens);

    const logs: string[] = [];
    const handle = run({
      cwd: dir,
      runner: router,
      budget: 50_000,
      concurrency: 2,
      script: `export const meta = { name: 'local-route', description: 'd' };
return await agent('ping', { model: 'local/qwen' });`,
    });
    handle.events.on('log', (e: { message: string }) => logs.push(e.message));
    expect(await handle.promise).toBe('local:ping');
    // Budget overrun ceiling = 50_000 + 2 * 20_000 = 90_000 (proving maxRequestTokens was forwarded).
    expect(logs.some((m) => m.includes('overrun ceiling 90000'))).toBe(true);
  });
});
