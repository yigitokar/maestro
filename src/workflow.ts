// Workflow tool surface (spec Seviye 2 "Tool yüzeyi", data flow steps 1-7, 3.4 nested workflow).
// run() returns a handle immediately; the script runs against one shared journal, scheduler, budget and
// isolation per run. Agent-level failures become null rows, script-level failures reject (null/throw table).

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Budget, type BudgetLease } from './budget.js';
import { Isolation, type WorktreeLease } from './isolation.js';
import { hashCall, Journal, makeKey, Occurrences } from './journal.js';
import { AnthropicRunner, systemPrompt } from './runner.js';
import { type HostHooks, type ParsedScript, parseScript, runScript } from './runtime.js';
import { defaultConcurrency, Scheduler } from './scheduler.js';
import { buildTools } from './tools.js';
import type {
  AgentOpts,
  AgentRunner,
  Entry,
  EntryStatus,
  RunResult,
  ToolDef,
  Usage,
  WorkflowEvent,
  WorkflowMeta,
} from './types.js';
import { DEFAULT_MODEL, MaestroError } from './types.js';

export interface RunOptions {
  /** Exactly one of script | scriptPath | name; a resume may omit all three and reuse the stored script.js. */
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  /** Default: new AnthropicRunner(). */
  runner?: AgentRunner;
  /** Agents' working dir / git repo. Default process.cwd(). */
  cwd?: string;
  /** Default <cwd>/.maestro. */
  stateDir?: string;
  /** Registry for `name` and workflow('<name>'). Default <stateDir>/workflows (<name>.js). */
  workflowsDir?: string;
  /** A shared Budget, a total in output tokens, or null/undefined for unbounded. */
  budget?: Budget | number | null;
  /** Semaphore size. Default defaultConcurrency(). */
  concurrency?: number;
  /** The "main session model" agents inherit. Default DEFAULT_MODEL. */
  model?: string;
  /** Default: generated, filesystem/branch safe (e.g. 20261025-150301-a1b2c3). */
  runId?: string;
  isolation?: { symlinkNodeModules?: boolean; worktreeRoot?: string };
}

export interface RunHandle {
  runId: string;
  /** <stateDir>/runs/<runId>/ holding script.js, args.json, journal.jsonl, blobs/. */
  runDir: string;
  /** The script's return value; rejects on setup error, script throw or stop(). */
  promise: Promise<unknown>;
  /** Emits 'event' (WorkflowEvent) and each event under its own type name. */
  events: EventEmitter;
  /** Aborts every live agent (journaled as skipped), then the promise rejects with 'run_stopped'. */
  stop(reason?: string): void;
  /** Skips one live agent (spec Seviye 1 "kullanıcı ajanı canlı atlar"): agent() → null, row 'skipped'. */
  skip(agentId: number): boolean;
}

/** One script execution: the top run (depth 0) or a nested workflow() child (depth 1, "▸ name" group). */
interface Frame {
  depth: 0 | 1;
  meta: WorkflowMeta;
  group?: string;
  /** Last phase() title: the default phase of this frame's agents. */
  phase?: string;
}

