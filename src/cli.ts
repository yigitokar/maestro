#!/usr/bin/env node
// `maestro` CLI: a thin shell over run() and gc(). The script's return value goes to stdout as JSON,
// progress and diagnostics go to stderr. main() returns the exit code and never calls process.exit.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseBudgetDirective } from './budget.js';
import { CodexRunner } from './codex-runner.js';
import { gc } from './isolation.js';
import { readEntries, readTrace } from './journal.js';
import { serveMcp } from './mcp.js';
import { attachTerminalProgress, type ProgressStream } from './progress.js';
import { AnthropicRunner } from './runner.js';
import { FakeRunner } from './testing/fake-runner.js';
import type { AgentRunner, Entry } from './types.js';
import { cacheReadRatio, totalInput } from './usage.js';
import { exportVizHtml, serveViz } from './viz.js';
import { run } from './workflow.js';

export const USAGE = `usage:
  maestro run <script.js> [--args <json>] [--args-file <file>] [--resume <runId>] [--budget <500k>]
                          [--dry-run] [--cwd <dir>] [--state-dir <dir>] [--tools-dir <dir>] [--concurrency <n>]
                          [--model <model>] [--runner <anthropic|codex>]
  maestro run --resume <runId> [options]     resume with the stored script.js and args.json
  maestro gc [--delete] [--force] [--cwd <dir>]
  maestro show <runId> [label] [--cwd <dir>] [--state-dir <dir>]
                                             list a run's agents; with a label (or key prefix), print
                                             that agent's trace: tool calls, final text, result, error
  maestro viz <runId> [--cwd <dir>] [--state-dir <dir>] [--port <n>] [--no-open] [--out <file.html>]
                                             open a run's timeline in the browser; it follows a live run
                                             (--out writes the page as one self-contained HTML file instead)
  maestro mcp [--cwd <dir>] [--state-dir <dir>] [--tools-dir <dir>] [--budget <500k>] [--concurrency <n>]
              [--model <model>] [--runner <anthropic|codex>] [--dry-run]
                                             serve the Workflow tool over stdio as an MCP server
                                             (--budget is one pool for the whole session; exits 0 when stdin ends)

  --dry-run   run every agent with an in-memory fake runner (schema stubs, no network)
  --runner    agent runner: anthropic (default) or codex; --dry-run takes precedence
  --tools-dir custom tools agents may name in opts.tools: *.js files that default-export a tool
              (default <state-dir>/tools)
  gc          lists dirty worktrees and merged / unmerged wf/* branches; deletes only with --delete
              (--force also deletes unmerged branches)`;

export interface CliIO {
  /** MCP channel input for `maestro mcp` (default process.stdin); the server ends when it ends. */
  stdin: Readable;
  /** `maestro mcp` writes JSON-RPC here, so it must then be a real Writable (default process.stdout). */
  stdout: { write(chunk: string): unknown };
  stderr: ProgressStream;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Install a SIGINT handler that stops the run (default true only for the real process). */
  handleSignals: boolean;
}

class UsageError extends Error {}

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  'args',
  'args-file',
  'resume',
  'budget',
  'cwd',
  'state-dir',
  'tools-dir',
  'concurrency',
  'model',
  'runner',
  'out',
  'port',
]);
const BOOL_FLAGS = new Set(['dry-run', 'delete', 'force', 'help', 'no-open']);

function parseArgv(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') {
      flags.set('help', true);
      continue;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  return { positionals, flags };
}

function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

function runnerName(p: Parsed): 'anthropic' | 'codex' {
  const name = str(p, 'runner') ?? 'anthropic';
  if (name !== 'anthropic' && name !== 'codex') {
    throw new UsageError(`invalid --runner "${name}" (expected anthropic or codex)`);
  }
  return name;
}

