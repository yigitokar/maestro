// One fresh Codex CLI process per agent; JSONL events supply live usage and the journal trace.
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { childGitEnv } from './git-env.js';
import { toStructuredOutputSchema, validateValue } from './runner.js';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from './tools.js';
import {
  type AgentRunner,
  type EntryStatus,
  MaestroError,
  type RunRequest,
  type RunResult,
  type Trace,
  type Usage,
} from './types.js';
import { addUsage } from './usage.js';

export interface CodexRunnerOptions {
  bin?: string;
  /** Overrides the workflow model; otherwise Claude ids defer to the Codex config default. */
  model?: string;
  ignoreUserConfig?: boolean;
  /** Extra CLI arguments, inserted before the stdin prompt marker. */
  extraArgs?: string[];
  /** Time after SIGTERM before forcing termination with SIGKILL (default 1 second). */
  killGraceMs?: number;
}

const execFileAsync = promisify(execFile);
const BUILTIN_TOOLS = new Set<string>([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES]);
const TRACE_INPUT_CHARS = 200;
const TRACE_TEXT_CHARS = 2_000;
const STDERR_CHARS = 500;
const PIPE_CLOSE_GRACE_MS = 100;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Codex/Responses input includes cached input; reasoning is already part of output_tokens. */
function usageOf(value: unknown): Usage {
  const u = object(value);
  const usage: Usage = {
    input_tokens: Math.max(0, tokens(u?.input_tokens) - tokens(u?.cached_input_tokens)),
    output_tokens: tokens(u?.output_tokens),
  };
  if (typeof u?.cached_input_tokens === 'number')
    usage.cache_read_input_tokens = tokens(u.cached_input_tokens);
  if (typeof u?.cache_write_input_tokens === 'number')
    usage.cache_creation_input_tokens = tokens(u.cache_write_input_tokens);
  return usage;
}

/** Complete OpenAI's required-property rule locally, without changing Anthropic's schema behavior. */
function requireProperties(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) requireProperties(child);
    return;
  }
  const schema = object(value);
  if (!schema) return;
  for (const key of ['properties', '$defs', 'definitions']) {
    const children = object(schema[key]);
    if (children) for (const child of Object.values(children)) requireProperties(child);
  }
  for (const key of ['items', 'not']) requireProperties(schema[key]);
  for (const key of ['anyOf', 'allOf', 'prefixItems']) {
    const children = schema[key];
    if (Array.isArray(children)) for (const child of children) requireProperties(child);
  }
  const type = schema.type;
  if (
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined && 'properties' in schema)
  ) {
    schema.properties ??= {};
    schema.required = Object.keys(object(schema.properties) ?? {});
    schema.additionalProperties = false;
  }
}

class RunState {
  readonly usage: Usage = { input_tokens: 0, output_tokens: 0 };
  readonly trace: Trace = { toolCalls: [], finalText: '' };
  turns = 0;
  completed = false;
  finalText = '';
  error?: string;
  turnFailure?: string;

  constructor(private readonly req: RunRequest) {}

  line(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // CLI/plugin noise is not an event.
    }
    const event = object(parsed);
    if (!event) return;
    if (event.type === 'turn.completed') {
      this.completed = true;
      this.turnFailure = undefined;
      const usage = usageOf(event.usage);
      this.turns++;
      addUsage(this.usage, usage);
      this.req.onUsage(usage); // Immediately, even if this callback aborts the run.
    } else if (event.type === 'item.completed') {
      const item = object(event.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        this.finalText = item.text;
        this.trace.finalText = item.text.slice(0, TRACE_TEXT_CHARS);
      } else if (item?.type === 'command_execution') {
        this.trace.toolCalls.push({
          tool: 'shell',
          inputSummary: String(item.command ?? '').slice(0, TRACE_INPUT_CHARS),
          ok: item.exit_code === 0,
        });
      }
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const message = object(event.error)?.message ?? event.message ?? event.error;
      const error = typeof message === 'string' ? message : String(event.type);
      if (event.type === 'error') this.error = error;
      else {
        this.completed = false;
        this.turnFailure = error;
      }
    }
  }

  done(result: unknown, status: EntryStatus, extra: { error?: string; raw?: string } = {}): RunResult {
    return { result, status, usage: this.usage, turns: this.turns, trace: this.trace, ...extra };
  }
}

