#!/usr/bin/env node
// Offline stdio app-server double. Never starts a model or accesses the network.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const scenario = JSON.parse(process.env.FAKE_APP_SERVER_SCENARIO ?? '{}');
const argv = process.argv.slice(2);
const record = (value) => appendFile(process.env.FAKE_APP_SERVER_RECORD, `${JSON.stringify(value)}\n`);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notice = (method, params) =>
  send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });
const reply = (request, result) => send({ id: request.id, result });
if (scenario.ignoreTerm) process.on('SIGTERM', () => {});
let grandchildPid;
if (scenario.grandchild) {
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],
    {
      detached: scenario.grandchild === 'escaped',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  await once(grandchild, 'message');
  grandchildPid = grandchild.pid;
  grandchild.disconnect();
  grandchild.unref();
}
await record({ type: 'startup', argv, pid: process.pid, grandchildPid, cwd: process.cwd() });
const lines = createInterface({ input: process.stdin });
let steers = 0;
let finished = false;
let approvals = 0;
function finish() {
  if (finished) return;
  finished = true;
  if (scenario.finalText !== null) {
    notice('item/completed', {
      item: {
        id: 'answer',
        type: 'agentMessage',
        phase: scenario.phase ?? 'final_answer',
        text: scenario.finalText ?? 'done',
      },
    });
  }
  notice('turn/completed', {
    turn: {
      id: 'turn-1',
      status: scenario.status ?? 'completed',
      items: [],
      ...(scenario.error ? { error: { message: scenario.error } } : {}),
    },
  });
}
async function customTools() {
  if (!scenario.mcpCalls) return;
  let command;
  let args;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue;
    const value = argv[i + 1] ?? '';
    if (value.startsWith('mcp_servers.maestro_tools.command='))
      command = JSON.parse(value.split('=').slice(1).join('='));
    if (value.startsWith('mcp_servers.maestro_tools.args='))
      args = JSON.parse(value.split('=').slice(1).join('='));
  }
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'fake-app-server', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command, args }));
  try {
    for (const call of scenario.mcpCalls) await record({ type: 'mcp', result: await client.callTool(call) });
  } finally {
    await client.close();
  }
}
async function receive(request) {
  await record({ type: 'request', request });
  if (scenario.failMethod && request.method === scenario.failMethod) {
    send({ id: request.id, error: { code: -32601, message: 'fixture method rejected' } });
  } else if (request.method === 'initialize') reply(request, { userAgent: 'fixture' });
  else if (request.method === 'thread/start') reply(request, { thread: { id: 'thread-1' } });
  else if (request.method === 'turn/start') {
    if (scenario.abruptExit) process.exit(scenario.abruptExit);
    reply(request, { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    notice('turn/started', { turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    for (const [file, content] of Object.entries(scenario.files ?? {})) await writeFile(file, content);
    for (const event of scenario.events ?? []) notice(event.method, event.params);
    await customTools();
    if (scenario.approvals) {
      for (const [index, method] of scenario.approvals.entries())
        send({ id: 1000 + index, method, params: {} });
    } else if (!scenario.hold && !scenario.holdUntilSteers) finish();
  } else if (request.method === 'turn/steer') {
    steers++;
    if (scenario.finishBeforeAck) {
      finish();
      return;
    }
    if (scenario.ignoreSteer) {
      if (scenario.finishAfterIgnoredSteerMs) setTimeout(finish, scenario.finishAfterIgnoredSteerMs);
      return;
    }
    if (scenario.ackAndFinishTogether) {
      finished = true;
      process.stdout.write(
        `${[
          { id: request.id, result: { turnId: 'turn-1' } },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'done' },
            },
          },
          {
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join('\n')}\n`,
      );
      return;
    }
    if (scenario.rejectSteer)
      send({ id: request.id, error: { code: -32000, message: 'active turn mismatch' } });
    else reply(request, { turnId: 'turn-1' });
    if (steers >= (scenario.holdUntilSteers ?? Infinity)) setTimeout(finish, 10);
  } else if (typeof request.id === 'number' && request.id >= 1000) {
    approvals++;
    if (approvals >= scenario.approvals.length) finish();
  }
}
lines.on('line', (line) => {
  void receive(JSON.parse(line)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
    lines.close();
  });
});
