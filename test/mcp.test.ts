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
import {
  serveMcp,
  WORKFLOW_GUIDE_TOOL_NAME,
  WORKFLOW_RESULT_TOOL_NAME,
  WORKFLOW_SKIP_TOOL_NAME,
  WORKFLOW_STOP_TOOL_NAME,
} from '../src/mcp.js';
import { type FakeHandler, FakeRunner } from '../src/testing/fake-runner.js';
import { liveWorkflowAgents } from '../src/tool.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connect(opts: { handler?: FakeHandler; budget?: number; progressIntervalMs?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-mcp-'));
  // Two pipes: client → server (server stdin) and server → client (server stdout). The client side
  // reuses the line-delimited JSON-RPC stdio transport on the opposite ends.
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = await serveMcp(
    {
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      runner: new FakeRunner(opts.handler ?? (() => ({ delayMs: 20 }))),
      concurrency: 2,
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
      ].sort(),
    );
    for (const t of tools) expect((t.inputSchema as any).additionalProperties, t.name).toBe(false);
    const skip = tools.find((t) => t.name === WORKFLOW_SKIP_TOOL_NAME)!;
    expect((skip.inputSchema as any).required).toEqual(['runId', 'agentId']);
    const result = tools.find((t) => t.name === WORKFLOW_RESULT_TOOL_NAME)!;
    expect((result.inputSchema as any).required).toEqual(['runId']);
    expect((result.inputSchema as any).properties.wait.type).toBe('boolean');
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
      seen.some((p) => p.message === 'running: slow'),
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
