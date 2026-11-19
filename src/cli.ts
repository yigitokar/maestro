#!/usr/bin/env node
// `maestro` CLI: a thin shell over run() and gc(). The script's return value goes to stdout as JSON,
// progress and diagnostics go to stderr. main() returns the exit code and never calls process.exit.

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseBudgetDirective } from './budget.js';
import { CodexRunner } from './codex-runner.js';
import { diffEvalRuns, formatEvalDiff, formatEvalSummary, listEvalRecords, runEval } from './eval.js';
import { EVENT_LOG_FILE } from './event-log.js';
import { GatewayRunner } from './gateway-runner.js';
import { GeminiRunner } from './gemini-runner.js';
import { formatInspectMarkdown, inspectRun } from './inspect.js';
import { gc } from './isolation.js';
import { readEntries, readResultBlob, readTrace } from './journal.js';
import { serveMcp } from './mcp.js';
import { attachTerminalProgress, formatLiveAgent, type ProgressStream } from './progress.js';
import { RoutingRunner } from './routing-runner.js';
import { AnthropicRunner, type StructuredMode } from './runner.js';
import { parseScript } from './runtime.js';
import { FakeRunner } from './testing/fake-runner.js';
import type { AgentRunner, Entry, LiveAgentStatus, Usage } from './types.js';
import { addUsage, cacheReadRatio, totalInput } from './usage.js';
import { exportVizHtml, exportVizWidget, readEventLines, serveViz } from './viz.js';
import { readOutcome, run, SAFE_ID } from './workflow.js';

export const USAGE = `usage:
  maestro run <script.js> [--args <json>] [--args-file <file>] [--resume <runId>] [--budget <500k>]
                          [--dry-run] [--cwd <dir>] [--state-dir <dir>] [--tools-dir <dir>] [--concurrency <n>]
                          [--model <model>] [--runner <anthropic|codex|gemini|auto|gateway>]
                          [--structured-mode <two-stage|submit-tool|single-stage>]
  maestro run --resume <runId> [options]     resume with the stored script.js and args.json
  maestro replay <runId> [--from <node>] [script.js] [options]
                                             fork upstream cached agents into a new runId and re-execute live from <node>
                                             (<node>: label, #index, key prefix, or phase:<title>; original run stays untouched)
  maestro runs [--cwd <dir>] [--state-dir <dir>] [--limit <n>]
                                             list runs newest-first with status, agents and token usage (alias: ls)
  maestro gc [--delete] [--force] [--cwd <dir>]
  maestro show <runId> [label-or-live-id] [--compact] [--json] [--cwd <dir>] [--state-dir <dir>]
                                             list completed agents and latest recorded live activity; with a label (or key prefix), print
                                             that agent's trace: tool calls, final text, result, error
  maestro inspect <runId> [label-or-key] [--compact] [--json] [--cwd <dir>] [--state-dir <dir>]
                                             agent-friendly diagnostic summary: failed nodes, exact inputs/outputs, and relevant upstream state
  maestro eval <script.js> --cases <file> [--grader <file.js>] [--name <evalId>] [--from-eval <evalId>] [--from <node>]
                           [--only <ids>] [--limit <n>] [--case-concurrency <n>] [--json] [run options]
                                             run a workflow across an eval dataset (JSON/JSONL) and save results under <state-dir>/evals/
  maestro eval diff <run-a> <run-b> [--json] [--fail-on-regression] [--cwd <dir>] [--state-dir <dir>]
                                             side-by-side comparison: score delta, fixed vs regressions, tokens/cost and [CACHE HIT] ratio
  maestro eval ls [--limit <n>] [--json] [--cwd <dir>] [--state-dir <dir>]
                                             list saved eval runs newest-first
  maestro viz <runId> [--cwd <dir>] [--state-dir <dir>] [--port <n>] [--no-open] [--out <file.html>] [--widget]
                                             open a run's timeline in the browser; it follows a live run
                                             (--out writes the page as one self-contained HTML file instead;
                                             --widget prints a snapshot fragment for a chat's inline widget tool)
  maestro mcp [--cwd <dir>] [--state-dir <dir>] [--tools-dir <dir>] [--budget <500k>] [--concurrency <n>]
              [--model <model>] [--runner <anthropic|codex|gemini|auto|gateway>]
              [--structured-mode <two-stage|submit-tool|single-stage>] [--dry-run]
                                             serve the Workflow tool over stdio as an MCP server
                                             (--budget is one pool for the whole session; exits 0 when stdin ends)

  --dry-run          run every agent with an in-memory fake runner (schema stubs, no network)
  --runner           agent runner: anthropic (default), codex, gemini, auto (routes by model), or gateway; --dry-run takes precedence
  --structured-mode  schema output mode: two-stage, submit-tool, or single-stage
                     defaults: anthropic/gemini/auto two-stage; gateway submit-tool
  gemini             requires GEMINI_API_KEY (or GOOGLE_API_KEY); defaults to gemini-4-hydrogen
  gateway            requires AI_GATEWAY_API_KEY and provider/model IDs via --model or agent opts.model
  --tools-dir        custom tools agents may name in opts.tools: *.js files that default-export a tool
                     (default <state-dir>/tools)
  gc                 lists dirty worktrees and merged / unmerged wf/* branches; deletes only with --delete
                     (clean worktrees and merged branches; --force also deletes dirty worktrees and
                     unmerged branches)`;

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
  'from',
  'from-eval',
  'cases',
  'grader',
  'name',
  'only',
  'case-concurrency',
  'budget',
  'cwd',
  'state-dir',
  'tools-dir',
  'concurrency',
  'model',
  'runner',
  'structured-mode',
  'limit',
  'out',
  'port',
]);
const BOOL_FLAGS = new Set([
  'dry-run',
  'delete',
  'force',
  'help',
  'no-open',
  'widget',
  'compact',
  'json',
  'fail-on-regression',
]);

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

