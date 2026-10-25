// `maestro mcp`: the Workflow tool over the stdio transport, driven by a real MCP client in-process.

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { serveMcp, WORKFLOW_RESULT_TOOL_NAME } from '../src/mcp.js';
import { FakeRunner } from '../src/testing/fake-runner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connect() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-mcp-'));
  // Two pipes: client → server (server stdin) and server → client (server stdout). The client side
  // reuses the line-delimited JSON-RPC stdio transport on the opposite ends.
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = await serveMcp(
    {
      cwd: dir,
      stateDir: path.join(dir, 'state'),
      runner: new FakeRunner(() => ({ delayMs: 20 })),
      concurrency: 2,
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
  return { client };
}

const textOf = (res: any): string => res.content[0].text;

describe('maestro mcp', () => {
  it('tools/list returns Workflow and WorkflowResult', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['Workflow', WORKFLOW_RESULT_TOOL_NAME].sort());
    const wf = tools.find((t) => t.name === 'Workflow')!;
    expect((wf.inputSchema as any).additionalProperties).toBe(false);
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

  it('invalid input comes back as an MCP tool error, not a protocol error', async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: 'Workflow', arguments: { script: 'return 1' } });
    expect(res.isError).toBe(true);
    const unknown = await client.callTool({ name: WORKFLOW_RESULT_TOOL_NAME, arguments: { runId: 'nope' } });
    expect(unknown.isError).toBe(true);
  });
});
