import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexRunner } from '../src/codex-runner.js';
import { DEFAULT_MODEL, type RunRequest, type Usage } from '../src/types.js';

const bin = path.join(import.meta.dirname, 'fixtures', 'fake-codex-app-server.mjs');
let cwd: string;
let recordPath: string;
const controllers: AbortController[] = [];
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-app-server-test-')));
  recordPath = path.join(cwd, 'calls.jsonl');
  vi.stubEnv('FAKE_APP_SERVER_RECORD', recordPath);
  vi.stubEnv('FAKE_APP_SERVER_SCENARIO', '{}');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  try {
    const start = records().find((row) => row.type === 'startup');
    for (const pid of [-start?.pid, start?.grandchildPid]) {
      if (!Number.isInteger(pid)) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  } catch {}
  vi.unstubAllEnvs();
  await rm(cwd, { recursive: true, force: true });
});
function scenario(value: Record<string, unknown>) {
  vi.stubEnv('FAKE_APP_SERVER_SCENARIO', JSON.stringify(value));
}
function records(): any[] {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
function calls(method: string): any[] {
  return records()
    .filter((row) => row.request?.method === method)
    .map((row) => row.request);
}
function runner() {
  return new CodexRunner({ bin, killGraceMs: 15 });
}
function request(overrides: Partial<RunRequest> = {}) {
  const controller = new AbortController();
  controllers.push(controller);
  const progress: Parameters<NonNullable<RunRequest['onProgress']>>[0][] = [];
  const usages: Usage[] = [];
  let acceptHandler!: (handler: (text: string) => Promise<void>) => void;
  const ready = new Promise<(text: string) => Promise<void>>((resolve) => {
    acceptHandler = resolve;
  });
  const unregister = vi.fn();
  const req: RunRequest = {
    prompt: 'review the code',
    system: 'Return only the result',
    tools: [],
    model: DEFAULT_MODEL,
    cwd,
    isolated: false,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    onUsage: (usage) => usages.push(usage),
    log: () => {},
    onProgress: (update) => progress.push(update),
    registerMessageHandler: (handler) => {
      acceptHandler(handler);
      return unregister;
    },
    ...overrides,
  };
  return { req, ready, unregister, controller, progress, usages };
}
const event = (method: string, params: Record<string, unknown>) => ({ method, params });
const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0) =>
  event('thread/tokenUsage/updated', {
    tokenUsage: {
      total: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens: 2,
        reasoningOutputTokens: 99,
      },
      last: {},
    },
  });

