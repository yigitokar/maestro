import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultModelRoute, RoutingRunner } from '../src/routing-runner.js';
import { AnthropicRunner } from '../src/runner.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import { run } from '../src/workflow.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('RoutingRunner & defaultModelRoute', () => {
  it('defaultModelRoute maps Claude and Gemini to their native runners and other ids to codex', () => {
    expect(defaultModelRoute('claude-opus-4-7')).toBe('anthropic');
    expect(defaultModelRoute('claude-sonnet-4-6')).toBe('anthropic');
    expect(defaultModelRoute('anthropic/claude-haiku-4-5')).toBe('anthropic');
    expect(defaultModelRoute('gpt-5.4')).toBe('codex');
    expect(defaultModelRoute('gemini-2.5-flash')).toBe('gemini');
    expect(defaultModelRoute('google/gemini-2.5-pro')).toBe('gemini');
    expect(defaultModelRoute('models/gemini-2.5-pro')).toBe('gemini');
    expect(defaultModelRoute('o3')).toBe('codex');
    expect(defaultModelRoute('codex-mini-latest')).toBe('codex');
  });

  it('routes heterogeneous models within one workflow run across shared journal and budget', async () => {
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
const findings = await parallel([
  () => agent('scan-a', { model: 'gpt-5.4', label: 'finder-gpt' }),
  () => agent('scan-b', { model: 'gemini-2.5-flash', label: 'finder-gemini' }),
]);
const verdict = await agent('judge ' + JSON.stringify(findings), { model: 'claude-opus-4-7', label: 'judge' });
return { findings, verdict };`,
    });

    const out = await handle.promise;
    expect(out).toEqual({
      findings: ['codex:gpt-5.4:scan-a', 'gemini:gemini-2.5-flash:scan-b'],
      verdict: 'claude:claude-opus-4-7:judge ["codex:gpt-5.4:scan-a","gemini:gemini-2.5-flash:scan-b"]',
    });
    expect(codexFake.liveCalls).toBe(1);
    expect(geminiFake.liveCalls).toBe(1);
    expect(anthropicFake.liveCalls).toBe(1);
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
