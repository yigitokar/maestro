#!/usr/bin/env node
// `maestro` CLI: a thin shell over run() and gc(). The script's return value goes to stdout as JSON,
// progress and diagnostics go to stderr. main() returns the exit code and never calls process.exit.

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseBudgetDirective } from './budget.js';
import { gc } from './isolation.js';
import { serveMcp } from './mcp.js';
import { attachTerminalProgress, type ProgressStream } from './progress.js';
import { AnthropicRunner } from './runner.js';
import { FakeRunner } from './testing/fake-runner.js';
import type { AgentRunner } from './types.js';
import { run } from './workflow.js';

export const USAGE = `usage:
  maestro run <script.js> [--args <json>] [--args-file <file>] [--resume <runId>] [--budget <500k>]
                          [--dry-run] [--cwd <dir>] [--state-dir <dir>] [--concurrency <n>] [--model <model>]
  maestro run --resume <runId> [options]     resume with the stored script.js and args.json
  maestro gc [--delete] [--force] [--cwd <dir>]
  maestro mcp [--cwd <dir>] [--state-dir <dir>] [--budget <500k>] [--concurrency <n>] [--model <model>] [--dry-run]
                                             serve the Workflow tool over stdio as an MCP server
                                             (--budget is one pool for the whole session; exits 0 when stdin ends)

  --dry-run   run every agent with an in-memory fake runner (schema stubs, no network)
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
  'concurrency',
  'model',
]);
const BOOL_FLAGS = new Set(['dry-run', 'delete', 'force', 'help']);

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
  let runner: AgentRunner;
  if (dryRun) runner = new FakeRunner();
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
  const handle = run({
    ...(scriptArg !== undefined ? { scriptPath: path.resolve(io.cwd, scriptArg) } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(resume !== undefined ? { resumeFromRunId: resume } : {}),
    ...(stateDir !== undefined ? { stateDir: path.resolve(io.cwd, stateDir) } : {}),
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
  // stdout is the MCP channel: diagnostics go to stderr only.
  if (!dryRun && !io.env.ANTHROPIC_API_KEY) {
    io.stderr.write('maestro mcp: ANTHROPIC_API_KEY is not set; Workflow runs will fail until it is.\n');
  }
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDir = str(p, 'state-dir');
  // A numeric budget becomes one Budget shared by every run of this server (createMcpServer).
  const server = await serveMcp(
    {
      runner: dryRun ? new FakeRunner() : new AnthropicRunner(),
      cwd,
      budget,
      ...(stateDir !== undefined ? { stateDir: path.resolve(io.cwd, stateDir) } : {}),
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
