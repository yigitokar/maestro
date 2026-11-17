// `maestro mcp`: the Workflow tool over the stdio transport, driven by a real MCP client in-process:
// Workflow + WorkflowResult (polled, or held open with wait: true and its progress), the WorkflowStop /
// WorkflowSkip controls, one budget pool per server.

import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readEntries } from '../src/journal.js';
import {
  serveMcp,
  WORKFLOW_GUIDE_TOOL_NAME,
  WORKFLOW_MESSAGE_TOOL_NAME,
  WORKFLOW_RESULT_TOOL_NAME,
  WORKFLOW_SKIP_TOOL_NAME,
  WORKFLOW_STOP_TOOL_NAME,
} from '../src/mcp.js';
import { type FakeHandler, FakeRunner } from '../src/testing/fake-runner.js';
import { liveWorkflowAgents } from '../src/tool.js';
import type { AgentRunner, RunRequest } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connect(
  opts: {
    handler?: FakeHandler;
    runner?: AgentRunner;
    budget?: number;
    progressIntervalMs?: number;
    concurrency?: number;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-mcp-'));
  // Two pipes: client → server (server stdin) and server → client (server stdout). The client side
  // reuses the line-delimited JSON-RPC stdio transport on the opposite ends.
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = await serveMcp(
    {
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      runner: opts.runner ?? new FakeRunner(opts.handler ?? (() => ({ delayMs: 20 }))),
      concurrency: opts.concurrency ?? 2,
      ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
      ...(opts.progressIntervalMs !== undefined ? { progressIntervalMs: opts.progressIntervalMs } : {}),
    },
    new StdioServerTransport(toServer, toClient),
  );
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioServerTransport(toClient, toServer));
  cleanups.push(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { client, server, dir };
}

const textOf = (res: any): string => res.content[0].text;

async function startWorkflow(client: Client, script: string): Promise<string> {
  const res = await client.callTool({ name: 'Workflow', arguments: { script } });
  expect(res.isError, textOf(res)).toBeFalsy();
  return JSON.parse(textOf(res)).runId;
}

async function resultOf(client: Client, runId: string): Promise<any> {
  return JSON.parse(textOf(await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId } })));
}

/** Polls WorkflowResult until the run settles (or `until` holds on a running result). */
async function poll(
  client: Client,
  runId: string,
  until: (r: any) => boolean = (r) => r.status !== 'running',
) {
  let last = await resultOf(client, runId);
  for (let i = 0; i < 200 && !until(last); i++) {
    await new Promise((r) => setTimeout(r, 10));
    last = await resultOf(client, runId);
  }
  expect(until(last), JSON.stringify(last)).toBe(true);
  return last;
}

/** Explicit model/message gates keep delivery assertions independent of timing and real APIs. */
function controlledRunner() {
  const messages: Array<{ text: string; accept(): void; reject(error: Error): void }> = [];
  const finishes = new Set<() => void>();
  const requests: RunRequest[] = [];
  const runner: AgentRunner = {
    async run(req) {
      requests.push(req);
      const ownMessages: typeof messages = [];
      const unregister = req.registerMessageHandler?.(
        (text) =>
          new Promise<void>((accept, reject) => {
            const message = { text, accept, reject };
            messages.push(message);
            ownMessages.push(message);
          }),
      );
      const usage = { input_tokens: 12, output_tokens: 7 };
      req.onUsage(usage);
      req.onProgress?.({ activity: 'tool', tool: 'read_file', summary: 'Reading source', turns: 1 });
      let finish: () => void = () => {};
      try {
        await new Promise<void>((resolve) => {
          finish = resolve;
          finishes.add(finish);
          req.signal.addEventListener('abort', finish, { once: true });
          if (req.signal.aborted) finish();
        });
      } finally {
        finishes.delete(finish);
        req.signal.removeEventListener('abort', finish);
        unregister?.();
        for (const message of ownMessages) message.reject(new Error('agent finished before delivery'));
      }
      return {
        status: req.signal.aborted ? 'skipped' : 'ok',
        result: req.signal.aborted ? null : 'done',
        usage,
        turns: 1,
      };
    },
  };
  return {
    runner,
    messages,
    requests,
    finish: () => {
      for (const finish of [...finishes]) finish();
    },
  };
}

