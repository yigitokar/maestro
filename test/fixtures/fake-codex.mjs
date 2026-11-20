#!/usr/bin/env node
// Offline codex exec double. Deliberately wait for EOF before recording or emitting anything.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, appendFile, readFile, writeFile } from 'node:fs/promises';
import { answerMcpList } from './fake-codex-mcp-list.mjs';

const scenario = JSON.parse(process.env.FAKE_CODEX_SCENARIO ?? '{}');
const argv = process.argv.slice(2);
await answerMcpList(argv);
if (scenario.exitBeforeStdin) {
  process.stderr.write('closed before reading stdin');
  process.exit(2);
}
let stdin = '';
if (argv.at(-1) === '-') {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) stdin += chunk;
}
const prompt = argv.at(-1) === '-' ? stdin : argv.at(-1);
const flagValue = (flag) => argv[argv.indexOf(flag) + 1];
if (scenario.ignoreTerm) process.on('SIGTERM', () => {});
const schema = argv.includes('--output-schema')
  ? JSON.parse(await readFile(flagValue('--output-schema'), 'utf8'))
  : undefined;
let grandchildPid;
if (scenario.grandchild) {
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
    {
      detached: scenario.grandchild === 'escaped',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  await once(grandchild, 'message'); // Its SIGTERM handler is installed before the test can abort.
  grandchildPid = grandchild.pid;
  grandchild.disconnect();
  grandchild.unref();
}
for (const [file, contents] of Object.entries(scenario.files ?? {})) await writeFile(file, contents);
let mcpTools;
let mcpResults;
if (scenario.mcpCalls) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  let mcpCommand;
  let mcpArgs;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-c') continue;
    const kv = argv[i + 1] ?? '';
    const cmdPrefix = 'mcp_servers.maestro_tools.command=';
    const argsPrefix = 'mcp_servers.maestro_tools.args=';
    if (kv.startsWith(cmdPrefix)) mcpCommand = JSON.parse(kv.slice(cmdPrefix.length));
    else if (kv.startsWith(argsPrefix)) mcpArgs = JSON.parse(kv.slice(argsPrefix.length));
  }
  const client = new Client({ name: 'fake-codex', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: mcpCommand, args: mcpArgs }));
  try {
    mcpTools = (await client.listTools()).tools;
    mcpResults = [];
    for (const c of scenario.mcpCalls) {
      mcpResults.push(await client.callTool({ name: c.name, arguments: c.arguments ?? {} }));
    }
  } finally {
    await client.close();
  }
}
await appendFile(
  process.env.FAKE_CODEX_RECORD,
  `${JSON.stringify({ argv, cwd: process.cwd(), pid: process.pid, grandchildPid, stdin, prompt, schema, mcpTools, mcpResults })}\n`,
);

if (scenario.stderr) process.stderr.write(scenario.stderr);
for (const step of scenario.steps ?? []) {
  if (step.waitForFile) {
    while (
      !(await access(step.waitForFile).then(
        () => true,
        () => false,
      ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
  const output = step.raw ?? `${JSON.stringify(step.event)}\n`;
  await new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => (error ? reject(error) : resolve()));
  });
}
if (scenario.hold) await new Promise(() => setInterval(() => {}, 1000));
if (scenario.finalText !== undefined) await writeFile(flagValue('-o'), scenario.finalText);
process.exitCode = scenario.exitCode ?? 0;