function runnerName(p: Parsed): 'anthropic' | 'codex' | 'gemini' | 'auto' | 'gateway' {
  const name = str(p, 'runner') ?? 'anthropic';
  if (
    name !== 'anthropic' &&
    name !== 'codex' &&
    name !== 'gemini' &&
    name !== 'auto' &&
    name !== 'gateway'
  ) {
    throw new UsageError(`invalid --runner "${name}" (expected anthropic, codex, gemini, auto or gateway)`);
  }
  return name;
}

function geminiKeyFromEnv(env: Record<string, string | undefined>): string | undefined {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || undefined;
}

function structuredModeFlag(p: Parsed): StructuredMode | undefined {
  const mode = str(p, 'structured-mode');
  if (mode === undefined) return undefined;
  if (mode !== 'two-stage' && mode !== 'submit-tool' && mode !== 'single-stage') {
    throw new UsageError(
      `invalid --structured-mode "${mode}" (expected two-stage, submit-tool or single-stage)`,
    );
  }
  return mode;
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
    if (command === 'replay') return await replayCommand(parsed, io);
    if (command === 'runs' || command === 'ls') return await runsCommand(parsed, io);
    if (command === 'gc') return await gcCommand(parsed, io);
    if (command === 'show') return await showCommand(parsed, io);
    if (command === 'inspect') return await inspectCommand(parsed, io);
    if (command === 'eval') return await evalCommand(parsed, io);
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

interface ExecutionOptions {
  cwd: string;
  args: unknown;
  budget: number | null;
  concurrency: number | undefined;
  dryRun: boolean;
  runner: AgentRunner;
  stateDir: string | undefined;
  toolsDir: string | undefined;
  model: string | undefined;
}

async function parseExecutionOptions(p: Parsed, io: CliIO): Promise<ExecutionOptions | null> {
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
  const structuredMode = structuredModeFlag(p);
  const geminiApiKey = geminiKeyFromEnv(io.env);
  let runner: AgentRunner;
  if (dryRun) runner = new FakeRunner();
  else if (selectedRunner === 'codex') runner = new CodexRunner();
  else if (selectedRunner === 'gemini') {
    if (!geminiApiKey) {
      io.stderr.write(
        'maestro: GEMINI_API_KEY (or GOOGLE_API_KEY) is missing or blank. Export the key first, or use --dry-run for offline runs.\n',
      );
      return null;
    }
    runner = new GeminiRunner({ apiKey: geminiApiKey, structuredMode });
  } else if (selectedRunner === 'auto') {
    runner = new RoutingRunner({
      anthropic: { structuredMode },
      gemini: { apiKey: geminiApiKey ?? '', structuredMode },
    });
  } else if (selectedRunner === 'gateway') {
    if (!io.env.AI_GATEWAY_API_KEY?.trim()) {
      io.stderr.write(
        'maestro: AI_GATEWAY_API_KEY is missing or blank. Export the key first, or use --dry-run for offline runs.\n',
      );
      return null;
    }
    runner = new GatewayRunner({ apiKey: io.env.AI_GATEWAY_API_KEY, structuredMode });
  } else {
    if (!io.env.ANTHROPIC_API_KEY) {
      io.stderr.write(
        'maestro: ANTHROPIC_API_KEY is not set. Agents call the Anthropic API; export the key first, ' +
          'or use --dry-run to run the script against an in-memory fake runner.\n',
      );
      return null;
    }
    runner = new AnthropicRunner({ structuredMode });
  }

  const stateDir = str(p, 'state-dir');
  const toolsDir = str(p, 'tools-dir');
  return {
    cwd,
    args,
    budget,
    concurrency,
    dryRun,
    runner,
    stateDir: stateDir !== undefined ? path.resolve(io.cwd, stateDir) : undefined,
    toolsDir: toolsDir !== undefined ? path.resolve(io.cwd, toolsDir) : undefined,
    model: str(p, 'model'),
  };
}

async function runCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 1)
    throw new UsageError(`unexpected arguments: ${p.positionals.slice(1).join(' ')}`);
  const scriptArg = p.positionals[0];
  const resume = str(p, 'resume');
  if (scriptArg === undefined && resume === undefined)
    throw new UsageError('run needs a script file or --resume');
  const exec = await parseExecutionOptions(p, io);
  if (!exec) return 1;

  const handle = run({
    ...(scriptArg !== undefined ? { scriptPath: path.resolve(io.cwd, scriptArg) } : {}),
    ...(exec.args !== undefined ? { args: exec.args } : {}),
    ...(resume !== undefined ? { resumeFromRunId: resume } : {}),
    ...(exec.stateDir !== undefined ? { stateDir: exec.stateDir } : {}),
    ...(exec.toolsDir !== undefined ? { toolsDir: exec.toolsDir } : {}),
    ...(exec.concurrency !== undefined ? { concurrency: exec.concurrency } : {}),
    ...(exec.model !== undefined ? { model: exec.model } : {}),
    runner: exec.runner,
    cwd: exec.cwd,
    budget: exec.budget,
  });
  io.stderr.write(`maestro: run ${handle.runId}${exec.dryRun ? ' (dry run)' : ''} in ${handle.runDir}\n`);
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