interface LiveAgent {
  frame: Frame;
  prompt: string;
  opts: AgentOpts;
  tools: ToolDef[];
  hash: string;
  n: number;
  key: string;
  id: number;
  lease: BudgetLease;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function run(opts: RunOptions): RunHandle {
  const runId = opts.resumeFromRunId ?? opts.runId ?? generateRunId();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const stateDir = path.resolve(cwd, opts.stateDir ?? '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  const workflowsDir = path.resolve(cwd, opts.workflowsDir ?? path.join(stateDir, 'workflows'));
  const events = new EventEmitter();
  events.setMaxListeners(0);

  let stopped = false;
  let stopReason: string | undefined;
  let finished = false;
  /** First journal append failure: the run fails with it (spec 3.1, a half-recorded run is unacceptable). */
  let fatal: unknown;
  /** Aborted by stop() and when the script settles with agents still in flight. */
  const runController = new AbortController();
  const inflight = new Set<Promise<unknown>>();
  const skipControllers = new Map<number, AbortController>();
  let nextId = 0;

  let journal: Journal | undefined;
  let budget: Budget | undefined;
  let scheduler: Scheduler | undefined;
  let isolation: Isolation | undefined;
  const occurrences = new Occurrences();
  let runner: AgentRunner | undefined;
  const model = opts.model ?? DEFAULT_MODEL;

  const emit = (ev: WorkflowEvent): void => {
    try {
      events.emit('event', ev);
      events.emit(ev.type, ev);
    } catch {
      // A throwing listener must not break the run.
    }
  };
  const emitLog = (message: string, group?: string): void =>
    emit(withDefined({ type: 'log', runId, message, group }));
  const stopError = () =>
    new MaestroError(`run ${runId} stopped${stopReason ? `: ${stopReason}` : ''}`, 'run_stopped');

  /** Waits until every in-flight agent call has appended its row (also calls started meanwhile). */
  async function drain(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  // ---------------------------------------------------------------------------------------------------
  // agent(): data flow steps 1-7

  function agentHook(frame: Frame, prompt: string, agentOpts?: AgentOpts): Promise<unknown> {
    // Steps 1-4 are synchronous on purpose: 16 simultaneous calls must all see each other's budget
    // reservation (spec 3.5), and n must follow script call order, not timing (spec 3.1).
    if (fatal !== undefined) throw fatal;
    if (stopped || finished)
      throw stopped ? stopError() : new MaestroError('run has finished', 'run_stopped');
    // Snapshot the opts: the agent behind key hash(p, o) runs with exactly that o, even if the script
    // mutates or reuses its opts object after the call (spec 3.1, no silent wrong cache).
    const o = snapshotOpts(agentOpts);
    if (o.isolation !== undefined && o.isolation !== 'worktree') {
      throw new TypeError(`agent(): opts.isolation must be 'worktree', got ${JSON.stringify(o.isolation)}`);
    }
    const tools = buildTools(o.tools, o.isolation === 'worktree');
    const writer = tools.some((t) => t.write);
    const hash = hashCall(prompt, o);
    const n = occurrences.next(hash);
    const key = makeKey(hash, n);

    const hit = journal!.get(key);
    if (hit) {
      // Step 2: cache hit. No cap, no budget, no worktree, no slot. A cached writer still owns its
      // branch (its hand-off, spec 3.6): a live same-label sibling must not -B reset it.
      if (writer) getIsolation().claim({ key, label: o.label, hash, n, writer });
      const id = nextId++;
      const base = eventBase(frame, id, key, o);
      emit({ type: 'agent_start', ...base });
      emit({ type: 'agent_end', ...base, status: 'ok', cached: true, usage: hit.usage });
      return Promise.resolve(copyValue(hit.result));
    }

    // Step 3: lifetime cap, then the entry reservation; both throw into the script. The cap is checked
    // first (J-23) but only consumed once the budget admits the call: a refused call is not an agent.
    if (scheduler!.admitted() >= scheduler!.maxAgents) scheduler!.admit(); // throws agent_cap
    const lease = budget!.enter();
    scheduler!.admit();
    const id = nextId++;
    const p = liveAgent({ frame, prompt, opts: o, tools, hash, n, key, id, lease });
    inflight.add(p);
    const forget = () => inflight.delete(p);
    p.then(forget, forget);
    return p;
  }

  async function liveAgent(a: LiveAgent): Promise<unknown> {
    const { frame, opts: o, lease, id, key } = a;
    const writer = a.tools.some((t) => t.write);
    const isolated = o.isolation === 'worktree';
    const skipController = new AbortController();
    skipControllers.set(id, skipController);
    const signal = AbortSignal.any([lease.signal, runController.signal, skipController.signal]);
    const base = eventBase(frame, id, key, o);
    emit({ type: 'agent_start', ...base });

    const abortText = (): string =>
      lease.signal.aborted
        ? 'budget exceeded while running'
        : skipController.signal.aborted
          ? 'skipped by user'
          : fatal !== undefined
            ? `run failed: ${errorText(fatal)}`
            : stopped
              ? `run stopped${stopReason ? `: ${stopReason}` : ''}`
              : 'run finished';

    const turnUsage: Usage = { input_tokens: 0, output_tokens: 0 };
    let res: RunResult | undefined;
    let status: EntryStatus = 'null';
    let result: unknown = null;
    let error: string | undefined;
    let raw: string | undefined;
    let worktree: Entry['worktree'];
    let wt: WorktreeLease | undefined;
    try {
      // Step 4: worktree under the isolation mutex; no slot is held meanwhile (spec 3.4).
      if (isolated && !signal.aborted) {
        try {
          wt = await getIsolation().open({ key, label: o.label, hash: a.hash, n: a.n, writer });
        } catch (e) {
          lease.release(false);
          skipControllers.delete(id);
          emit({ type: 'agent_end', ...base, status: 'null', cached: false, usage: turnUsage });
          throw e;
        }
      }
      const agentCwd = wt?.path ?? cwd;
      if (signal.aborted) {
        status = 'skipped';
        error = abortText();
      } else {
        try {
          // Step 5-6: the slot covers only the live runner call.
          res = await scheduler!.withSlot(
            () =>
              getRunner().run({
                prompt: a.prompt,
                system: systemPrompt({ cwd: agentCwd, writer }),
                tools: a.tools,
                schema: o.schema,
                model: o.model ?? model,
                effort: o.effort,
                cwd: agentCwd,
                signal,
                isolated,
                onUsage: (u) => {
                  turnUsage.input_tokens += finite(u.input_tokens);
                  turnUsage.output_tokens += finite(u.output_tokens);
                  lease.report(finite(u.output_tokens));
                },
                log: (m) => emitLog(m, frame.group),
              }),
            signal,
          );
          status = res.status;
          result = res.status === 'ok' ? (res.result ?? null) : null;
          if (res.raw !== undefined) raw = res.raw;
          if (res.error !== undefined) error = res.error;
          if (status === 'skipped' && signal.aborted) error = abortText();
        } catch (e) {
          if (signal.aborted) {
            // Aborted while queued for a slot (or the runner surfaced the abort as a throw).
            status = 'skipped';
            error = abortText();
          } else {
            // Agent-level failure → null (null/throw table).
            status = 'null';
            error = errorText(e);
            emitLog(`agent ${o.label ?? key} failed: ${error}`, frame.group);
          }
        }
      }
    } finally {
      if (wt) {
        const close = await wt.close(status === 'ok');
        if (writer && status === 'ok') {
          // spec 3.6: the hand-off is the branch, verified from git; the agent never names it.
          if (close.branchName) {
            const branchName = close.branchName;
            result = isPlainObject(result) ? { ...result, branchName } : { result, branchName };
          } else {
            status = 'null';
            result = null;
            error = close.noHandoffReason ?? 'no handoff';
          }
        }
        if (close.dirty) worktree = close.dirty;
      }
      lease.release(status === 'ok');
      skipControllers.delete(id);
    }

    const usage = res?.usage ?? turnUsage;
    const entry: Entry = withDefined({
      index: id,
      hash: a.hash,
      n: a.n,
      key,
      label: o.label,
      phase: o.phase ?? frame.phase,
      result: status === 'ok' ? (result ?? null) : null,
      usage,
      status,
      raw,
      error,
      worktree,
    });
    // Step 7: write first, return second; otherwise an interruption re-runs the agent.
    try {
      await journal!.append(entry);
    } catch (e) {
      // Not an agent-level failure: the run fails loudly instead of continuing half-recorded.
      emitLog(`agent ${o.label ?? key} not journaled, the run fails: ${errorText(e)}`, frame.group);
      emit({ type: 'agent_end', ...base, status: 'null', cached: false, usage });
      if (fatal === undefined) {
        fatal = e;
        if (!runController.signal.aborted) runController.abort(e);
      }
      throw e;
    }
    emit({ type: 'agent_end', ...base, status, cached: false, usage });
    if (stopped) throw stopError();
    return status === 'ok' ? copyValue(entry.result) : null;
  }

  function eventBase(frame: Frame, id: number, key: string, o: AgentOpts) {
    return withDefined({ runId, id, key, label: o.label, phase: o.phase ?? frame.phase, group: frame.group });
  }

  function getRunner(): AgentRunner {
    runner ??= opts.runner ?? new AnthropicRunner();
    return runner;
  }

  function getIsolation(): Isolation {
    isolation ??= new Isolation({
      repoDir: cwd,
      runId,
      worktreeRoot: opts.isolation?.worktreeRoot,
      symlinkNodeModules: opts.isolation?.symlinkNodeModules,
      log: (m) => emitLog(m),
    });
    return isolation;
  }

  // ---------------------------------------------------------------------------------------------------
  // Host hooks per frame

  function hooksFor(frame: Frame): HostHooks {
    return {
      agent: (prompt, agentOpts) => agentHook(frame, prompt, agentOpts),
      log: (message) => emitLog(message, frame.group),
      onPhase: (title) => {
        frame.phase = title;
        emit(withDefined({ type: 'phase', runId, title, group: frame.group }));
      },
      workflow: (ref, wfArgs) => workflowHook(frame, ref, wfArgs),
      budget: budget!.view(),
      checkItems: (count, where) => scheduler!.checkItems(count, where),
      // spec Seviye 1: the script hears how many items dropped; Seviye 4 "No silent caps".
      onSwallowed: (where, index, err) =>
        emitLog(
          `${where} ${where === 'parallel' ? 'slot' : 'item'} ${index} null: ${errorText(err)}`,
          frame.group,
        ),
    };
  }

  /** spec 3.4: one nesting level; the child shares journal, counter, scheduler, budget, abort and events. */
  async function workflowHook(frame: Frame, ref: string | { scriptPath: string }, wfArgs: unknown) {
    if (frame.depth >= 1) {
      throw new MaestroError(
        'nested_workflow: workflow() may only be called from the top-level script',
        'nested_workflow',
      );
    }
    if (stopped) throw stopError();
    const { source, file } = await resolveRef(ref);
    const parsed = parseScript(source);
    if (parsed.meta.maxAgents !== undefined) {
      emitLog(
        `workflow ${parsed.meta.name}: meta.maxAgents ${parsed.meta.maxAgents} ignored; ` +
          `the run's shared cap of ${scheduler!.maxAgents} applies`,
        parsed.meta.name,
      );
    }
    const child: Frame = { depth: 1, meta: parsed.meta, group: parsed.meta.name };
    return runScript(parsed, wfArgs, hooksFor(child), { filename: file });
  }

  async function resolveRef(ref: unknown): Promise<{ source: string; file: string }> {
    let file: string;
    if (typeof ref === 'string') {
      if (!SAFE_ID.test(ref)) throw new Error(`workflow(): invalid workflow name "${ref}"`);
      file = path.join(workflowsDir, `${ref}.js`);
    } else if (ref !== null && typeof ref === 'object' && typeof (ref as any).scriptPath === 'string') {
      file = path.resolve(cwd, (ref as { scriptPath: string }).scriptPath);
    } else {
      throw new TypeError('workflow(ref): ref must be a workflow name or { scriptPath }');
    }
    try {
      return { source: await readFile(file, 'utf8'), file };
    } catch (e) {
      const what =
        typeof ref === 'string' ? `unknown workflow "${ref}" (looked for ${file})` : `cannot read ${file}`;
      throw new Error(`workflow(): ${what}: ${errorText(e)}`);
    }
  }

  // ---------------------------------------------------------------------------------------------------
  // Setup, execution, teardown

  async function main(): Promise<unknown> {
    // Let the caller attach listeners before the first event.
    await Promise.resolve();
    if (!SAFE_ID.test(runId)) throw new Error(`invalid runId "${runId}"`);
    if (
      opts.resumeFromRunId !== undefined &&
      opts.runId !== undefined &&
      opts.runId !== opts.resumeFromRunId
    ) {
      throw new Error(`runId ${opts.runId} conflicts with resumeFromRunId ${opts.resumeFromRunId}`);
    }
    const resume = opts.resumeFromRunId !== undefined;
    const given = [opts.script, opts.scriptPath, opts.name].filter((v) => v !== undefined).length;
    if (given > 1) throw new Error('pass exactly one of script, scriptPath or name');
    if (given === 0 && !resume) throw new Error('pass one of script, scriptPath or name');
    if (resume && !existsSync(runDir)) throw new Error(`no run ${runId} under ${path.dirname(runDir)}`);
    if (!resume && existsSync(runDir)) {
      throw new Error(`run ${runId} already exists at ${runDir}; pass resumeFromRunId to resume it`);
    }

    // Resolve and parse before touching the run dir: a broken script never replaces a good script.js.
    const scriptFile = path.join(runDir, 'script.js');
    const argsFile = path.join(runDir, 'args.json');
    let source: string;
    if (opts.script !== undefined) source = opts.script;
    else if (opts.scriptPath !== undefined)
      source = await readFile(path.resolve(cwd, opts.scriptPath), 'utf8');
    else if (opts.name !== undefined) source = (await resolveRef(opts.name)).source;
    else source = await readFile(scriptFile, 'utf8');
    const parsed: ParsedScript = parseScript(source);

    let args: unknown = opts.args;
    if (args === undefined && resume && existsSync(argsFile))
      args = JSON.parse(await readFile(argsFile, 'utf8'));
    args = normalizeArgs(args);

    // spec 3.1: if the journal cannot be written the run does not start.
    journal = await Journal.open(runDir, { log: (m) => emitLog(m) });
    try {
      await writeFile(scriptFile, source);
      await writeFile(argsFile, `${JSON.stringify(args)}\n`);

      scheduler = new Scheduler({
        concurrency: opts.concurrency ?? defaultConcurrency(),
        maxAgents: parsed.meta.maxAgents,
      });
      budget =
        opts.budget instanceof Budget
          ? opts.budget
          : new Budget({ total: opts.budget ?? null, concurrency: scheduler.concurrency });
      const offTick = budget.onTick((t) => emit({ type: 'budget_tick', runId, ...t }));
      try {
        if (budget.total !== null) {
          // spec 3.5 aşım payı: the accepted overrun ceiling is written to the log.
          emitLog(`budget: total ${budget.total}, overrun ceiling ${budget.overrunCeiling()}`);
        }
        if (stopped) throw stopError();
        const top: Frame = { depth: 0, meta: parsed.meta };
        try {
          return await runScript(parsed, args, hooksFor(top), { filename: scriptFile });
        } finally {
          finished = true;
          // Agents the script left behind are aborted and journaled before the run settles.
          if (inflight.size > 0 && !runController.signal.aborted) runController.abort();
          await drain();
          // Thrown after the script settles, so it also wins when parallel() swallowed it into a null slot.
          // biome-ignore lint/correctness/noUnsafeFinally: the journal failure overrides the script outcome.
          if (fatal !== undefined) throw fatal;
        }
      } finally {
        offTick();
      }
    } finally {
      await journal.close();
    }
  }

  let settle!: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  let settled = false;
  const promise = new Promise<unknown>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const finish = (ok: boolean, v: unknown) => {
    if (settled) return;
    settled = true;
    if (ok) settle.resolve(v);
    else settle.reject(v);
  };
  promise.catch(() => {});

  main().then(
    (v) => {
      if (!stopped) finish(true, v);
    },
    (e) => {
      if (!stopped) finish(false, e);
    },
  );

  return {
    runId,
    runDir,
    promise,
    events,
    stop(reason?: string) {
      if (stopped || settled) return;
      stopped = true;
      stopReason = reason;
      runController.abort(stopError());
      // spec null/throw table: the script rejects, the journal stays (every aborted agent has its row).
      void drain().then(() => finish(false, stopError()));
    },
    skip(agentId: number): boolean {
      const c = skipControllers.get(agentId);
      if (!c || c.signal.aborted) return false;
      c.abort(new Error('skipped by user'));
      return true;
    },
  };
}

// -----------------------------------------------------------------------------------------------------
// helpers

function generateRunId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(3).toString('hex')}`
  );
}

/** args are JSON (a tool-call parameter); undefined becomes null so a resume sees the same value. */
function normalizeArgs(args: unknown): unknown {
  return args === undefined ? null : JSON.parse(JSON.stringify(args));
}

/** A host-realm deep copy of agent opts; same drop-undefined semantics as canonicalJSON. */
function snapshotOpts(o: AgentOpts | undefined): AgentOpts {
  if (o === undefined || o === null) return {};
  const json = JSON.stringify(o);
  return json === undefined ? {} : (JSON.parse(json) as AgentOpts);
}

/** A fresh copy of a result, identical to what a resume reads back from the journal. */
function copyValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  const json = JSON.stringify(v);
  return json === undefined ? null : JSON.parse(json);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

function errorText(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : String(e);
}

/** Drops undefined properties so events and rows carry only the fields that apply. */
function withDefined<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
