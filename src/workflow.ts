// Workflow tool surface (spec Seviye 2 "Tool yüzeyi", data flow steps 1-7, 3.4 nested workflow).
// run() returns a handle immediately; the script runs against one shared journal, scheduler, budget and
// isolation per run. Agent-level failures become null rows, script-level failures reject (null/throw table).

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProxy } from 'node:util/types';
import { AgentControl } from './agent-control.js';
import { Budget, type BudgetLease } from './budget.js';
import { EMPTY_TOOL_REGISTRY, loadCustomTools, type ToolRegistry } from './custom-tools.js';
import { EVENT_LOG_PROMPT_CHARS, EventLog } from './event-log.js';
import { Isolation, type WorktreeLease } from './isolation.js';
import { hashCall, Journal, makeKey, Occurrences } from './journal.js';
import { snapshotJson } from './pipeline-input.js';
import { loadReplay, materializeReplayEntry, type ReplayFrom } from './replay.js';
import { AnthropicRunner, systemPrompt } from './runner.js';
import {
  currentPipelineInput,
  type HostHooks,
  KNOWN_META_KEYS,
  type ParsedScript,
  parseScript,
  runScript,
  unknownMetaKeys,
} from './runtime.js';
import { defaultConcurrency, Scheduler } from './scheduler.js';
import { buildTools } from './tools.js';
import type {
  AgentMessageReceipt,
  AgentOpts,
  AgentRunner,
  Entry,
  EntryStatus,
  LiveAgentStatus,
  RunResult,
  ToolDef,
  Usage,
  WorkflowEvent,
  WorkflowMeta,
} from './types.js';
import { DEFAULT_MODEL, MaestroError } from './types.js';
import { addUsage, cacheReadRatio, hasCacheInfo, totalInput } from './usage.js';

export interface RunOptions {
  /** Exactly one of script | scriptPath | name; a resume may omit all three and reuse the stored script.js. */
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
  /** Fork a fresh run. Reuse successful upstream calls, then run the selected node and suffix live. */
  replayFrom?: ReplayFrom;
  /** Default: new AnthropicRunner(). */
  runner?: AgentRunner;
  /** Agents' working dir / git repo. Default process.cwd(). */
  cwd?: string;
  /** Default <cwd>/.maestro. */
  stateDir?: string;
  /** Registry for `name` and workflow('<name>'). Default <stateDir>/workflows (<name>.js). */
  workflowsDir?: string;
  /** Custom tools a script may name in agent opts.tools, next to the built-ins and toolsDir's. */
  tools?: ToolDef[];
  /** Custom tool files (*.js, each default-exporting a ToolDef or an array). Default <stateDir>/tools. */
  toolsDir?: string;
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
  /** <stateDir>/runs/<runId>/ holding script.js, args.json, run.json, journal.jsonl, events.jsonl, blobs/. */
  runDir: string;
  /** The script's return value; rejects on setup error, script throw or stop(). */
  promise: Promise<unknown>;
  /** Emits 'event' (WorkflowEvent) and each event under its own type name. */
  events: EventEmitter;
  /** Aborts every live agent (journaled as skipped), then the promise rejects with 'run_stopped'. */
  stop(reason?: string): void;
  /** Skips one live agent (spec Seviye 1 "kullanıcı ajanı canlı atlar"): agent() → null, row 'skipped'. */
  skip(agentId: number): boolean;
  /** Current agent snapshots, including queued agents and bounded public activity. */
  liveAgents(): LiveAgentStatus[];
  /** Queue steering for a runner that accepts it; null for unknown, settled or unsupported agents. */
  sendMessage(agentId: number, message: string): AgentMessageReceipt | null;
}

/** One script execution: the top run (depth 0) or a nested workflow() child (depth 1, "▸ name" group). */
interface Frame {
  depth: 0 | 1;
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

/** A runId or workflow name: one path component, never a path. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Persisted outcome file inside `<runDir>/outcome.json`, readable across MCP sessions and CLI commands. */
export const OUTCOME_FILE = 'outcome.json';

export type PersistedOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Reads `<runDir>/outcome.json` when a settled run persisted its final outcome; undefined otherwise. */
export async function readOutcome(runDir: string): Promise<PersistedOutcome | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(runDir, OUTCOME_FILE), 'utf8'));
    if (!isPlainObject(raw) || typeof raw.ok !== 'boolean') return undefined;
    if (raw.ok) return { ok: true, result: 'result' in raw ? raw.result : null };
    if (typeof raw.error === 'string') return { ok: false, error: raw.error };
    return undefined;
  } catch {
    return undefined;
  }
}