async function replayCommand(p: Parsed, io: CliIO): Promise<number> {
  const [sourceRunId, scriptArg, ...extra] = p.positionals;
  if (sourceRunId === undefined) throw new UsageError('replay needs a source runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  if (!SAFE_ID.test(sourceRunId)) throw new UsageError(`invalid runId "${sourceRunId}"`);
  if (str(p, 'resume') !== undefined) throw new UsageError('replay does not accept --resume');
  const from = str(p, 'from');
  const exec = await parseExecutionOptions(p, io);
  if (!exec) return 1;

  const handle = run({
    ...(scriptArg !== undefined ? { scriptPath: path.resolve(io.cwd, scriptArg) } : {}),
    ...(exec.args !== undefined ? { args: exec.args } : {}),
    replayFrom: { runId: sourceRunId, ...(from !== undefined ? { from } : {}) },
    ...(exec.stateDir !== undefined ? { stateDir: exec.stateDir } : {}),
    ...(exec.toolsDir !== undefined ? { toolsDir: exec.toolsDir } : {}),
    ...(exec.concurrency !== undefined ? { concurrency: exec.concurrency } : {}),
    ...(exec.model !== undefined ? { model: exec.model } : {}),
    runner: exec.runner,
    cwd: exec.cwd,
    budget: exec.budget,
  });
  const fromNote = from ? ` --from ${from}` : '';
  io.stderr.write(
    `maestro: replay ${handle.runId} (from ${sourceRunId}${fromNote})${exec.dryRun ? ' (dry run)' : ''} in ${handle.runDir}\n`,
  );
  const detach = attachTerminalProgress(handle, io.stderr);
  const onSigint = () => handle.stop('interrupted (SIGINT)');
  if (io.handleSignals) process.once('SIGINT', onSigint);
  try {
    const value = await handle.promise;
    io.stdout.write(`${JSON.stringify(value === undefined ? null : value, null, 2)}\n`);
    return 0;
  } catch (e) {
    io.stderr.write(`maestro: replay ${handle.runId} failed: ${errorText(e)}\n`);
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
      '(nothing deleted; pass --delete to remove clean worktrees and merged branches, --force for dirty and unmerged)',
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
  const structuredMode = structuredModeFlag(p);
  const geminiApiKey = geminiKeyFromEnv(io.env);
  // stdout is the MCP channel: diagnostics go to stderr only.
  if (!dryRun && selectedRunner === 'anthropic' && !io.env.ANTHROPIC_API_KEY) {
    io.stderr.write('maestro mcp: ANTHROPIC_API_KEY is not set; Workflow runs will fail until it is.\n');
  }
  if (!dryRun && selectedRunner === 'gemini' && !geminiApiKey) {
    io.stderr.write(
      'maestro mcp: GEMINI_API_KEY (or GOOGLE_API_KEY) is missing or blank; Workflow runs will fail until it is set.\n',
    );
  }
  if (!dryRun && selectedRunner === 'gateway' && !io.env.AI_GATEWAY_API_KEY?.trim()) {
    io.stderr.write(
      'maestro mcp: AI_GATEWAY_API_KEY is missing or blank; Workflow runs will fail until it is set.\n',
    );
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
          : selectedRunner === 'gemini'
            ? new GeminiRunner({ apiKey: geminiApiKey ?? '', structuredMode })
            : selectedRunner === 'auto'
              ? new RoutingRunner({
                  anthropic: { structuredMode },
                  gemini: { apiKey: geminiApiKey ?? '', structuredMode },
                })
              : selectedRunner === 'gateway'
                ? new GatewayRunner({ apiKey: io.env.AI_GATEWAY_API_KEY ?? '', structuredMode })
                : new AnthropicRunner({ structuredMode }),
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
    // A client that dies while another process still holds the pipe's write end never sends EOF, and
    // the server would stay behind for good. Only for the real process: a test's main() has no client.
    if (io.handleSignals) {
      const stopWatching = watchParent(() => {
        io.stderr.write('maestro mcp: the client process is gone; shutting down.\n');
        close();
      });
      const done = server.onclose;
      server.onclose = () => {
        stopWatching();
        done?.();
      };
    }
  });
  return 0;
}

/**
 * Calls `onGone` once when this process's parent changes, i.e. the process that started it has exited and
 * it was re-parented. Does nothing when it already has no parent to lose (ppid 1 at the start, as under
 * a launcher that exits on purpose). The timer does not keep the process alive. Returns a stop function.
 */
export function watchParent(
  onGone: () => void,
  opts: { ppid?: () => number; intervalMs?: number } = {},
): () => void {
  const ppid = opts.ppid ?? (() => process.ppid);
  const parent = ppid();
  if (parent <= 1) return () => {};
  const timer = setInterval(() => {
    if (ppid() === parent) return;
    clearInterval(timer);
    onGone();
  }, opts.intervalMs ?? 5_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function runsCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 0) throw new UsageError(`unexpected arguments: ${p.positionals.join(' ')}`);
  const limitArg = str(p, 'limit');
  let limit: number | undefined;
  if (limitArg !== undefined) {
    limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(`--limit must be a positive integer, got "${limitArg}"`);
    }
  }
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const runsDir = path.join(stateDir, 'runs');
  if (!existsSync(runsDir)) {
    io.stdout.write(`(no runs in ${runsDir})\n`);
    return 0;
  }
  const dirEntries = await readdir(runsDir, { withFileTypes: true });
  const runIds = dirEntries.filter((d) => d.isDirectory() && SAFE_ID.test(d.name)).map((d) => d.name);
  if (runIds.length === 0) {
    io.stdout.write(`(no runs in ${runsDir})\n`);
    return 0;
  }

  interface RunSummaryRow {
    runId: string;
    startedAt: number;
    line: string;
  }

  // With --limit, order the runs by a cheap start hint first, so only the listed runs' event logs and
  // journals are read in full.
  let listed = runIds;
  if (limit !== undefined && runIds.length > limit) {
    const hints = await Promise.all(
      runIds.map(async (runId) => ({ runId, t: await runStartHint(path.join(runsDir, runId)) })),
    );
    hints.sort((a, b) => b.t - a.t || b.runId.localeCompare(a.runId));
    listed = hints.slice(0, limit).map((h) => h.runId);
  }

  const summaries: RunSummaryRow[] = await Promise.all(
    listed.map(async (runId): Promise<RunSummaryRow> => {
      const runDir = path.join(runsDir, runId);
      const [{ lines: events }, outcome, rows, st] = await Promise.all([
        readEventLines(runDir),
        readOutcome(runDir),
        readEntries(runDir).catch(() => [] as Entry[]),
        stat(runDir),
      ]);
      const firstStart = events.find(
        (e): e is Extract<typeof e, { type: 'run_start' }> => e.type === 'run_start',
      );
      let lastStartIdx = -1;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'run_start') {
          lastStartIdx = i;
          break;
        }
      }
      const lastStart =
        lastStartIdx >= 0
          ? (events[lastStartIdx] as Extract<(typeof events)[number], { type: 'run_start' }>)
          : undefined;
      let name = lastStart?.name ?? firstStart?.name;
      if (!name) {
        try {
          const src = await readFile(path.join(runDir, 'script.js'), 'utf8');
          name = parseScript(src).meta.name;
        } catch {
          // Best-effort name lookup.
        }
      }
      let endEvent: Extract<(typeof events)[number], { type: 'run_end' }> | undefined;
      for (let i = events.length - 1; i > lastStartIdx; i--) {
        const e = events[i];
        if (e?.type === 'run_end') {
          endEvent = e;
          break;
        }
      }
      const status: 'done' | 'failed' | 'running' =
        endEvent !== undefined
          ? endEvent.ok
            ? 'done'
            : 'failed'
          : lastStartIdx === -1 && outcome !== undefined
            ? outcome.ok
              ? 'done'
              : 'failed'
            : 'running';
      const startedAt = firstStart?.t ?? events[0]?.t ?? st.mtimeMs;
      const attemptStart = lastStart?.t ?? startedAt;
      const finishedAt = endEvent?.t;
      const dur =
        finishedAt !== undefined && finishedAt >= attemptStart
          ? formatRunDuration(finishedAt - attemptStart)
          : '-';

      const usage: Usage = { input_tokens: 0, output_tokens: 0 };
      let okCount = 0;
      let nullCount = 0;
      let skippedCount = 0;
      for (const r of rows) {
        addUsage(usage, r.usage);
        if (r.status === 'ok') okCount++;
        else if (r.status === 'null') nullCount++;
        else if (r.status === 'skipped') skippedCount++;
      }
      const counts: string[] = [];
      if (okCount > 0) counts.push(`${okCount} ok`);
      if (nullCount > 0) counts.push(`${nullCount} null`);
      if (skippedCount > 0) counts.push(`${skippedCount} skipped`);
      const agentSummary = rows.length === 0 ? '0 agents' : `${rows.length} agents (${counts.join(', ')})`;

      const ratio = cacheReadRatio(usage);
      const cached = ratio === null ? '' : ` (${Math.round(ratio * 100)}% cached)`;
      const n = (v: number) => v.toLocaleString('en-US');
      const line =
        `${runId}  [${status}]  ${name ?? '-'}  ${dur}  ${agentSummary}  ` +
        `${n(totalInput(usage))} in${cached}, ${n(usage.output_tokens)} out`;
      return { runId, startedAt, line };
    }),
  );

  summaries.sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
  const selected = limit !== undefined ? summaries.slice(0, limit) : summaries;
  for (const s of selected) io.stdout.write(`${s.line}\n`);
  return 0;
}

