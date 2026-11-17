import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentControl, MAX_AGENT_MESSAGE_CHARS, MAX_AGENT_MESSAGES } from '../src/agent-control.js';
import { main } from '../src/cli.js';
import { readEntries } from '../src/journal.js';
import { ProgressTree } from '../src/progress.js';
import { FakeRunner } from '../src/testing/fake-runner.js';
import type { AgentRunner, RunRequest, WorkflowEvent } from '../src/types.js';
import { type RunHandle, run } from '../src/workflow.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const handles: RunHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  const pending = handles.splice(0);
  for (const handle of pending) handle.stop();
  await Promise.all(pending.map((handle) => handle.promise.catch(() => {})));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function temp() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'maestro-live-'));
  dirs.push(cwd);
  return cwd;
}

const SCRIPT = `export const meta = { name: 'live', description: 'd' };
return await agent('task', { label: 'worker' });`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('live workflow controls', () => {
  it('distinguishes queued/running, snapshots usage, queues delivery, journals and resumes steering', async () => {
    const cwd = await temp();
    const ready = deferred<RunRequest>();
    const finish = deferred();
    const delivered = deferred();
    const received = deferred<string>();
    const runner: AgentRunner = {
      async run(req) {
        req.signal.addEventListener('abort', () => finish.resolve(), { once: true });
        req.registerMessageHandler?.(async (text) => {
          received.resolve(text);
          await delivered.promise;
        });
        ready.resolve(req);
        await finish.promise;
        return {
          result: 'guided result',
          status: 'ok',
          usage: { input_tokens: 12, output_tokens: 4 },
          turns: 2,
        };
      },
    };
    const handle = run({ cwd, runner, script: SCRIPT });
    handles.push(handle);
    const events: WorkflowEvent[] = [];
    handle.events.on('event', (event) => events.push(event));
    const req = await ready.promise;
    req.onProgress?.({ activity: 'tool', tool: 'read_file', summary: 'Reading a file', turns: 2 });
    req.onUsage({ input_tokens: 12, output_tokens: 4 });
    const state = handle.liveAgents()[0]!;
    expect(state).toMatchObject({
      id: 0,
      state: 'running',
      canMessage: true,
      turns: 2,
      usage: { output_tokens: 4 },
    });
    state.usage.output_tokens = 999;
    state.progress!.summary = 'mutated';
    expect(handle.liveAgents()[0]!.usage.output_tokens).toBe(4);
    expect(handle.liveAgents()[0]!.progress!.summary).toBe('Reading a file');
    const receipt = handle.sendMessage(0, 'Also check cancellation');
    expect(receipt).toMatchObject({ id: 0, status: 'queued' });
    expect(await received.promise).toBe('Also check cancellation');
    expect(handle.liveAgents()[0]!.messages[0]!.status).toBe('queued');
    delivered.resolve();
    await tick();
    expect(handle.liveAgents()[0]!.messages[0]).toMatchObject({
      status: 'delivered',
      deliveredAt: expect.any(Number),
    });
    expect(
      events.some((event) => event.type === 'agent_message' && event.message.status === 'delivered'),
    ).toBe(true);
    const tree = new ProgressTree();
    for (const event of events) tree.push(event);
    expect(tree.render()).toContain('Reading a file');
    expect(tree.render()).toContain('2 turns');
    finish.resolve();
    expect(await handle.promise).toBe('guided result');
    expect(handle.liveAgents()).toEqual([]);
    expect(handle.sendMessage(0, 'Too late')).toBeNull();
    const rows = await readEntries(handle.runDir);
    expect(rows[0]!.messages).toEqual([
      expect.objectContaining({ text: 'Also check cancellation', status: 'delivered' }),
    ]);
    const resumedRunner = new FakeRunner();
    const resumed = run({ cwd, runner: resumedRunner, resumeFromRunId: handle.runId });
    handles.push(resumed);
    const resumedLogs: string[] = [];
    resumed.events.on('log', (event) => resumedLogs.push(event.message));
    expect(await resumed.promise).toBe('guided result');
    expect(resumedRunner.liveCalls).toBe(0);
    expect(resumedLogs.join('\n')).toContain('reusing cached result with live steering');
    const shown: string[] = [];
    expect(
      await main(['show', handle.runId, 'worker'], { cwd, stdout: { write: (text) => shown.push(text) } }),
    ).toBe(0);
    expect(shown.join('')).toContain('[delivered] Also check cancellation');
    expect(await readFile(path.join(handle.runDir, 'events.jsonl'), 'utf8')).toContain('agent_status');
  });

  it('shows waiting agents and rejects steering for runners without a handler', async () => {
    const ready = deferred();
    const finish = deferred();
    let calls = 0;
    const handle = run({
      cwd: await temp(),
      concurrency: 1,
      script: `export const meta = { name: 'queue', description: 'd' };
return await parallel([() => agent('first'), () => agent('second')]);`,
      runner: {
        async run(req) {
          req.signal.addEventListener('abort', () => finish.resolve(), { once: true });
          if (calls++ === 0) {
            ready.resolve();
            await finish.promise;
          }
          return { result: 'ok', status: 'ok', usage: { input_tokens: 0, output_tokens: 0 }, turns: 1 };
        },
      },
    });
    handles.push(handle);
    await ready.promise;
    expect(handle.liveAgents().map((agent) => agent.state)).toEqual(['running', 'queued']);
    expect(handle.liveAgents().every((agent) => !agent.canMessage)).toBe(true);
    expect(handle.sendMessage(0, 'unsupported')).toBeNull();
    expect(handle.sendMessage(1, 'not running yet')).toBeNull();
    expect(() => handle.sendMessage(-1, 'bad id')).toThrow('non-negative integer');
    finish.resolve();
    await handle.promise;
  });

  it('stopping an agent fails undelivered messages and removes all live controls', async () => {
    const ready = deferred();
    const handle = run({
      cwd: await temp(),
      script: SCRIPT,
      runner: {
        async run(req) {
          req.registerMessageHandler?.(() => new Promise(() => {}));
          ready.resolve();
          await new Promise<void>((resolve) =>
            req.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { result: null, status: 'skipped', usage: { input_tokens: 0, output_tokens: 0 }, turns: 0 };
        },
      },
    });
    handles.push(handle);
    await ready.promise;
    expect(handle.sendMessage(0, 'pending')).toMatchObject({ status: 'queued' });
    expect(handle.skip(0)).toBe(true);
    expect(await handle.promise).toBeNull();
    expect((await readEntries(handle.runDir))[0]!.messages![0]!.status).toBe('failed');
    expect(handle.liveAgents()).toEqual([]);
  });

  it('CLI show displays the last recorded live snapshot and clears it after run completion', async () => {
    const cwd = await temp();
    const runDir = path.join(cwd, '.maestro', 'runs', 'recorded');
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, 'journal.jsonl'), '');
    const control = new AgentControl(
      { id: 7, label: 'reader' },
      new AbortController().signal,
      () => {},
      () => {},
    );
    control.running();
    control.progress({ activity: 'tool', tool: 'read_file', summary: 'Reading source', turns: 3 });
    const line = JSON.stringify({ t: Date.now(), type: 'agent_status', agent: control.snapshot() });
    await writeFile(path.join(runDir, 'events.jsonl'), `${line}\n`);
    let output = '';
    const io = {
      cwd,
      stdout: {
        write: (text: string) => {
          output += text;
        },
      },
    };
    expect(await main(['show', 'recorded', 'reader'], io)).toBe(0);
    expect(output).toContain('latest recorded activity');
    expect(output).toContain('#7 reader [running]');
    expect(output).toContain('Reading source');
    await writeFile(
      path.join(runDir, 'events.jsonl'),
      `${line}\n${JSON.stringify({ t: Date.now(), type: 'run_end', ok: true })}\n`,
    );
    output = '';
    expect(await main(['show', 'recorded'], io)).toBe(0);
    expect(output).not.toContain('reader');
    control.close();
  });

  it('does not publish live status after a worktree setup failure while siblings keep running', async () => {
    const finish = deferred();
    const failed = deferred();
    const handle = run({
      cwd: await temp(),
      script: `export const meta = { name: 'setup-failure', description: 'd' };
return await parallel([
  () => agent('isolated', { isolation: 'worktree' }),
  () => agent('sibling'),
]);`,
      runner: {
        async run(req) {
          req.signal.addEventListener('abort', () => finish.resolve(), { once: true });
          await finish.promise;
          return { result: 'sibling', status: 'ok', turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
        },
      },
    });
    handles.push(handle);
    const ownEvents: string[] = [];
    handle.events.on('event', (event: WorkflowEvent) => {
      if (event.type === 'agent_status' && event.agent.id === 0) ownEvents.push(event.type);
      if (event.type === 'agent_end' && event.id === 0) {
        ownEvents.push(event.type);
        failed.resolve();
      }
    });
    await failed.promise;
    await tick();
    expect(ownEvents.at(-1)).toBe('agent_end');
    expect(handle.liveAgents().some((agent) => agent.id === 0)).toBe(false);
    finish.resolve();
    expect(await handle.promise).toEqual([null, 'sibling']);
  });
});