describe('Codex app-server live transport', () => {
  it('initializes a fresh sandboxed thread, maps model/effort/schema, and shuts the server down', async () => {
    const { req, unregister } = request({
      model: 'gpt-test',
      effort: 'max',
      schema: { type: 'object', properties: { value: { type: 'string' } } },
    });
    scenario({ finalText: '{"value":"ok"}' });
    const result = await runner().run(req);
    expect(result).toMatchObject({ status: 'ok', result: { value: 'ok' }, turns: 1 });
    expect(records()[0].argv).toEqual(['app-server']);
    expect(calls('initialize')).toHaveLength(1);
    expect(calls('initialized')).toHaveLength(1);
    expect(calls('thread/start')[0].params).toMatchObject({
      cwd,
      model: 'gpt-test',
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    expect(calls('turn/start')[0].params).toMatchObject({
      effort: 'xhigh',
      outputSchema: { required: ['value'], additionalProperties: false },
    });
    expect(calls('turn/start')[0].params.input[0].text).toContain(req.prompt);
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('queues early messages and acknowledges them in order on the same active turn', async () => {
    scenario({ holdUntilSteers: 2 });
    const { req, ready, unregister } = request();
    const result = runner().run(req);
    const send = await ready;
    await Promise.all([send('check edge cases'), send('include regression tests')]);
    expect(await result).toMatchObject({ status: 'ok' });
    expect(calls('thread/start')[0].params).not.toHaveProperty('model');
    expect(calls('turn/steer').map((call) => call.params)).toEqual([
      { threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'check edge cases' }] },
      {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'include regression tests' }],
      },
    ]);
    expect(calls('turn/start')).toHaveLength(1);
    expect(unregister).toHaveBeenCalledOnce();
    await expect(send('too late')).rejects.toThrow('no longer running');
  });

  it('rejects steering errors without pretending the message was delivered', async () => {
    scenario({ rejectSteer: true, holdUntilSteers: 1 });
    const { req, ready } = request();
    const result = runner().run(req);
    await expect((await ready)('new instruction')).rejects.toThrow('active turn mismatch');
    expect(await result).toMatchObject({ status: 'ok' });
    expect(calls('turn/start')).toHaveLength(1);
  });

  it('rejects pending delivery when completion races with its acknowledgement', async () => {
    scenario({ finishBeforeAck: true, holdUntilSteers: 1 });
    const { req, ready } = request();
    const result = runner().run(req);
    await expect((await ready)('late instruction')).rejects.toThrow('ended before message delivery');
    expect(await result).toMatchObject({ status: 'ok' });
    expect(calls('turn/start')).toHaveLength(1);
  });

  it('keeps delivery successful when acknowledgement and completion share one stdout chunk', async () => {
    scenario({ ackAndFinishTogether: true, holdUntilSteers: 1 });
    const { req, ready } = request();
    const result = runner().run(req);
    await expect((await ready)('new instruction')).resolves.toBeUndefined();
    expect(await result).toMatchObject({ status: 'ok', result: 'done' });
  });

  it.each(['commentary', 'partial_answer'])('does not promote %s to a final answer', async (phase) => {
    scenario({ phase, finalText: 'Still working' });
    expect(await runner().run(request().req)).toMatchObject({
      status: 'null',
      error: expect.stringContaining('no final text'),
    });
  });

  it('reports cumulative usage once, public activity and shell traces without reasoning contents', async () => {
    scenario({
      events: [
        usage(100, 10, 20),
        usage(100, 10, 20),
        usage(150, 15, 30),
        event('item/started', {
          item: {
            type: 'reasoning',
            id: 'r',
            content: ['PRIVATE REASONING'],
            summary: ['PRIVATE REASONING'],
          },
        }),
        event('item/agentMessage/delta', { itemId: 'm', delta: 'Checking tests' }),
        event('item/started', {
          item: { type: 'commandExecution', id: 'c', command: 'npm test', status: 'inProgress' },
        }),
        event('item/completed', {
          item: { type: 'commandExecution', id: 'c', command: 'npm test', exitCode: 0, status: 'completed' },
        }),
      ],
    });
    const { req, usages, progress } = request();
    const result = await runner().run(req);
    expect(result).toMatchObject({
      status: 'ok',
      usage: {
        input_tokens: 120,
        output_tokens: 15,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 2,
      },
    });
    expect(usages).toHaveLength(2);
    expect(progress).toContainEqual(expect.objectContaining({ activity: 'model', turns: 1 }));
    expect(progress).toContainEqual(
      expect.objectContaining({ activity: 'tool', tool: 'shell', summary: 'npm test' }),
    );
    expect(progress).toContainEqual(
      expect.objectContaining({ activity: 'message', summary: 'Checking tests' }),
    );
    expect(JSON.stringify(progress)).not.toContain('PRIVATE REASONING');
    expect(result.trace?.toolCalls).toEqual([{ tool: 'shell', inputSummary: 'npm test', ok: true }]);
  });

  it('allows retryable errors but rejects a failed or interrupted turn', async () => {
    scenario({ events: [event('error', { willRetry: true, error: { message: 'temporary' } })] });
    expect(await runner().run(request().req)).toMatchObject({ status: 'ok' });
    scenario({ status: 'failed', error: 'permanent' });
    expect(await runner().run(request().req)).toMatchObject({ status: 'null', error: 'permanent' });
    scenario({ status: 'interrupted' });
    expect(await runner().run(request().req)).toMatchObject({
      status: 'null',
      error: 'Codex turn interrupted',
    });
  });

  it('refuses success on protocol failure, process failure, missing text or invalid schema', async () => {
    scenario({ failMethod: 'thread/start' });
    expect(await runner().run(request().req)).toMatchObject({
      status: 'null',
      error: 'fixture method rejected',
    });
    scenario({ abruptExit: 2 });
    expect(await runner().run(request().req)).toMatchObject({ status: 'null' });
    scenario({ finalText: null });
    expect(await runner().run(request().req)).toMatchObject({
      status: 'null',
      error: expect.stringContaining('no final text'),
    });
    scenario({ finalText: 'not json' });
    expect(await runner().run(request({ schema: { type: 'object' } }).req)).toMatchObject({
      status: 'null',
      error: expect.stringContaining('schema parse failed'),
    });
  });

  it('never accepts approval or permission requests', async () => {
    scenario({
      approvals: [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'mcpServer/elicitation/request',
        'item/tool/requestUserInput',
        'unexpected/request',
      ],
    });
    expect(await runner().run(request().req)).toMatchObject({ status: 'ok' });
    const responses = records()
      .filter((row) => row.request?.id >= 1000)
      .map((row) => row.request)
      .sort((a, b) => a.id - b.id);
    expect(responses.map((row) => row.result ?? row.error)).toEqual([
      { decision: 'decline' },
      { decision: 'decline' },
      { permissions: {}, scope: 'turn' },
      { action: 'decline' },
      { answers: {} },
      { code: -32601, message: 'Unsupported interactive request' },
    ]);
  });

  it('aborts an in-flight steer and cleans up the handler and process group', async () => {
    scenario({ hold: true, ignoreSteer: true, ignoreTerm: true, grandchild: 'group' });
    const { req, ready, controller, unregister } = request();
    const result = runner().run(req);
    const delivery = (await ready)('pending');
    const rejected = expect(delivery).rejects.toThrow('aborted before message delivery');
    controller.abort();
    await rejected;
    expect(await result).toMatchObject({ status: 'skipped' });
    expect(unregister).toHaveBeenCalledOnce();
    const start = records()[0];
    expect(() => process.kill(start.pid, 0)).toThrow();
  });

  it('finishes as soon as the server has gone, without waiting for the default kill grace period', async () => {
    const started = Date.now();
    const result = await new CodexRunner({ bin, killGraceMs: 5_000 }).run(request().req);
    expect(result).toMatchObject({ status: 'ok', result: 'done' });
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('a steer that is never acknowledged fails that message only; the agent finishes', async () => {
    scenario({ hold: true, ignoreSteer: true, finishAfterIgnoredSteerMs: 150 });
    const { req, ready } = request();
    const result = new CodexRunner({ bin, killGraceMs: 15, steerTimeoutMs: 30 }).run(req);
    await expect((await ready)('lost')).rejects.toThrow('turn/steer timed out');
    expect(await result).toMatchObject({ status: 'ok', result: 'done' });
  });

  it('a CLI without app-server runs the agent with codex exec, and later agents skip the probe', async () => {
    const old = path.join(import.meta.dirname, 'fixtures', 'fake-codex-old.mjs');
    const seen = path.join(cwd, 'old.txt');
    vi.stubEnv('FAKE_CODEX_OLD_RECORD', seen);
    vi.stubEnv('FAKE_CODEX_RECORD', path.join(cwd, 'exec.jsonl'));
    vi.stubEnv(
      'FAKE_CODEX_SCENARIO',
      JSON.stringify({ steps: [{ event: { type: 'turn.completed' } }], finalText: 'from exec' }),
    );
    const logs: string[] = [];
    const codex = new CodexRunner({ bin: old, killGraceMs: 15 });
    const first = request({ log: (m) => logs.push(m) });
    expect(await codex.run(first.req)).toMatchObject({ status: 'ok', result: 'from exec' });
    expect(logs.join(' ')).toContain('codex app-server did not start');
    expect(logs.join(' ')).toContain('codex exec from now on');
    expect(first.progress.some((p) => p.summary.includes('Live messages unavailable'))).toBe(true);
    const second = request({ log: (m) => logs.push(m) });
    expect(await codex.run(second.req)).toMatchObject({ status: 'ok', result: 'from exec' });
    expect(second.progress.some((p) => p.summary.includes('no usable app-server'))).toBe(true);
    expect(readFileSync(seen, 'utf8').trim().split('\n')).toEqual(['app-server', 'exec', 'exec']);
  });

  it('usage-budget abort stops before a successful result', async () => {
    scenario({ events: [usage(10, 10)] });
    const r = request();
    r.req.onUsage = () => r.controller.abort();
    expect(await runner().run(r.req)).toMatchObject({ status: 'skipped', usage: { output_tokens: 10 } });
  });

  it('continues to serve custom tools through the file-queue MCP bridge', async () => {
    scenario({ mcpCalls: [{ name: 'custom_echo', arguments: { text: 'hello' } }] });
    const tool = {
      name: 'custom_echo',
      description: 'Echo',
      write: false,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: vi.fn(async (input: any) => `echo:${input.text}`),
    };
    const result = await runner().run(request({ tools: [tool] }).req);
    expect(result.status).toBe('ok');
    expect(tool.run).toHaveBeenCalledOnce();
    expect(records().find((row) => row.type === 'mcp').result.content[0].text).toBe('echo:hello');
    expect(result.trace?.toolCalls).toContainEqual(
      expect.objectContaining({ tool: 'custom_echo', ok: true }),
    );
  });

  it('keeps workspace isolation and commits successful writer changes in the parent runner', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(path.join(cwd, '.gitignore'), 'calls.jsonl\n');
    git('add', '.gitignore');
    git('commit', '-qm', 'initial');
    scenario({ files: { 'changed.txt': 'new content' } });
    const result = await runner().run(request({ isolated: true }).req);
    expect(result.status).toBe('ok');
    expect(await readFile(path.join(cwd, 'changed.txt'), 'utf8')).toBe('new content');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%s')).toBe('maestro(codex): review the code');
    expect(calls('thread/start')[0].params.sandbox).toBe('workspace-write');
  });
});