/**
 * When a run started, from the first line of its event log alone (the first run_start); the directory's
 * mtime when there is no readable first line. The same value runsCommand sorts by after a full read.
 */
async function runStartHint(runDir: string): Promise<number> {
  try {
    const fh = await open(path.join(runDir, EVENT_LOG_FILE), 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      const nl = head.indexOf('\n');
      if (nl !== -1) {
        const t = (JSON.parse(head.slice(0, nl)) as { t?: unknown }).t;
        if (typeof t === 'number') return t;
      }
    } finally {
      await fh.close();
    }
  } catch {
    // No event log, or a first line that is not JSON: fall through.
  }
  return (await stat(runDir)).mtimeMs;
}

function formatRunDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const sec = ms / 1_000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec - mins * 60);
  return `${mins}m${rem}s`;
}

async function showCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.flags.has('compact') || p.flags.has('json')) return inspectCommand(p, io);
  const [runId, label, ...extra] = p.positionals;
  if (runId === undefined) throw new UsageError('show needs a runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  if (!SAFE_ID.test(runId)) throw new UsageError(`invalid runId "${runId}"`);
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
  const live = new Map<number, LiveAgentStatus>();
  const { lines: recorded } = await readEventLines(runDir);
  for (const event of recorded) {
    if (event.type === 'run_start' || event.type === 'run_end') live.clear();
    else if (event.type === 'agent_status') live.set(event.agent.id, event.agent);
    else if (event.type === 'agent_end') live.delete(event.id);
  }
  const livePicked = [...live.values()].filter(
    (agent) => label === undefined || agent.label === label || String(agent.id) === label,
  );
  if (livePicked.length) {
    io.stdout.write('latest recorded activity (may be stale if the runner exited unexpectedly):\n');
    for (const agent of livePicked) io.stdout.write(`${formatLiveAgent(agent)}\n`);
  }
  if (label === undefined) {
    for (const row of rows) io.stdout.write(`${rowLine(row)}\n`);
    const outcome = await readOutcome(runDir);
    if (outcome) {
      if (outcome.ok) {
        const raw = JSON.stringify(outcome.result) ?? 'null';
        const preview = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
        io.stdout.write(`outcome: ok · ${preview}\n`);
      } else {
        io.stdout.write(`outcome: failed · ${outcome.error}\n`);
      }
    }
    return 0;
  }
  let picked = rows.filter((r) => r.label === label);
  if (picked.length === 0) picked = rows.filter((r) => r.key.startsWith(label));
  if (picked.length === 0) {
    if (livePicked.length) return 0;
    io.stderr.write(`maestro: no agent labelled "${label}" in run ${runId}\n`);
    return 1;
  }
  for (const row of picked) io.stdout.write(`${await showRow(runDir, row)}\n`);
  return 0;
}