describe('bounded agent control', () => {
  it('limits payloads/count and never turns completion races into false delivery', async () => {
    const controller = new AbortController();
    const control = new AgentControl(
      { id: 0 },
      controller.signal,
      () => {},
      () => {},
    );
    const remove = control.register(async () => {});
    expect(() => control.send('  ')).toThrow('non-empty');
    expect(() => control.send('x'.repeat(MAX_AGENT_MESSAGE_CHARS + 1))).toThrow('16000');
    for (let i = 0; i < MAX_AGENT_MESSAGES; i++) control.send(String(i));
    expect(() => control.send('overflow')).toThrow('32');
    remove();
    await control.finish();
    expect(control.snapshot().messages.every((message) => message.status === 'failed')).toBe(true);
    expect(control.send('late')).toBeNull();
  });

  it.each(['completion', 'abort'])(
    'honors acknowledgements resolved before %s in the same I/O batch',
    async (ending) => {
      const controller = new AbortController();
      const ack = deferred();
      const control = new AgentControl(
        { id: 0 },
        controller.signal,
        () => {},
        () => {},
      );
      const remove = control.register(() => ack.promise);
      control.send('steer');
      await tick();
      ack.resolve();
      if (ending === 'abort') controller.abort();
      remove();
      await control.finish();
      expect(control.snapshot().messages[0]!.status).toBe('delivered');
    },
  );
});