const liveScript = `export const meta = { name: 'live', description: 'd' };
return await agent('review', { label: 'reader' });`;

describe('live agent MCP controls', () => {
  it('reports activity and usage, then distinguishes queued and delivered messages', async () => {
    const control = controlledRunner();
    const { client } = await connect({ runner: control.runner });
    const runId = await startWorkflow(client, liveScript);
    const running = await poll(client, runId, (r) => r.liveAgents?.[0]?.canMessage === true);
    const agent = running.liveAgents[0];
    expect(agent).toMatchObject({
      id: 0,
      label: 'reader',
      state: 'running',
      startedAt: expect.any(Number),
      runningAt: expect.any(Number),
      updatedAt: expect.any(Number),
      elapsedMs: expect.any(Number),
      turns: 1,
      usage: { input_tokens: 12, output_tokens: 7 },
      progress: { activity: 'tool', tool: 'read_file', summary: 'Reading source' },
      canMessage: true,
      messages: [],
    });
    const response = await client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: agent.id, message: 'Focus on cancellation.' },
    });
    expect(response.isError, textOf(response)).toBeFalsy();
    const receipt = JSON.parse(textOf(response)).message;
    expect(receipt).toMatchObject({ id: expect.any(Number), status: 'queued', queuedAt: expect.any(Number) });
    expect((await resultOf(client, runId)).liveAgents[0].messages).toEqual([receipt]);
    expect(control.messages.map((message) => message.text)).toEqual(['Focus on cancellation.']);

    control.messages[0]!.accept();
    const delivered = await poll(
      client,
      runId,
      (r) => r.liveAgents?.[0]?.messages[0]?.status === 'delivered',
    );
    expect(delivered.liveAgents[0].messages[0]).toMatchObject({
      ...receipt,
      status: 'delivered',
      deliveredAt: expect.any(Number),
    });
    control.finish();
    expect(await poll(client, runId)).toMatchObject({ status: 'done', result: 'done' });
    const late = await client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: agent.id, message: 'Too late.' },
    });
    expect(late.isError).toBe(true);
    expect(textOf(late)).toContain('not running');
  });

  it('reports rejected delivery and journals pending messages as failed when stopped', async () => {
    const control = controlledRunner();
    const { client, dir } = await connect({ runner: control.runner });
    const runId = await startWorkflow(client, liveScript);
    await poll(client, runId, (r) => r.liveAgents?.[0]?.canMessage === true);
    const send = (message: string) =>
      client.callTool({ name: WORKFLOW_MESSAGE_TOOL_NAME, arguments: { runId, agentId: 0, message } });
    expect((await send('First instruction.')).isError).toBeFalsy();
    control.messages[0]!.reject(new Error('turn no longer accepts input'));
    const failed = await poll(client, runId, (r) => r.liveAgents?.[0]?.messages[0]?.status === 'failed');
    expect(failed.liveAgents[0].messages[0].error).toContain('did not accept');
    expect((await send('Still queued.')).isError).toBeFalsy();
    const stopped = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    expect(stopped.isError).toBeFalsy();
    expect(await poll(client, runId)).toMatchObject({ status: 'failed' });
    const rows = await readEntries(path.join(dir, 'state', 'runs', runId));
    expect(rows[0]!.messages).toMatchObject([
      { status: 'failed', text: 'First instruction.' },
      { status: 'failed', text: 'Still queued.' },
    ]);
  });

  it('leaves unsupported and queued agents visible without claiming messaging support', async () => {
    const control = controlledRunner();
    const { client } = await connect({ runner: control.runner, concurrency: 1 });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'queue', description: 'd' };
return await parallel([() => agent('first'), () => agent('second')]);`,
    );
    const status = await poll(client, runId, (r) => r.liveAgents?.length === 2 && r.liveAgents[0].canMessage);
    expect(status.liveAgents[1]).toMatchObject({ state: 'queued', canMessage: false, turns: 0 });
    const queued = await client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: status.liveAgents[1].id, message: 'Not started yet.' },
    });
    expect(queued.isError).toBe(true);
    expect(textOf(queued)).toContain('canMessage');
    await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    await poll(client, runId);

    const unsupported = await connect({ handler: () => ({ delayMs: 5_000 }) });
    const unsupportedId = await startWorkflow(unsupported.client, liveScript);
    const unsupportedStatus = await poll(
      unsupported.client,
      unsupportedId,
      (r) => r.liveAgents?.[0]?.state === 'running',
    );
    expect(unsupportedStatus.liveAgents[0].canMessage).toBe(false);
    expect(
      (
        await unsupported.client.callTool({
          name: WORKFLOW_MESSAGE_TOOL_NAME,
          arguments: { runId: unsupportedId, agentId: 0, message: 'Unsupported.' },
        })
      ).isError,
    ).toBe(true);
    await unsupported.client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId: unsupportedId } });
    await poll(unsupported.client, unsupportedId);
  });

  it('rejects invalid and oversized inputs, queue overflow, and another server’s live run', async () => {
    const control = controlledRunner();
    const { client } = await connect({ runner: control.runner });
    const other = await connect();
    const runId = await startWorkflow(client, liveScript);
    await poll(client, runId, (r) => r.liveAgents?.[0]?.canMessage === true);
    for (const invalid of [
      { agentId: -1, message: 'x' },
      { agentId: 0.5, message: 'x' },
      { agentId: '0', message: 'x' },
      { agentId: 0, message: '' },
      { agentId: 0, message: ' \n ' },
      { agentId: 0, message: 42 },
      { agentId: 0, message: 'x'.repeat(16_001) },
      { agentId: 999, message: 'x' },
    ]) {
      expect(
        (await client.callTool({ name: WORKFLOW_MESSAGE_TOOL_NAME, arguments: { runId, ...invalid } }))
          .isError,
      ).toBe(true);
    }
    const foreign = await other.client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: 0, message: 'Wrong server.' },
    });
    expect(foreign.isError).toBe(true);
    expect(control.messages).toHaveLength(0);
    for (let i = 0; i < 32; i++) {
      const result = await client.callTool({
        name: WORKFLOW_MESSAGE_TOOL_NAME,
        arguments: { runId, agentId: 0, message: `Instruction ${i}` },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
    }
    const overflow = await client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: 0, message: 'One too many.' },
    });
    expect(overflow.isError).toBe(true);
    expect(textOf(overflow)).toContain('32');
    await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    await poll(client, runId);
  });

  it('waiting calls report bounded activity, token usage and message delivery', async () => {
    const control = controlledRunner();
    const { client } = await connect({ runner: control.runner, progressIntervalMs: 10 });
    const runId = await startWorkflow(client, liveScript);
    await poll(client, runId, (r) => r.liveAgents?.[0]?.canMessage === true);
    await client.callTool({
      name: WORKFLOW_MESSAGE_TOOL_NAME,
      arguments: { runId, agentId: 0, message: 'Review this.' },
    });
    control.messages[0]!.accept();
    const messages: string[] = [];
    const result = await client.callTool(
      { name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } },
      undefined,
      {
        onprogress: (progress) => {
          messages.push(progress.message ?? '');
          control.finish();
        },
      },
    );
    expect(JSON.parse(textOf(result))).toMatchObject({ status: 'done' });
    expect(messages[0]).toContain('reader [running;');
    expect(messages[0]).toContain('12 in/7 out');
    expect(messages[0]).toContain('Reading source');
    expect(messages[0]).toContain('1 delivered');
    expect(messages.every((message) => message.length <= 2048)).toBe(true);
  });
});

describe('maestro mcp', () => {
  it('tools/list returns Workflow, WorkflowResult and the WorkflowStop / WorkflowSkip controls', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'Workflow',
        WORKFLOW_GUIDE_TOOL_NAME,
        WORKFLOW_RESULT_TOOL_NAME,
        WORKFLOW_STOP_TOOL_NAME,
        WORKFLOW_SKIP_TOOL_NAME,
        WORKFLOW_MESSAGE_TOOL_NAME,
      ].sort(),
    );
    for (const t of tools) expect((t.inputSchema as any).additionalProperties, t.name).toBe(false);
    const skip = tools.find((t) => t.name === WORKFLOW_SKIP_TOOL_NAME)!;
    expect((skip.inputSchema as any).required).toEqual(['runId', 'agentId']);
    const result = tools.find((t) => t.name === WORKFLOW_RESULT_TOOL_NAME)!;
    expect((result.inputSchema as any).required).toEqual(['runId']);
    expect((result.inputSchema as any).properties.wait.type).toBe('boolean');
    const message = tools.find((t) => t.name === WORKFLOW_MESSAGE_TOOL_NAME)!;
    expect((message.inputSchema as any).required).toEqual(['runId', 'agentId', 'message']);
  });

  it('WorkflowGuide returns the script-writing guide, and the server points to it', async () => {
    const { client } = await connect();
    const res = (await client.callTool({ name: WORKFLOW_GUIDE_TOOL_NAME, arguments: {} })) as any;
    expect(res.isError).toBeFalsy();
    const guide: string = res.content[0].text;
    expect(guide.startsWith('# Writing a Maestro workflow script')).toBe(true);
    expect(guide).toContain('export const meta');
    expect(client.getInstructions()).toContain(WORKFLOW_GUIDE_TOOL_NAME);
    const workflow = (await client.listTools()).tools.find((t) => t.name === 'Workflow')!;
    expect(workflow.description).toContain(WORKFLOW_GUIDE_TOOL_NAME);
  });

  it('WorkflowResult with wait: true answers only once the run settles', async () => {
    const { client } = await connect({ handler: () => ({ delayMs: 200 }) });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('slow ' + 1);`,
    );
    const res = await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } });
    expect(res.isError, textOf(res)).toBeFalsy();
    expect(JSON.parse(textOf(res))).toMatchObject({
      runId,
      status: 'done',
      result: expect.stringContaining('slow 1'),
    });
  });

  it('a waiting WorkflowResult sends progress naming the live agents when the client asks for it', async () => {
    const { client } = await connect({ handler: () => ({ delayMs: 300 }), progressIntervalMs: 20 });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('slow', { label: 'slow' });`,
    );
    const seen: Array<{ progress: number; message?: string }> = [];
    const res = await client.callTool(
      { name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } },
      undefined,
      { onprogress: (p) => seen.push(p) },
    );
    expect(JSON.parse(textOf(res))).toMatchObject({ runId, status: 'done' });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // MCP requires progress to increase with every notification.
    expect(seen.map((p) => p.progress)).toEqual(seen.map((_, i) => i + 1));
    expect(
      seen.some((p) => p.message?.includes('running: slow [running;')),
      JSON.stringify(seen),
    ).toBe(true);
  });

  it('WorkflowStop ends a waiting WorkflowResult with the failed outcome', async () => {
    const { client } = await connect({ handler: () => ({ delayMs: 5_000 }) });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('long');`,
    );
    await poll(client, runId, (r) => r.status === 'running' && r.liveAgents.length === 1);
    const waiting = client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } });
    const stop = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    expect(stop.isError, textOf(stop)).toBeFalsy();
    const res = await waiting;
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res))).toMatchObject({
      runId,
      status: 'failed',
      error: expect.stringMatching(/stopped by user/),
    });
  });

  it('a cancelled wait leaves the run alone: a later WorkflowResult still gets its outcome', async () => {
    const { client } = await connect({ handler: () => ({ delayMs: 200 }) });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('slow');`,
    );
    const ac = new AbortController();
    const cancelled = client.callTool(
      { name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } },
      undefined,
      { signal: ac.signal },
    );
    ac.abort('changed my mind');
    await expect(cancelled).rejects.toThrow();
    const res = await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId, wait: true } });
    expect(JSON.parse(textOf(res))).toMatchObject({ runId, status: 'done' });
  });

  it('tools/list names the custom tools of <stateDir>/tools, read again on every call', async () => {
    const { client, dir } = await connect();
    const workflowDescription = async () =>
      (await client.listTools()).tools.find((t) => t.name === 'Workflow')!.description;
    expect(await workflowDescription()).not.toContain('Custom tools for agent opts.tools');
    const example = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'tools');
    await mkdir(path.join(dir, 'state', 'tools'), { recursive: true });
    await copyFile(
      path.join(example, 'arxiv_search.js'),
      path.join(dir, 'state', 'tools', 'arxiv_search.js'),
    );
    expect(await workflowDescription()).toContain(
      'Custom tools for agent opts.tools:\n- arxiv_search: Search arXiv',
    );
  });

  it('WorkflowStop stops a running run: WorkflowResult then reports failed with run_stopped', async () => {
    const { client } = await connect({ handler: () => ({ delayMs: 5_000 }) });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('long');`,
    );
    await poll(client, runId, (r) => r.status === 'running' && r.liveAgents.length === 1);
    const stop = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    expect(stop.isError).toBeFalsy();
    expect(JSON.parse(textOf(stop))).toEqual({ runId, status: 'stopping' });
    const last = await poll(client, runId);
    expect(last).toMatchObject({ runId, status: 'failed', error: expect.stringMatching(/stopped by user/) });
    // A settled or unknown run cannot be stopped.
    const again = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    expect(again.isError).toBe(true);
    const unknown = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId: 'nope' } });
    expect(unknown.isError).toBe(true);
  });

  it('WorkflowSkip skips a live agent listed by WorkflowResult: agent() returns null, the run finishes', async () => {
    const { client } = await connect({
      handler: (req) => (req.prompt === 'slow' ? { delayMs: 5_000 } : { delayMs: 20 }),
    });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };
const [slow, fast] = await parallel([() => agent('slow', { label: 'slow' }), () => agent('fast')]);
return { slow, fast };`,
    );
    const running = await poll(
      client,
      runId,
      (r) => r.status === 'running' && r.liveAgents.some((a: any) => a.label === 'slow'),
    );
    const slow = running.liveAgents.find((a: any) => a.label === 'slow');
    const skip = await client.callTool({
      name: WORKFLOW_SKIP_TOOL_NAME,
      arguments: { runId, agentId: slow.id },
    });
    expect(skip.isError, textOf(skip)).toBeFalsy();
    const last = await poll(client, runId);
    expect(last).toMatchObject({ status: 'done', result: { slow: null, fast: expect.any(String) } });
    const stale = await client.callTool({
      name: WORKFLOW_SKIP_TOOL_NAME,
      arguments: { runId, agentId: slow.id },
    });
    expect(stale.isError).toBe(true);
  });

  it('every run of one server draws on one budget pool (spec 3.5 tek havuz)', async () => {
    const { client } = await connect({ handler: () => ({ outputTokensPerTurn: 4_000 }), budget: 6_000 });
    const script = `export const meta = { name: 'b', description: 'd' };
const before = budget.spent();
await agent('spend ' + before);
return { before, after: budget.spent(), total: budget.total };`;
    const first = await poll(client, await startWorkflow(client, script));
    expect(first).toMatchObject({ status: 'done', result: { before: 0, after: 4_000, total: 6_000 } });
    // A later run's budget.spent() already holds the first run's spend: one pool, not one per run.
    const peek = await poll(
      client,
      await startWorkflow(
        client,
        `export const meta = { name: 'p', description: 'd' };\nreturn budget.spent();`,
      ),
    );
    expect(peek).toMatchObject({ status: 'done', result: 4_000 });
    // The second run sees the first run's spend: 4000 + reserve 5000 > 6000, so its agent is refused.
    // With a fresh pool per run it would have succeeded.
    const second = await poll(client, await startWorkflow(client, script));
    expect(second).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/budget exceeded/),
    });
  });

  it('closing the server stops its live runs', async () => {
    const { client, server } = await connect({ handler: () => ({ delayMs: 5_000 }) });
    const runId = await startWorkflow(
      client,
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('long');`,
    );
    await poll(client, runId, (r) => r.status === 'running' && r.liveAgents.length === 1);
    expect(liveWorkflowAgents(runId)).toHaveLength(1);
    await server.close();
    // The run settles (stopped) long before its 5 s agent would have finished; its journal stays.
    for (let i = 0; i < 100 && liveWorkflowAgents(runId) !== null; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(liveWorkflowAgents(runId)).toBeNull();
  });

  it('a Workflow call returns a runId; WorkflowResult reports running, then done', async () => {
    const { client } = await connect();
    const started = await client.callTool({
      name: 'Workflow',
      arguments: {
        script: `export const meta = { name: 'm', description: 'd' };\nreturn await agent('x ' + args.n);`,
        args: '{"n":1}',
      },
    });
    expect(started.isError).toBeFalsy();
    const { runId, status } = JSON.parse(textOf(started));
    expect(status).toBe('started');
    expect(typeof runId).toBe('string');

    const first = JSON.parse(
      textOf(await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId } })),
    );
    expect(['running', 'done']).toContain(first.status);
    let last = first;
    for (let i = 0; i < 100 && last.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
      last = JSON.parse(
        textOf(await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId } })),
      );
    }
    expect(last).toMatchObject({ runId, status: 'done', result: expect.stringContaining('x 1') });
  });

  it('a resumed run is running again: WorkflowResult does not answer with the earlier outcome', async () => {
    let slow = false;
    const { client } = await connect({ handler: () => (slow ? { delayMs: 60_000 } : {}) });
    const script = (tag: string) =>
      `export const meta = { name: 'm', description: 'd' };\nreturn await agent('${tag}', { label: 'only' });`;
    const runId = await startWorkflow(client, script('first'));
    expect(await poll(client, runId)).toMatchObject({ status: 'done' });

    slow = true;
    const resumed = await client.callTool({
      name: 'Workflow',
      arguments: { script: script('second'), resumeFromRunId: runId },
    });
    expect(resumed.isError, textOf(resumed)).toBeFalsy();
    expect(JSON.parse(textOf(resumed)).runId).toBe(runId);
    await poll(client, runId, (r) => r.status === 'running' && r.liveAgents.length === 1);

    const stop = await client.callTool({ name: WORKFLOW_STOP_TOOL_NAME, arguments: { runId } });
    expect(stop.isError, textOf(stop)).toBeFalsy();
    const waited = await client.callTool({
      name: WORKFLOW_RESULT_TOOL_NAME,
      arguments: { runId, wait: true },
    });
    expect(JSON.parse(textOf(waited))).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stopped'),
    });
  });

  it('invalid input comes back as an MCP tool error, not a protocol error', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'Workflow', arguments: { script: 'return 1' } });
    expect(res.isError).toBe(true);
    const unknown = await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId: 'nope' } });
    expect(unknown.isError).toBe(true);
  });
});