async function inspectCommand(p: Parsed, io: CliIO): Promise<number> {
  const [runId, selector, ...extra] = p.positionals;
  if (runId === undefined) throw new UsageError('inspect needs a runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  if (!SAFE_ID.test(runId)) throw new UsageError(`invalid runId "${runId}"`);
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  const report = await inspectRun(runDir, runId, {
    compact: p.flags.has('compact'),
    ...(selector !== undefined ? { selector } : {}),
  });
  if (p.flags.has('json')) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(formatInspectMarkdown(report));
  }
  return 0;
}

async function evalCommand(p: Parsed, io: CliIO): Promise<number> {
  const sub = p.positionals[0];
  if (sub === 'diff') return evalDiffCommand(p, io);
  if (sub === 'ls' || sub === 'runs') return evalListCommand(p, io);
  return evalRunCommand(p, io);
}

async function evalRunCommand(p: Parsed, io: CliIO): Promise<number> {
  const [scriptArg, ...extra] = p.positionals;
  if (scriptArg === undefined) throw new UsageError('eval needs a workflow script (or subcommand: diff, ls)');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  const casesPath = str(p, 'cases');
  if (casesPath === undefined) throw new UsageError('eval requires --cases <file.json|jsonl>');

  const limitArg = str(p, 'limit');
  let limit: number | undefined;
  if (limitArg !== undefined) {
    limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(`--limit must be a positive integer, got "${limitArg}"`);
    }
  }
  const caseConcArg = str(p, 'case-concurrency');
  let caseConcurrency: number | undefined;
  if (caseConcArg !== undefined) {
    caseConcurrency = Number(caseConcArg);
    if (!Number.isInteger(caseConcurrency) || caseConcurrency < 1) {
      throw new UsageError(`--case-concurrency must be a positive integer, got "${caseConcArg}"`);
    }
  }

  const exec = await parseExecutionOptions(p, io);
  if (!exec) return 1;

  const onlyArg = str(p, 'only');
  const only = onlyArg
    ? onlyArg
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const graderArg = str(p, 'grader');
  const evalId = str(p, 'name');
  const fromEvalId = str(p, 'from-eval');
  const fromNode = str(p, 'from');

  const record = await runEval({
    scriptPath: path.resolve(io.cwd, scriptArg),
    casesPath: path.resolve(io.cwd, casesPath),
    ...(graderArg !== undefined ? { graderPath: path.resolve(io.cwd, graderArg) } : {}),
    ...(evalId !== undefined ? { evalId } : {}),
    ...(fromEvalId !== undefined ? { fromEvalId } : {}),
    ...(fromNode !== undefined ? { fromNode } : {}),
    ...(only !== undefined ? { only } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(caseConcurrency !== undefined ? { caseConcurrency } : {}),
    ...(exec.concurrency !== undefined ? { concurrency: exec.concurrency } : {}),
    ...(exec.model !== undefined ? { model: exec.model } : {}),
    ...(exec.stateDir !== undefined ? { stateDir: exec.stateDir } : {}),
    ...(exec.toolsDir !== undefined ? { toolsDir: exec.toolsDir } : {}),
    runner: exec.runner,
    cwd: exec.cwd,
    budget: exec.budget,
    onCaseComplete: (res, idx, total) => {
      const icon = res.status === 'pass' ? '✓' : res.status === 'fail' ? '✗' : '!';
      const hitTag = res.journalCacheHits > 0 ? ` [${res.journalCacheHits}/${res.agentCalls} CACHE HIT]` : '';
      io.stderr.write(`maestro eval: [${idx + 1}/${total}] ${icon} ${res.id} (${res.status})${hitTag}\n`);
    },
  });

  if (p.flags.has('json')) {
    io.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    io.stdout.write(formatEvalSummary(record));
  }
  return record.summary.passed === record.summary.total ? 0 : 1;
}