export class CodexRunner implements AgentRunner {
  constructor(private readonly opts: CodexRunnerOptions = {}) {}

  async run(req: RunRequest): Promise<RunResult> {
    const writers = req.tools.filter((t) => t.write).map((t) => t.name);
    if (writers.length > 0 && !req.isolated) {
      throw new MaestroError(
        `write tools (${writers.join(', ')}) require isolation: 'worktree'`,
        'write_tool_without_isolation',
      );
    }
    const st = new RunState(req);
    if (req.signal.aborted) return st.done(null, 'skipped', { error: 'aborted' });
    let tempDir: string | undefined;
    try {
      const custom = [...new Set(req.tools.map((t) => t.name).filter((name) => !BUILTIN_TOOLS.has(name)))];
      if (custom.length > 0)
        req.log(`Codex cannot use custom tools (${custom.join(', ')}); it uses its own shell tools instead.`);

      tempDir = await mkdtemp(path.join(os.tmpdir(), 'maestro-codex-'));
      const outputPath = path.join(tempDir, 'last.txt');
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--skip-git-repo-check',
        '-C',
        req.cwd,
        '-s',
        req.isolated ? 'workspace-write' : 'read-only',
      ];
      const env = childGitEnv();
      if (this.opts.ignoreUserConfig) args.push('--ignore-user-config');
      const model = this.opts.model ?? (req.model.startsWith('claude-') ? undefined : req.model);
      if (model !== undefined) args.push('-m', model);
      if (req.effort) {
        const effort = req.effort === 'max' ? 'xhigh' : req.effort;
        args.push('-c', `model_reasoning_effort="${effort}"`);
      }
      if (req.schema) {
        const schema = toStructuredOutputSchema(req.schema);
        requireProperties(schema);
        const schemaPath = path.join(tempDir, 'schema.json');
        await writeFile(schemaPath, JSON.stringify(schema));
        args.push('--output-schema', schemaPath);
      }
      let prompt = `System instructions:\n${req.system}\n\nTask:\n${req.prompt}`;
      if (req.isolated)
        prompt +=
          '\n\nDo not run git commit or git_commit: the Codex sandbox makes .git read-only. ' +
          'Leave your changes in the working tree; Maestro commits them when you finish successfully.';
      args.push('-o', outputPath, ...(this.opts.extraArgs ?? []), '-');
      req.signal.throwIfAborted();
      const exit = await this.execute(args, prompt, req, st, env);
      if (req.signal.aborted) return st.done(null, 'skipped', { error: 'aborted' });

      const fileText = await readFile(outputPath, 'utf8').catch(() => '');
      if (req.signal.aborted) return st.done(null, 'skipped', { error: 'aborted' });
      const text = fileText.trim() ? fileText : st.finalText;
      const processError =
        st.error ??
        st.turnFailure ??
        (exit.code !== 0
          ? `codex exec failed (${exit.signal ?? exit.code}): ${exit.stderr.trim() || 'no error details'}`
          : !st.completed
            ? 'codex exec returned no turn.completed event'
            : undefined);
      if (processError !== undefined)
        return st.done(null, 'null', { error: processError, ...(text ? { raw: text } : {}) });

      let result: unknown = text;
      if (req.schema) {
        try {
          const value: unknown = JSON.parse(text);
          const errors = validateValue(req.schema, value);
          if (errors.length > 0) throw new Error(errors.join('; '));
          result = value;
        } catch (error) {
          return st.done(null, 'null', {
            raw: text,
            error: `schema parse failed: ${error instanceof Error ? error.message : error}`,
          });
        }
      } else if (!text.trim()) {
        return st.done(null, 'null', { error: 'codex exec returned no final text' });
      }

      req.signal.throwIfAborted();
      if (req.isolated) {
        try {
          const gitOptions = { cwd: req.cwd, env, signal: req.signal, encoding: 'utf8' as const };
          const { stdout } = await execFileAsync('git', ['status', '--porcelain'], gitOptions);
          if (stdout.trim()) {
            await execFileAsync('git', ['add', '-A'], gitOptions);
            const firstLine = req.prompt.split(/\r?\n/, 1)[0]!.trim();
            const message = `maestro(codex): ${firstLine}`.slice(0, 72).trimEnd();
            await execFileAsync('git', ['commit', '-m', message], gitOptions);
          }
        } catch (error) {
          req.signal.throwIfAborted();
          const stderr = object(error)?.stderr;
          const detail =
            (typeof stderr === 'string' ? stderr.trim() : '') ||
            (error instanceof Error ? error.message : String(error));
          return st.done(null, 'null', { raw: text, error: `runner-side commit failed: ${detail}` });
        }
      }
      req.signal.throwIfAborted();
      return st.done(result, 'ok');
    } catch (error) {
      if (req.signal.aborted) return st.done(null, 'skipped', { error: 'aborted' });
      return st.done(null, 'null', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  private execute(args: string[], prompt: string, req: RunRequest, st: RunState, env: NodeJS.ProcessEnv) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(this.opts.bin ?? 'codex', args, {
          cwd: req.cwd,
          env,
          detached: true, // A process group lets cancellation reach shell/tool descendants too.
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        let stderr = '';
        let failure: unknown;
        let settled = false;
        let stopping = false;
        let killed = false;
        let pipesExpired = false;
        let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        let closed = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let pipeTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearTimeout(pipeTimer);
          req.signal.removeEventListener('abort', stop);
          lines.close();
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          if (failure) reject(failure);
          else resolve({ code, signal, stderr });
        };
        const signalGroup = (signal: NodeJS.Signals) => {
          if (child.pid === undefined) return;
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (object(error)?.code !== 'ESRCH') failure ??= error;
          }
        };
        const stop = () => {
          if (stopping || settled) return;
          stopping = true;
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => {
            // The leader may have exited already; its descendants can still own the pipes.
            signalGroup('SIGKILL');
            killed = true;
            if (closed && exit) finish(exit.code, exit.signal);
            else {
              pipeTimer = setTimeout(() => {
                pipesExpired = true;
                lines.close();
                child.stdin.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                if (exit) finish(exit.code, exit.signal);
              }, PIPE_CLOSE_GRACE_MS);
            }
          }, this.opts.killGraceMs ?? 1_000);
        };
        lines.on('line', (line) => {
          try {
            st.line(line);
          } catch (error) {
            failure = error;
            stop();
          }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          stderr = (stderr + chunk).slice(-STDERR_CHARS);
        });
        child.on('error', (error) => {
          failure = error;
        });
        child.on('exit', (code, signal) => {
          exit = { code, signal };
          if (pipesExpired) finish(code, signal);
        });
        child.on('close', (code, signal) => {
          closed = true;
          exit = { code, signal };
          // Complete group escalation even if the leader and its pipes closed on SIGTERM.
          if (!stopping || killed) finish(code, signal);
        });
        child.stdin.on('error', (error: NodeJS.ErrnoException) => {
          // Codex may exit before consuming the prompt; its exit/events decide success.
          if (error.code === 'EPIPE') return;
          failure = error;
          stop();
        });
        req.signal.addEventListener('abort', stop, { once: true });
        if (req.signal.aborted) stop();
        // Avoid argv size limits, then send EOF so codex exec cannot wait for more input.
        child.stdin.end(prompt);
      },
    );
  }
}