export function run(opts: RunOptions): RunHandle {
  const runId = opts.resumeFromRunId ?? opts.runId ?? generateRunId();
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const stateDir = path.resolve(cwd, opts.stateDir ?? '.maestro');
  const runDir = path.join(stateDir, 'runs', runId);
  const workflowsDir = path.resolve(cwd, opts.workflowsDir ?? path.join(stateDir, 'workflows'));
  const toolsDir = path.resolve(cwd, opts.toolsDir ?? path.join(stateDir, 'tools'));
  const events = new EventEmitter();
  events.setMaxListeners(0);

  let stopped = false;
  let stopReason: string | undefined;
  let finished = false;
  /** A journal or replay invariant failure rejects the run even if the script catches it. */
  let fatal: unknown;
  /** Aborted by stop() and when the script settles with agents still in flight. */
  const runController = new AbortController();
  const inflight = new Set<Promise<unknown>>();
  const skipControllers = new Map<number, AbortController>();
  const controls = new Map<number, AgentControl>();
  let nextId = 0;
  let nextRejectedId = 0;
  /** Usage of every live model turn of this run (journal hits excluded), for the run-end cache line. */
  const liveUsage: Usage = { input_tokens: 0, output_tokens: 0 };

  let journal: Journal | undefined;
  const replayDir = opts.replayFrom && path.join(stateDir, 'runs', opts.replayFrom.runId);
  let replay: Awaited<ReturnType<typeof loadReplay>> | undefined;
  let replayPrefixSettled: Promise<void> | undefined;
  let runOpened = false;
  let budget: Budget | undefined;
  let scheduler: Scheduler | undefined;
  let isolation: Isolation | undefined;
  let customTools: ToolRegistry = EMPTY_TOOL_REGISTRY;
  const occurrences = new Occurrences();
  let runner: AgentRunner | undefined;
  let model = opts.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  // Timestamps for `maestro viz`; audit-only, so a write failure is a log line, never a failed run.
  const eventLog = new EventLog((m) => emitLog(m));

  const emit = (ev: WorkflowEvent): void => {
    eventLog.record(ev);
    try {
      events.emit('event', ev);
      events.emit(ev.type, ev);
    } catch {
      // A throwing listener must not break the run.
    }
  };
  const emitLog = (message: string, group?: string): void =>
    emit(withDefined({ type: 'log', runId, message, group }));
  const warnUnknownMetaKeys = (meta: WorkflowMeta, group?: string): void => {
    const extra = unknownMetaKeys(meta);
    if (extra.length > 0) {
      emitLog(
        `meta: unknown key${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')} ignored ` +
          `(known: ${[...KNOWN_META_KEYS].join(', ')})`,
        group,
      );
    }
  };
  const stopError = () =>
    new MaestroError(`run ${runId} stopped${stopReason ? `: ${stopReason}` : ''}`, 'run_stopped');

  /** Waits until every in-flight agent call has appended its row (also calls started meanwhile). */
  async function drain(): Promise<void> {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
  }

  function track(p: Promise<unknown>): Promise<unknown> {
    inflight.add(p);
    const forget = () => inflight.delete(p);
    p.then(forget, forget);
    return p;
  }

  function failRun(error: unknown): never {
    if (fatal === undefined) {
      fatal = error;
      runController.abort(error);
    }
    throw error;
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
    const tools = buildTools(o.tools, o.isolation === 'worktree', customTools);
    const writer = tools.some((t) => t.write);
    const hash = hashCall(prompt, o);
    const n = occurrences.next(hash);
    const key = makeKey(hash, n);

    let hit: Entry | undefined;
    try {
      hit = replay ? replay.lookup(nextId, key, o.label) : journal!.get(key);
    } catch (e) {
      return failRun(e);
    }
    if (hit) {
      if (hit.messages?.some((message) => message.status === 'delivered')) {
        emitLog(
          `agent ${o.label ?? key}: reusing cached result with live steering recorded in the journal`,
          frame.group,
        );
      }
      // Step 2: cache hit. No cap, no budget, no worktree, no slot. A cached writer still owns its
      // branch (its hand-off, spec 3.6): a live same-label sibling must not -B reset it.
      if (writer) getIsolation().claim({ key, label: o.label, hash, n, writer });
      const id = nextId++;
      const base = eventBase(frame, id, key, o);
      emit({ type: 'agent_start', ...base });
      recordPrompt(id, prompt, o, tools);
      if (replay && replayDir) {
        const sourceRow = hit;
        const restored = replay.restore(sourceRow, async () => {
          const row = await materializeReplayEntry(replayDir, sourceRow);
          await journal!.append({
            ...row,
            index: id,
            label: o.label,
            phase: base.phase,
            cachedFrom: opts.replayFrom!.runId,
          });
          emit({ type: 'agent_end', ...base, status: 'ok', cached: true, usage: row.usage });
          return copyValue(row.result);
        });
        return track(restored.catch(failRun));
      }
      emit({ type: 'agent_end', ...base, status: 'ok', cached: true, usage: hit.usage });
      return Promise.resolve(copyValue(hit.result));
    }

    // Step 3: lifetime cap, then the entry reservation; both throw into the script. The cap is checked
    // first (J-23) but only consumed once the budget admits the call: a refused call is not an agent.
    if (scheduler!.admitted() >= scheduler!.maxAgents) scheduler!.admit(); // throws agent_cap
    const lease = budget!.enter();
    scheduler!.admit();
    const id = nextId++;
    // At the first live call, inflight contains only cache imports. Parallel suffix calls must
    // wait for these to reach disk before opening worktrees or sending any provider requests.
    if (replay) replayPrefixSettled ??= Promise.allSettled([...inflight]).then(() => {});
    return track(liveAgent({ frame, prompt, opts: o, tools, hash, n, key, id, lease }));
  }

  async function liveAgent(a: LiveAgent): Promise<unknown> {
    const { frame, opts: o, lease, id, key } = a;
    const pipeline = currentPipelineInput();
    const writer = a.tools.some((t) => t.write);
    const isolated = o.isolation === 'worktree';
    const skipController = new AbortController();
    skipControllers.set(id, skipController);
    const signal = AbortSignal.any([lease.signal, runController.signal, skipController.signal]);
    const base = eventBase(frame, id, key, o);
    const control = new AgentControl(
      { id, label: o.label, phase: o.phase ?? frame.phase, group: frame.group },
      signal,
      (agent) => emit({ type: 'agent_status', runId, agent }),
      (message) => emit({ type: 'agent_message', runId, agentId: id, message }),
    );
    controls.set(id, control);
    emit({ type: 'agent_start', ...base });
    emit({ type: 'agent_status', runId, agent: control.snapshot() });
    recordPrompt(id, a.prompt, o, a.tools);

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
    let setupFailure: { cause: unknown } | undefined;
    try {
      if (replayPrefixSettled) await replayPrefixSettled;
      // Step 4: worktree under the isolation mutex; no slot is held meanwhile (spec 3.4).
      if (isolated && !signal.aborted) {
        try {
          wt = await getIsolation().open({ key, label: o.label, hash: a.hash, n: a.n, writer });
        } catch (e) {
          setupFailure = { cause: e };
        }
      }
      const agentCwd = wt?.path ?? cwd;
      if (setupFailure) {
        error = errorText(setupFailure.cause);
      } else if (signal.aborted) {
        status = 'skipped';
        error = abortText();
      } else {
        try {
          // Step 5-6: the slot covers only the live runner call.
          res = await scheduler!.withSlot(() => {
            eventLog.record({ type: 'agent_running', id });
            control.running();
            return getRunner().run({
              prompt: a.prompt,
              ...(o.pdfs?.length ? { pdfs: o.pdfs } : {}),
              system: systemPrompt({ cwd: agentCwd, writer }),
              tools: a.tools,
              schema: o.schema,
              model: o.model ?? model,
              effort: o.effort,
              cwd: agentCwd,
              signal,
              isolated,
              onUsage: (u) => {
                addUsage(turnUsage, u);
                addUsage(liveUsage, u);
                control.usage(u);
                lease.report(finite(u.output_tokens));
              },
              log: (m) => emitLog(m, frame.group),
              onProgress: (progress) => control.progress(progress),
              registerMessageHandler: (handler) => control.register(handler),
            });
          }, signal);
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
      await control.finish();
      controls.delete(id);
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
      failureInput:
        status === 'ok'
          ? undefined
          : {
              prompt: a.prompt,
              options: o,
              model: o.model ?? model,
              tools: a.tools.map((t) => t.name),
              pipeline,
            },
      worktree,
      trace: res?.trace,
      messages: control.messages(),
    });
    // Step 7: write first, return second; otherwise an interruption re-runs the agent.
    try {
      await journal!.append(entry);
    } catch (e) {
      // Not an agent-level failure: the run fails loudly instead of continuing half-recorded.
      emitLog(`agent ${o.label ?? key} not journaled, the run fails: ${errorText(e)}`, frame.group);
      emit({ type: 'agent_end', ...base, status: 'null', cached: false, usage });
      return failRun(e);
    }
    emit({ type: 'agent_end', ...base, status, cached: false, usage });
    if (setupFailure) throw setupFailure.cause;
    if (stopped) throw stopError();
    return status === 'ok' ? copyValue(entry.result) : null;
  }

  function eventBase(frame: Frame, id: number, key: string, o: AgentOpts) {
    return withDefined({ runId, id, key, label: o.label, phase: o.phase ?? frame.phase, group: frame.group });
  }

  /** What the agent was asked, for the viewer only (the journal keys on a hash of it). */
  function recordPrompt(id: number, prompt: string, o: AgentOpts, tools: ToolDef[]): void {
    const truncated = prompt.length > EVENT_LOG_PROMPT_CHARS;
    eventLog.record(
      withDefined({
        type: 'agent_prompt' as const,
        id,
        prompt: truncated ? prompt.slice(0, EVENT_LOG_PROMPT_CHARS) : prompt,
        truncated: truncated ? (true as const) : undefined,
        model: o.model,
        effort: o.effort,
        isolation: o.isolation,
        tools: tools.map((t) => t.name),
        schema: o.schema !== undefined,
      }),
    );
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
      onAgentRejected: (prompt, options, error) => {
        eventLog.record({
          type: 'agent_rejected',
          id: `rejected-${nextRejectedId++}`,
          input: rejectedCallInput(prompt, options),
          reason: rejectionReason(error),
          pipeline: currentPipelineInput(),
          group: frame.group,
          phase: frame.phase,
        });
      },
      log: (message) => emitLog(message, frame.group),
      onPhase: (title) => {
        frame.phase = title;
        emit(withDefined({ type: 'phase', runId, title, group: frame.group }));
      },
      workflow: (ref, wfArgs) => workflowHook(frame, ref, wfArgs),
      budget: budget!.view(),
      checkItems: (count, where) => scheduler!.checkItems(count, where),
      // spec Seviye 1: the script hears how many items dropped; Seviye 4 "No silent caps".
      onSwallowed: (where, index, err) => {
        const error = errorText(err);
        eventLog.record({
          type: 'step_failure',
          kind: where,
          index,
          error,
          input: currentPipelineInput(),
          group: frame.group,
          phase: frame.phase,
        });
        emitLog(`${where} ${where === 'parallel' ? 'slot' : 'item'} ${index} null: ${error}`, frame.group);
      },
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
    warnUnknownMetaKeys(parsed.meta, parsed.meta.name);
    if (parsed.meta.maxAgents !== undefined) {
      emitLog(
        `workflow ${parsed.meta.name}: meta.maxAgents ${parsed.meta.maxAgents} ignored; ` +
          `the run's shared cap of ${scheduler!.maxAgents} applies`,
        parsed.meta.name,
      );
    }
    const child: Frame = { depth: 1, group: parsed.meta.name };
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
    if (opts.replayFrom) {
      if (resume) throw new Error('replayFrom and resumeFromRunId cannot be combined');
      if (!SAFE_ID.test(opts.replayFrom.runId))
        throw new Error(`invalid source runId "${opts.replayFrom.runId}"`);
      if (!existsSync(replayDir!))
        throw new Error(`no source run ${opts.replayFrom.runId} under ${path.dirname(runDir)}`);
      replay = await loadReplay(replayDir!, opts.replayFrom.from);
      model = opts.model ?? replay.settings?.model ?? DEFAULT_MODEL;
    }
    const concurrency = opts.concurrency ?? replay?.settings?.concurrency ?? defaultConcurrency();
    const requestedBudget = opts.budget === undefined ? replay?.settings?.budget : opts.budget;
    const given = [opts.script, opts.scriptPath, opts.name].filter((v) => v !== undefined).length;
    if (given > 1) throw new Error('pass exactly one of script, scriptPath or name');
    if (given === 0 && !resume && !replay) throw new Error('pass one of script, scriptPath or name');
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
    else source = await readFile(path.join(replayDir ?? runDir, 'script.js'), 'utf8');
    const parsed: ParsedScript = parseScript(source);

    let args: unknown = opts.args;
    const storedArgsFile = path.join(replayDir ?? runDir, 'args.json');
    if (args === undefined && (replay || (resume && existsSync(storedArgsFile))))
      args = JSON.parse(await readFile(storedArgsFile, 'utf8'));
    args = normalizeArgs(args);
    // Before the run dir too: agent() picks tools synchronously, and a bad tool file fails the start.
    customTools = await loadCustomTools({ tools: opts.tools, toolsDir });
    if (customTools.size > 0) emitLog(`custom tools: ${[...customTools.keys()].join(', ')}`);

    // spec 3.1: if the journal cannot be written the run does not start.
    journal = await Journal.open(runDir, { log: (m) => emitLog(m), fresh: !resume });
    runOpened = true;
    if (resume) await rm(path.join(runDir, OUTCOME_FILE), { force: true }).catch(() => {});
    await eventLog.open(runDir, {
      t: startedAt,
      line: {
        type: 'run_start',
        resume,
        journalStart: journal.length,
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: (parsed.meta.phases ?? []).map((ph) => ph.title),
        runner: getRunner().constructor.name,
        model,
        concurrency,
        budget: requestedBudget instanceof Budget ? requestedBudget.total : (requestedBudget ?? null),
      },
    });
    warnUnknownMetaKeys(parsed.meta);
    try {
      await writeFile(scriptFile, source);
      await writeFile(argsFile, `${JSON.stringify(args)}\n`);
      // The cache key covers the prompt and the agent's own opts, not the run's default model or its
      // runner (changing the key would orphan every existing journal). So a resume that changes either
      // says so: its cache hits were produced by the earlier configuration.
      const configFile = path.join(runDir, 'run.json');
      const config = withDefined({
        model,
        runner: getRunner().constructor.name,
        replayFrom: opts.replayFrom,
      });
      if (resume) {
        const before = await readFile(configFile, 'utf8').then(JSON.parse, () => null);
        if (before?.replayFrom) config.replayFrom = before.replayFrom;
        for (const k of ['model', 'runner'] as const) {
          if (typeof before?.[k] === 'string' && before[k] !== config[k]) {
            emitLog(
              `resume changes the ${k} from ${before[k]} to ${config[k]}: journaled results came from ` +
                `${before[k]} and are reused as they are; start a new run to redo them`,
            );
          }
        }
      }
      await writeFile(configFile, `${JSON.stringify(config)}\n`);

      scheduler = new Scheduler({
        concurrency,
        maxAgents: parsed.meta.maxAgents,
      });
      // spec 3.5 aşım payı: max_tokens_per_turn is the largest max_tokens the runner actually sends.
      const r = getRunner();
      const maxReq = (r as { maxRequestTokens?: unknown }).maxRequestTokens;
      budget =
        requestedBudget instanceof Budget
          ? requestedBudget
          : new Budget({
              total: requestedBudget ?? null,
              concurrency: scheduler.concurrency,
              maxTokensPerTurn: typeof maxReq === 'number' ? maxReq : undefined,
            });
      const offTick = budget.onTick((t) => emit({ type: 'budget_tick', runId, ...t }));
      try {
        if (budget.total !== null) {
          // spec 3.5 aşım payı: the accepted overrun ceiling is written to the log.
          emitLog(`budget: total ${budget.total}, overrun ceiling ${budget.overrunCeiling()}`);
        }
        if (stopped) throw stopError();
        const top: Frame = { depth: 0 };
        try {
          const result = await runScript(parsed, args, hooksFor(top), { filename: scriptFile });
          replay?.assertReached();
          return result;
        } finally {
          finished = true;
          // Agents the script left behind are aborted and journaled before the run settles.
          if (inflight.size > 0 && !runController.signal.aborted) runController.abort();
          await drain();
          if (hasCacheInfo(liveUsage)) emitLog(cacheLine(liveUsage));
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
  // Never rejects: finish() settles the run only after this, so a throw here would leave the run pending
  // and, unhandled, end the process. A result JSON cannot hold (a BigInt, a cycle) gets no outcome file.
  const writeOutcome = async (ok: boolean, v: unknown): Promise<void> => {
    if (!runOpened) return;
    const finalPath = path.join(runDir, OUTCOME_FILE);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    try {
      const outcome: PersistedOutcome = ok
        ? { ok: true, result: copyValue(v) }
        : { ok: false, error: errorText(v) };
      await writeFile(tmpPath, `${JSON.stringify(outcome, null, 2)}\n`);
      await rename(tmpPath, finalPath);
    } catch {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  };
  const finish = (ok: boolean, v: unknown) => {
    if (settled) return;
    settled = true;
    eventLog.record(withDefined({ type: 'run_end' as const, ok, error: ok ? undefined : errorText(v) }));
    // Settle once outcome.json and events.jsonl are on disk: a resume or reader right after sees both.
    void Promise.all([writeOutcome(ok, v), eventLog.close()]).then(() => {
      if (ok) settle.resolve(v);
      else settle.reject(v);
    });
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
      // The journal is closed before the promise settles: a resume started right after must not find it
      // still open (agent() throws once stopped, so nothing can append any more).
      void drain()
        .then(() => journal?.close())
        .catch(() => {})
        .then(() => finish(false, stopError()));
    },
    skip(agentId: number): boolean {
      const c = skipControllers.get(agentId);
      if (!c || c.signal.aborted) return false;
      c.abort(new Error('skipped by user'));
      return true;
    },
    liveAgents(): LiveAgentStatus[] {
      return [...controls.values()].map((control) => control.snapshot());
    },
    sendMessage(agentId: number, message: string): AgentMessageReceipt | null {
      if (!Number.isSafeInteger(agentId) || agentId < 0)
        throw new Error('agentId must be a non-negative integer');
      if (stopped || finished || settled) return null;
      return controls.get(agentId)?.send(message) ?? null;
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

/** Run-end summary: total input against what the prompt cache served. */
function cacheLine(u: Usage): string {
  const pct = Math.round((cacheReadRatio(u) ?? 0) * 100);
  const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US');
  return (
    `cache: ${n(totalInput(u))} input tokens, ${n(u.cache_read_input_tokens)} read from cache (${pct}%), ` +
    `${n(u.cache_creation_input_tokens)} written, ${n(u.input_tokens)} uncached; ${n(u.output_tokens)} output`
  );
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

// Invalid inputs and thrown values may be arbitrary VM objects. Diagnostics must never execute
// workflow code a second time (including toJSON, accessors and proxy traps).
function rejectedCallInput(prompt: unknown, options: unknown = {}) {
  const submitted = { prompt, options };
  const input: { prompt?: unknown; options?: unknown; unavailable?: string[] } = {};
  for (const field of ['prompt', 'options'] as const) {
    try {
      input[field] = snapshotJson(submitted[field]);
    } catch {
      input.unavailable ??= [];
      input.unavailable.push(field);
    }
  }
  return input;
}

function rejectionReason(error: unknown): string {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return String(error);
  if (!isProxy(error)) {
    const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
    if (typeof message === 'string') return message;
  }
  return 'agent call threw before admission';
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