async function evalDiffCommand(p: Parsed, io: CliIO): Promise<number> {
  const [, runA, runB, ...extra] = p.positionals;
  if (runA === undefined || runB === undefined) {
    throw new UsageError('eval diff requires two run IDs: maestro eval diff <run-a> <run-b>');
  }
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const diff = await diffEvalRuns(stateDir, runA, runB);
  if (p.flags.has('json')) {
    io.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else {
    io.stdout.write(formatEvalDiff(diff));
  }
  if (p.flags.has('fail-on-regression') && diff.cases.regressions.length > 0) return 1;
  return 0;
}

async function evalListCommand(p: Parsed, io: CliIO): Promise<number> {
  if (p.positionals.length > 1) {
    throw new UsageError(`unexpected arguments: ${p.positionals.slice(1).join(' ')}`);
  }
  const limitArg = str(p, 'limit');
  let limit: number | undefined;
  if (limitArg !== undefined) {
    limit = Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(`--limit must be a positive integer, got "${limitArg}"`);
    }
  }
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const records = await listEvalRecords(stateDir, limit);
  if (p.flags.has('json')) {
    io.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    io.stdout.write(`(no evals in ${path.join(stateDir, 'evals')})\n`);
    return 0;
  }
  for (const r of records) {
    const s = r.summary;
    const pct = Math.round(s.passRate * 100);
    const hit =
      s.journalCacheHitRatio === null ? '' : ` · ${Math.round(s.journalCacheHitRatio * 100)}% [CACHE HIT]`;
    io.stdout.write(
      `${r.evalId}  ${s.passed}/${s.total} (${pct}%)  ${r.workflowName ?? '-'}  ${r.model}  ` +
        `${s.tokens.total.toLocaleString('en-US')} tok${hit}\n`,
    );
  }
  return 0;
}