export async function main(argv: string[], ioOverrides: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    handleSignals: false,
    ...ioOverrides,
  };
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.stdout.write(`${USAGE}\n`);
      return command === undefined ? 1 : 0;
    }
    const parsed = parseArgv(rest);
    if (parsed.flags.has('help')) {
      io.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command === 'run') return await runCommand(parsed, io);
    if (command === 'gc') return await gcCommand(parsed, io);
    if (command === 'show') return await showCommand(parsed, io);
    if (command === 'viz') return await vizCommand(parsed, io);
    if (command === 'mcp') return await mcpCommand(parsed, io);
    throw new UsageError(`unknown command "${command}"`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr.write(`maestro: ${e.message}\n${USAGE}\n`);
      return 1;
    }
    io.stderr.write(`maestro: ${errorText(e)}\n`);
    return 1;
  }
}

async function runCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 1)
    throw new UsageError(`unexpected arguments: ${p.positionals.slice(1).join(' ')}`);
  const scriptArg = p.positionals[0];
  const resume = str(p, 'resume');
  if (scriptArg === undefined && resume === undefined)
    throw new UsageError('run needs a script file or --resume');
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');

  let args: unknown;
  const argsJson = str(p, 'args');
  const argsFile = str(p, 'args-file');
  if (argsJson !== undefined && argsFile !== undefined)
    throw new UsageError('use either --args or --args-file');
  try {
    if (argsJson !== undefined) args = JSON.parse(argsJson);
    if (argsFile !== undefined) args = JSON.parse(await readFile(path.resolve(io.cwd, argsFile), 'utf8'));
  } catch (e) {
    throw new UsageError(`invalid args JSON: ${errorText(e)}`);
  }

  let budget: number | null = null;
  const budgetArg = str(p, 'budget');
  if (budgetArg !== undefined) {
    budget = parseBudgetDirective(budgetArg);
    if (budget === null) throw new UsageError(`invalid --budget "${budgetArg}" (e.g. 500k, 1.5m, 20000)`);
  }

  let concurrency: number | undefined;
  const concArg = str(p, 'concurrency');
  if (concArg !== undefined) {
    concurrency = Number(concArg);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new UsageError(`--concurrency must be a positive integer, got "${concArg}"`);
    }
  }

  const dryRun = p.flags.has('dry-run');
  const selectedRunner = runnerName(p);
  let runner: AgentRunner;
  if (dryRun) runner = new FakeRunner();
  else if (selectedRunner === 'codex') runner = new CodexRunner();
  else {
    if (!io.env.ANTHROPIC_API_KEY) {
      io.stderr.write(
        'maestro: ANTHROPIC_API_KEY is not set. Agents call the Anthropic API; export the key first, ' +
          'or use --dry-run to run the script against an in-memory fake runner.\n',
      );
      return 1;
    }
    runner = new AnthropicRunner();
  }

  const stateDir = str(p, 'state-dir');
  const toolsDir = str(p, 'tools-dir');
  const handle = run({
    ...(scriptArg !== undefined ? { scriptPath: path.resolve(io.cwd, scriptArg) } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(resume !== undefined ? { resumeFromRunId: resume } : {}),
    ...(stateDir !== undefined ? { stateDir: path.resolve(io.cwd, stateDir) } : {}),
    ...(toolsDir !== undefined ? { toolsDir: path.resolve(io.cwd, toolsDir) } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(str(p, 'model') !== undefined ? { model: str(p, 'model') } : {}),
    runner,
    cwd,
    budget,
  });
  io.stderr.write(`maestro: run ${handle.runId}${dryRun ? ' (dry run)' : ''} in ${handle.runDir}\n`);
  const detach = attachTerminalProgress(handle, io.stderr);
  const onSigint = () => handle.stop('interrupted (SIGINT)');
  if (io.handleSignals) process.once('SIGINT', onSigint);
  try {
    const value = await handle.promise;
    io.stdout.write(`${JSON.stringify(value === undefined ? null : value, null, 2)}\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`maestro: run ${handle.runId} failed: ${errorText(e)}\n`);
    io.stderr.write(`maestro: resume with: maestro run --resume ${handle.runId}\n`);
    return 1;
  } finally {
    detach();
    if (io.handleSignals) process.off('SIGINT', onSigint);
  }
}

async function gcCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 0) throw new UsageError(`unexpected arguments: ${p.positionals.join(' ')}`);
  const repoDir = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const res = await gc({ repoDir, delete: p.flags.has('delete'), force: p.flags.has('force') });
  const out: string[] = [];
  const list = (title: string, items: string[]) => {
    out.push(`${title}:`);
    if (items.length === 0) out.push('  (none)');
    for (const i of items) out.push(`  ${i}`);
  };
  out.push('dirty worktrees:');
  if (res.dirtyWorktrees.length === 0) out.push('  (none)');
  for (const w of res.dirtyWorktrees) {
    out.push(`  ${w.path}${w.branch ? ` [${w.branch}]` : ''}`);
    for (const l of w.diffStat.split('\n')) if (l.trim() !== '') out.push(`    ${l.trim()}`);
  }
  list('merged wf/* branches', res.mergedBranches);
  list('unmerged wf/* branches', res.unmergedBranches);
  if (p.flags.has('delete')) list('removed', res.removed);
  else
    out.push(
      '(nothing deleted; pass --delete to remove worktrees and merged branches, --force for unmerged)',
    );
  io.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

async function mcpCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 0) throw new UsageError(`unexpected arguments: ${p.positionals.join(' ')}`);
  const budgetArg = str(p, 'budget');
  const budget = budgetArg === undefined ? null : parseBudgetDirective(budgetArg);
  if (budgetArg !== undefined && budget === null) throw new UsageError(`invalid --budget "${budgetArg}"`);
  const concArg = str(p, 'concurrency');
  const concurrency = concArg === undefined ? undefined : Number(concArg);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new UsageError(`--concurrency must be a positive integer, got "${concArg}"`);
  }
  const dryRun = p.flags.has('dry-run');
  const selectedRunner = runnerName(p);
  // stdout is the MCP channel: diagnostics go to stderr only.
  if (!dryRun && selectedRunner === 'anthropic' && !io.env.ANTHROPIC_API_KEY) {
    io.stderr.write('maestro mcp: ANTHROPIC_API_KEY is not set; Workflow runs will fail until it is.\n');
  }
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDir = str(p, 'state-dir');
  const toolsDir = str(p, 'tools-dir');
  // A numeric budget becomes one Budget shared by every run of this server (createMcpServer).
  const server = await serveMcp(
    {
      runner: dryRun
        ? new FakeRunner()
        : selectedRunner === 'codex'
          ? new CodexRunner()
          : new AnthropicRunner(),
      cwd,
      budget,
      ...(stateDir !== undefined ? { stateDir: path.resolve(io.cwd, stateDir) } : {}),
      ...(toolsDir !== undefined ? { toolsDir: path.resolve(io.cwd, toolsDir) } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(str(p, 'model') !== undefined ? { model: str(p, 'model') } : {}),
    },
    new StdioServerTransport(io.stdin, io.stdout as Writable),
  );
  // StdioServerTransport never closes on stdin EOF: the client disconnecting must end the command,
  // or the bin's top-level await never settles.
  await new Promise<void>((resolve) => {
    const stopRuns = server.onclose;
    server.onclose = () => {
      stopRuns?.();
      resolve();
    };
    const close = () => void server.close();
    io.stdin.once('end', close);
    io.stdin.once('close', close);
    if (io.stdin.readableEnded || io.stdin.destroyed) close();
  });
  return 0;
}

async function showCommand(p: Parsed, io: CliIO): Promise<number> {
  const [runId, label, ...extra] = p.positionals;
  if (runId === undefined) throw new UsageError('show needs a runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  let rows: Entry[];
  try {
    rows = await readEntries(runDir);
  } catch (e) {
    io.stderr.write(`maestro: no journal for run ${runId} in ${runDir} (${errorText(e)})\n`);
    return 1;
  }
  if (label === undefined) {
    for (const row of rows) io.stdout.write(`${rowLine(row)}\n`);
    return 0;
  }
  let picked = rows.filter((r) => r.label === label);
  if (picked.length === 0) picked = rows.filter((r) => r.key.startsWith(label));
  if (picked.length === 0) {
    io.stderr.write(`maestro: no agent labelled "${label}" in run ${runId}\n`);
    return 1;
  }
  for (const row of picked) io.stdout.write(`${await showRow(runDir, row)}\n`);
  return 0;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function vizCommand(p: Parsed, io: CliIO): Promise<number> {
  const [runId, ...extra] = p.positionals;
  if (runId === undefined) throw new UsageError('viz needs a runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  if (!SAFE_RUN_ID.test(runId)) throw new UsageError(`invalid runId "${runId}"`);
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  if (!existsSync(runDir)) {
    io.stderr.write(`maestro: no run ${runId} in ${path.dirname(runDir)}\n`);
    return 1;
  }
  const out = str(p, 'out');
  if (out !== undefined) {
    const file = path.resolve(io.cwd, out);
    await writeFile(file, await exportVizHtml(runDir, runId));
    io.stdout.write(`${file}\n`);
    return 0;
  }
  const portArg = str(p, 'port');
  const port = portArg === undefined ? 0 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new UsageError(`invalid --port "${portArg}"`);
  const server = await serveViz({ runDir, runId, port });
  io.stderr.write(`maestro viz: ${server.url}  (Ctrl-C to stop)\n`);
  if (!p.flags.has('no-open')) openBrowser(server.url);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  return 0;
}

/** Best effort: a missing opener only means the user opens the printed URL themselves. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Printed URL is enough.
  }
}

const SHOW_RESULT_CHARS = 2_000;

function rowLine(row: Entry): string {
  const ratio = cacheReadRatio(row.usage);
  const cached = ratio === null ? '' : ` (${Math.round(ratio * 100)}% cached)`;
  const calls = row.trace && 'toolCalls' in row.trace ? `, ${row.trace.toolCalls.length} tool calls` : '';
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    `#${row.index} ${row.label ?? row.key.slice(0, 12)} [${row.status}] ` +
    `${n(totalInput(row.usage))} in${cached}, ${n(row.usage.output_tokens)} out${calls}` +
    (row.error ? ` · ${row.error}` : '')
  );
}

async function showRow(runDir: string, row: Entry): Promise<string> {
  const lines = [rowLine(row), `key: ${row.key}${row.phase ? `  phase: ${row.phase}` : ''}`];
  const trace = await readTrace(runDir, row);
  if (!trace) lines.push('trace: none (cache hit replayed, a runner without traces, or a pre-v1.1 row)');
  else {
    lines.push(`tool calls (${trace.toolCalls.length}):`);
    for (const c of trace.toolCalls) lines.push(`  ${c.ok ? '✓' : '✗'} ${c.tool} ${c.inputSummary}`);
    lines.push(`final text (${trace.finalText.length} chars, at most 2,000):`);
    lines.push(trace.finalText === '' ? '  (empty)' : indent(trace.finalText));
  }
  let result: unknown = row.result;
  if (row.blob === true) {
    try {
      result = JSON.parse(await readFile(path.join(runDir, 'blobs', `${row.key}.json`), 'utf8'));
    } catch {
      result = '(result blob unreadable)';
    }
  }
  const json = JSON.stringify(result, null, 2) ?? 'null';
  lines.push(
    `result:\n${indent(json.length > SHOW_RESULT_CHARS ? `${json.slice(0, SHOW_RESULT_CHARS)}\n…` : json)}`,
  );
  if (row.raw !== undefined) lines.push(`raw:\n${indent(row.raw.slice(0, SHOW_RESULT_CHARS))}`);
  if (row.error !== undefined) lines.push(`error: ${row.error}`);
  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');
}

function errorText(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(e);
}

function invokedAsBin(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsBin()) {
  void main(process.argv.slice(2), { handleSignals: true }).then((code) => {
    process.exitCode = code;
  });
}