async function vizCommand(p: Parsed, io: CliIO): Promise<number> {
  const [runId, ...extra] = p.positionals;
  if (runId === undefined) throw new UsageError('viz needs a runId');
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(' ')}`);
  if (!SAFE_ID.test(runId)) throw new UsageError(`invalid runId "${runId}"`);
  const cwd = path.resolve(io.cwd, str(p, 'cwd') ?? '.');
  const stateDirArg = str(p, 'state-dir');
  const stateDir = stateDirArg !== undefined ? path.resolve(io.cwd, stateDirArg) : path.join(cwd, '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  if (!existsSync(runDir)) {
    io.stderr.write(`maestro: no run ${runId} in ${path.dirname(runDir)}\n`);
    return 1;
  }
  const out = str(p, 'out');
  if (p.flags.has('widget')) {
    const fragment = await exportVizWidget(runDir, runId);
    if (out === undefined) io.stdout.write(fragment);
    else {
      const file = path.resolve(io.cwd, out);
      await writeFile(file, fragment);
      io.stdout.write(`${file}\n`);
    }
    return 0;
  }
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
  if (row.messages?.length) {
    lines.push('live messages (reused along with a cached result on resume):');
    for (const message of row.messages)
      lines.push(
        `  #${message.id} [${message.status}] ${message.text}${message.error ? ` (${message.error})` : ''}`,
      );
  }
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
      result = await readResultBlob(runDir, row.key);
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
