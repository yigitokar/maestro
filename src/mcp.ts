// `maestro mcp`: the Workflow tool as a stdio MCP server. Workflow returns a runId at once and a
// second tool, WorkflowResult({ runId, wait? }), gives the outcome. Without wait it answers now: the
// outcome, or "running" with the live agents. With wait: true it holds the call until the run
// settles, so a client that moves long tool calls to the background (Claude Code, after 2 minutes)
// hands the result to the model as a notification and nobody polls. A waiting call sends
// notifications/progress when the client gave a progressToken, so an idle-call timeout does not end
// it. WorkflowStop and WorkflowSkip are the user controls of the spec Seviye 1 null/throw table: stop
// the run (script rejects, journal stays) and skip a live agent (agent() → null). WorkflowGuide
// returns the script-writing guide (skill/SKILL.md), so a client that only connected the server has it.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { Budget } from './budget.js';
import { formatInspectMarkdown, inspectRun } from './inspect.js';
import { defaultConcurrency } from './scheduler.js';
import {
  handleWorkflowReplayCall,
  handleWorkflowToolCall,
  type LiveWorkflowAgent,
  liveWorkflowAgents,
  maestroToolDefinitionFor,
  sendWorkflowAgentMessage,
  skipWorkflowAgent,
  stopWorkflowRun,
  WORKFLOW_TOOL_NAME,
  type WorkflowOutcome,
  type WorkflowToolContext,
} from './tool.js';
import { MAESTRO_VERSION } from './version.js';
import { readOutcome, SAFE_ID } from './workflow.js';

export const WORKFLOW_RESULT_TOOL_NAME = 'WorkflowResult';
export const WORKFLOW_STOP_TOOL_NAME = 'WorkflowStop';
export const WORKFLOW_SKIP_TOOL_NAME = 'WorkflowSkip';
export const WORKFLOW_MESSAGE_TOOL_NAME = 'WorkflowMessage';
export const WORKFLOW_INSPECT_TOOL_NAME = 'WorkflowInspect';
export const WORKFLOW_REPLAY_TOOL_NAME = 'WorkflowReplay';

type CallResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): CallResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export const WORKFLOW_GUIDE_TOOL_NAME = 'WorkflowGuide';
// The package ships skill/ next to src/ (in the repository) and next to dist/ (when installed).
const GUIDE_URL = new URL('../skill/SKILL.md', import.meta.url);
const GUIDE_POINTER = `Before you write your first script in a session, call ${WORKFLOW_GUIDE_TOOL_NAME} and follow the guide it returns.`;

/** The script-writing guide without its skill frontmatter. Read on each call: it is asked for rarely. */
export async function readWorkflowGuide(): Promise<string> {
  const raw = await readFile(GUIDE_URL, 'utf8');
  return raw.replace(/^---\n[\s\S]*?\n---\n+/, '');
}

const RUN_ID_PROPERTY = { runId: { type: 'string', description: 'runId returned by the Workflow tool.' } };

/** Settled runs whose outcome a server keeps for WorkflowResult; older ones answer "unknown runId". */
export const MAX_KEPT_OUTCOMES = 200;

/** How often a waiting WorkflowResult call reports progress, well under any idle-call timeout. */
export const WAIT_PROGRESS_INTERVAL_MS = 30_000;

export interface McpServerOptions extends Omit<WorkflowToolContext, 'onComplete'> {
  /** Progress interval of a waiting WorkflowResult call; default WAIT_PROGRESS_INTERVAL_MS. */
  progressIntervalMs?: number;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Keep notifications useful even for large runs, without sending full tool output or transcripts. */
function liveProgressSummary(agents: LiveWorkflowAgent[]): string {
  if (agents.length === 0) return 'running';
  const lines = agents.slice(0, 8).map((agent) => {
    const label = (agent.label ?? `agent ${agent.id}`).replace(/\s+/g, ' ').slice(0, 60);
    const activity = agent.progress?.summary.replace(/\s+/g, ' ').slice(0, 120);
    const pending = agent.messages.filter((message) => message.status === 'queued').length;
    const delivered = agent.messages.filter((message) => message.status === 'delivered').length;
    const failed = agent.messages.filter((message) => message.status === 'failed').length;
    const details = [
      agent.state,
      `${Math.floor(agent.elapsedMs / 1000)}s`,
      `${agent.turns} turns`,
      `${agent.usage.input_tokens} in/${agent.usage.output_tokens} out`,
      ...(activity ? [activity] : []),
      ...(agent.messages.length
        ? [`messages ${pending} queued/${delivered} delivered/${failed} failed`]
        : []),
    ];
    return `${label} [${details.join('; ')}]`;
  });
  const suffix = agents.length > 8 ? `; +${agents.length - 8} more agents` : '';
  return `running: ${lines.join('; ')}${suffix}`.slice(0, 2048);
}

/**
 * Builds the MCP server. `ctx` configures runs exactly like handleWorkflowToolCall's context, except
 * that a numeric `budget` becomes one Budget shared by every run of this server: spec 3.5 "tek
 * havuz", so --budget is the session total, not a fresh pool per Workflow call.
 */
export function createMcpServer(options: McpServerOptions = {}): Server {
  const { progressIntervalMs = WAIT_PROGRESS_INTERVAL_MS, ...ctx } = options;
  const outcomes = new Map<string, WorkflowOutcome | 'running'>();
  // runId → wake-ups of the WorkflowResult calls waiting for that run to settle.
  const waiters = new Map<string, Set<() => void>>();
  const budget =
    ctx.budget instanceof Budget
      ? ctx.budget
      : new Budget({ total: ctx.budget ?? null, concurrency: ctx.concurrency ?? defaultConcurrency() });
  const runCtx = { ...ctx, budget };
  const server = new Server(
    { name: 'maestro', version: MAESTRO_VERSION },
    {
      capabilities: { tools: {} },
      instructions: `Maestro runs multi-agent workflows from a JavaScript script given to the Workflow tool. ${GUIDE_POINTER}`,
    },
  );
  // The client is gone: nobody can poll the result, so live runs stop (their journals stay for resume).
  server.onclose = () => {
    for (const [runId, outcome] of outcomes)
      if (outcome === 'running') stopWorkflowRun(runId, 'MCP client disconnected');
  };

  const settle = (runId: string, outcome: WorkflowOutcome) => {
    // Re-inserted so the map stays ordered by settle time, then the oldest settled results go: a
    // long-lived server would otherwise keep every result of the session in memory.
    outcomes.delete(runId);
    outcomes.set(runId, outcome);
    let settled = 0;
    for (const o of outcomes.values()) if (o !== 'running') settled++;
    for (const [id, o] of outcomes) {
      if (settled <= MAX_KEPT_OUTCOMES) break;
      if (o === 'running') continue;
      outcomes.delete(id);
      settled--;
    }
    const wakes = waiters.get(runId);
    waiters.delete(runId);
    for (const wake of wakes ?? []) wake();
  };

  // Resolves once the run settles or the client cancels the call. Progress goes out only when the
  // client asked for it (a progressToken): it is what keeps an idle-call timeout from ending the call.
  const waitForRun = (runId: string, extra: Extra) =>
    new Promise<void>((resolve) => {
      if (outcomes.get(runId) !== 'running' || extra.signal.aborted) return resolve();
      const progressToken = extra._meta?.progressToken;
      let progress = 0;
      const timer =
        progressToken === undefined
          ? undefined
          : setInterval(() => {
              const live = liveWorkflowAgents(runId) ?? [];
              const message = liveProgressSummary(live);
              extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++progress, message },
                })
                .catch(() => {});
            }, progressIntervalMs);
      const wake = () => {
        clearInterval(timer);
        waiters.get(runId)?.delete(wake);
        extra.signal.removeEventListener('abort', wake);
        resolve();
      };
      if (!waiters.has(runId)) waiters.set(runId, new Set());
      waiters.get(runId)?.add(wake);
      extra.signal.addEventListener('abort', wake, { once: true });
    });

  // Listed fresh on every tools/list, so the description names the custom tools as they are on disk now.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const def = await maestroToolDefinitionFor(ctx);
    return {
      tools: [
        {
          name: def.name,
          description: `${def.description}\n\n${GUIDE_POINTER}`,
          inputSchema: def.input_schema as any,
        },
        {
          name: WORKFLOW_GUIDE_TOOL_NAME,
          description:
            'The guide to writing a Workflow script: the meta block, the script API, what returns null and what throws, determinism, pipeline or parallel, common patterns, resume. Returns Markdown. Call it once before writing your first script; it starts nothing and costs nothing.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
        {
          name: WORKFLOW_RESULT_TOOL_NAME,
          description:
            'Result of a Workflow run started earlier: { status: "running", liveAgents } while it runs, then { status: "done", result } or { status: "failed", error }. Each live agent reports queued/running state, elapsed time, public activity, turns, token usage, canMessage and message delivery receipts. Also reads settled runs persisted on disk (<stateDir>/runs/<runId>/outcome.json) across MCP sessions. Prefer wait: true when awaiting completion: the call then returns only once the run settles, with concise live progress when the client requests notifications. Use wait: false to inspect agents before WorkflowMessage. Claude Code moves a call that runs past 2 minutes to the background and delivers its result as a notification. If a timeout ends the call, the run goes on: call WorkflowResult again.',
          inputSchema: {
            type: 'object',
            properties: {
              ...RUN_ID_PROPERTY,
              wait: {
                type: 'boolean',
                description: 'true: answer only once the run is done or failed. Default false: answer now.',
              },
              cwd: {
                type: ['string', 'null'],
                description:
                  "Optional working directory passed when starting the run (for reading settled runs on disk); omit for the server's default.",
              },
            },
            required: ['runId'],
            additionalProperties: false,
          },
        },
        {
          name: WORKFLOW_STOP_TOOL_NAME,
          description:
            'Stop a running Workflow run: live agents are aborted and journaled as skipped, the run fails with run_stopped and can be resumed later with resumeFromRunId.',
          inputSchema: {
            type: 'object',
            properties: RUN_ID_PROPERTY,
            required: ['runId'],
            additionalProperties: false,
          },
        },
        {
          name: WORKFLOW_MESSAGE_TOOL_NAME,
          description:
            'Send a follow-up instruction to one live agent. Use an id from WorkflowResult.liveAgents with canMessage: true. Returns a queued receipt immediately; WorkflowResult shows when it is delivered or failed. Delivery means the runner accepted the instruction, not that the agent has finished acting on it. Anthropic agents receive it before their next model request; Codex app-server agents use live steering. Messages are limited to 16,000 characters and 32 per agent and are recorded with the run: do not send credentials.',
          inputSchema: {
            type: 'object',
            properties: {
              ...RUN_ID_PROPERTY,
              agentId: {
                type: 'integer',
                minimum: 0,
                description: 'id of a live agent that supports messages, from WorkflowResult.liveAgents.',
              },
              message: {
                type: 'string',
                minLength: 1,
                maxLength: 16_000,
                description: 'Follow-up instruction.',
              },
            },
            required: ['runId', 'agentId', 'message'],
            additionalProperties: false,
          },
        },
        {
          name: WORKFLOW_SKIP_TOOL_NAME,
          description:
            "Skip one live agent of a running Workflow run: its agent() call returns null and its journal row is 'skipped'. Live agent ids are listed by WorkflowResult while the run is running.",
          inputSchema: {
            type: 'object',
            properties: {
              ...RUN_ID_PROPERTY,
              agentId: {
                type: 'integer',
                minimum: 0,
                description: 'id of a live agent, from WorkflowResult.liveAgents.',
              },
            },
            required: ['runId', 'agentId'],
            additionalProperties: false,
          },
        },
        {
          name: WORKFLOW_INSPECT_TOOL_NAME,
          description:
            'Compact, agent-friendly diagnostic summary of a Workflow run on disk. Returns only failed nodes (with prompt and schema previews, error, failed tool calls, raw/final text) plus relevant upstream state by default (`compact: true`), with long fields bounded. Pass `full: true` for complete recorded fields. Pass `label` (or `#index` / key prefix) to inspect a specific agent, or `format: "json"` for structured JSON.',
          inputSchema: {
            type: 'object',
            properties: {
              ...RUN_ID_PROPERTY,
              full: { type: 'boolean', description: 'Show complete recorded prompts, schemas and outputs.' },
              compact: {
                type: 'boolean',
                description: 'Minimal failure-focused summary for agent context windows (default true).',
              },
              label: {
                type: ['string', 'null'],
                description: 'Optional agent label, #index, or key prefix to inspect specifically.',
              },
              format: {
                type: 'string',
                enum: ['markdown', 'json'],
                description: 'Output format: markdown (default) or json.',
              },
              cwd: {
                type: ['string', 'null'],
                description:
                  "Optional working directory passed when starting the run; omit for the server's default.",
              },
            },
            required: ['runId'],
            additionalProperties: false,
          },
        },
        {
          name: WORKFLOW_REPLAY_TOOL_NAME,
          description:
            'Time-travel replay: fork an earlier Workflow run into a new runId starting live execution from a specific node (`from`: label, #index, key prefix, or `phase:<title>`). All upstream `ok` nodes before `from` are served directly from cache (zero tokens) while the original run stays untouched for diffing. Pass an edited `script` or `scriptPath` to iterate on prompts/graph without re-running upstream LLM calls.',
          inputSchema: {
            type: 'object',
            properties: {
              fromRunId: {
                type: 'string',
                description: 'Source runId to replay from (never modified on disk).',
              },
              from: {
                type: ['string', 'null'],
                description:
                  'Node selector (label, #index, key prefix, or phase:<title>) to re-execute live from; omit/null to fork all cached ok nodes.',
              },
              script: {
                type: ['string', 'null'],
                description:
                  "Optional updated inline workflow script; omit/null to reuse the source run's script.js.",
              },
              scriptPath: {
                type: ['string', 'null'],
                description: 'Optional updated workflow script path, relative to cwd.',
              },
              args: {
                type: ['string', 'null'],
                description: "Optional JSON-encoded args; omit/null to reuse the source run's args.json.",
              },
              cwd: {
                type: ['string', 'null'],
                description:
                  "Optional working directory (must match the source run's cwd); omit/null for the server's default.",
              },
            },
            required: ['fromRunId'],
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallResult> => {
    const { name, arguments: input } = req.params;
    if (name === WORKFLOW_TOOL_NAME) {
      // A resume reuses its runId, so this server may still hold the outcome of the earlier attempt.
      const resumed = (input as { resumeFromRunId?: unknown } | undefined)?.resumeFromRunId;
      const earlier = typeof resumed === 'string' ? outcomes.get(resumed) : undefined;
      const res = await handleWorkflowToolCall(input ?? {}, { ...runCtx, onComplete: settle });
      if ('is_error' in res) return text(res.content, true);
      // The run can settle before this line (settle already stored its outcome): only an absent entry
      // or the earlier attempt's outcome becomes 'running'.
      const now = outcomes.get(res.runId);
      if (now === undefined || now === earlier) outcomes.set(res.runId, 'running');
      return text(res);
    }
    if (name === WORKFLOW_REPLAY_TOOL_NAME) {
      const res = await handleWorkflowReplayCall(input ?? {}, { ...runCtx, onComplete: settle });
      if ('is_error' in res) return text(res.content, true);
      if (outcomes.get(res.runId) === undefined) outcomes.set(res.runId, 'running');
      return text(res);
    }
    if (
      name === WORKFLOW_RESULT_TOOL_NAME ||
      name === WORKFLOW_STOP_TOOL_NAME ||
      name === WORKFLOW_SKIP_TOOL_NAME ||
      name === WORKFLOW_MESSAGE_TOOL_NAME
    ) {
      const runId = (input as { runId?: unknown } | undefined)?.runId;
      if (typeof runId !== 'string' || !runId) return text('runId is required', true);
      const outcome = outcomes.get(runId);
      if (outcome === undefined) {
        if (name === WORKFLOW_RESULT_TOOL_NAME && SAFE_ID.test(runId)) {
          const inputCwd = (input as { cwd?: unknown } | undefined)?.cwd;
          const serverCwd = path.resolve(ctx.cwd ?? process.cwd());
          const targetCwd =
            typeof inputCwd === 'string' && inputCwd.length > 0
              ? path.resolve(serverCwd, inputCwd)
              : serverCwd;
          const stateDir = path.resolve(targetCwd, ctx.stateDir ?? '.maestro');
          const persisted = await readOutcome(path.join(stateDir, 'runs', runId));
          if (persisted !== undefined) {
            return persisted.ok
              ? text({ runId, status: 'done', result: persisted.result })
              : text({ runId, status: 'failed', error: persisted.error }, true);
          }
        }
        return text(
          `unknown runId ${runId} (no settled run of that id on disk; a run another server process is still ` +
            `running is not tracked; the journal is under .maestro/runs/${runId})`,
          true,
        );
      }
      if (name === WORKFLOW_STOP_TOOL_NAME) {
        if (outcome !== 'running' || !stopWorkflowRun(runId, 'stopped by user'))
          return text(`run ${runId} is not running`, true);
        return text({ runId, status: 'stopping' });
      }
      if (name === WORKFLOW_SKIP_TOOL_NAME) {
        const agentId = (input as { agentId?: unknown }).agentId;
        if (typeof agentId !== 'number' || !Number.isInteger(agentId) || agentId < 0)
          return text('agentId must be a nonnegative integer', true);
        if (outcome !== 'running' || !skipWorkflowAgent(runId, agentId))
          return text(`agent ${agentId} of run ${runId} is not live`, true);
        return text({ runId, agentId, status: 'skipped' });
      }
      if (name === WORKFLOW_MESSAGE_TOOL_NAME) {
        const { agentId, message } = input as { agentId?: unknown; message?: unknown };
        if (typeof agentId !== 'number' || !Number.isInteger(agentId) || agentId < 0)
          return text('agentId must be a nonnegative integer', true);
        if (typeof message !== 'string' || message.trim().length === 0 || message.length > 16_000)
          return text('message must contain text and be at most 16,000 characters', true);
        if (outcome !== 'running') return text(`run ${runId} is not running`, true);
        try {
          const receipt = sendWorkflowAgentMessage(runId, agentId, message);
          if (receipt === null)
            return text(
              `agent ${agentId} of run ${runId} cannot accept messages; inspect WorkflowResult.liveAgents and canMessage`,
              true,
            );
          return text({ runId, agentId, message: receipt });
        } catch (error) {
          return text(error instanceof Error ? error.message : String(error), true);
        }
      }
      if ((input as { wait?: unknown }).wait === true) await waitForRun(runId, extra);
      const current = outcomes.get(runId) ?? outcome;
      if (current === 'running')
        return text({ runId, status: 'running', liveAgents: liveWorkflowAgents(runId) ?? [] });
      return current.ok
        ? text({ runId, status: 'done', result: current.result })
        : text({ runId, status: 'failed', error: current.error }, true);
    }
    if (name === WORKFLOW_INSPECT_TOOL_NAME) {
      const inp = (input ?? {}) as {
        runId?: unknown;
        compact?: unknown;
        full?: unknown;
        label?: unknown;
        format?: unknown;
        cwd?: unknown;
      };
      if (typeof inp.runId !== 'string' || !SAFE_ID.test(inp.runId)) {
        return text(`invalid runId "${String(inp.runId ?? '')}"`, true);
      }
      if (inp.format !== undefined && inp.format !== 'markdown' && inp.format !== 'json') {
        return text(`invalid format "${String(inp.format)}" (expected markdown or json)`, true);
      }
      if (inp.label !== undefined && inp.label !== null && typeof inp.label !== 'string') {
        return text('label must be a string or null', true);
      }
      if (inp.cwd !== undefined && inp.cwd !== null && typeof inp.cwd !== 'string') {
        return text('cwd must be a string or null', true);
      }
      const serverCwd = path.resolve(ctx.cwd ?? process.cwd());
      const targetCwd =
        typeof inp.cwd === 'string' && inp.cwd.length > 0 ? path.resolve(serverCwd, inp.cwd) : serverCwd;
      const stateDir = path.resolve(targetCwd, ctx.stateDir ?? '.maestro');
      const runDir = path.join(stateDir, 'runs', inp.runId);
      try {
        const report = await inspectRun(runDir, inp.runId, {
          full: inp.full === true,
          compact: typeof inp.compact === 'boolean' ? inp.compact : true,
          ...(typeof inp.label === 'string' && inp.label.trim() !== '' ? { selector: inp.label } : {}),
        });
        return inp.format === 'json' ? text(report) : text(formatInspectMarkdown(report));
      } catch (err) {
        return text(err instanceof Error ? err.message : String(err), true);
      }
    }
    if (name === WORKFLOW_GUIDE_TOOL_NAME) {
      try {
        return text(await readWorkflowGuide());
      } catch (err) {
        return text(`the guide could not be read (${(err as Error).message})`, true);
      }
    }
    return text(`unknown tool ${name}`, true);
  });

  return server;
}

/** Serves over the given transport (stdio by default); closing the server stops its live runs. */
export async function serveMcp(
  options: McpServerOptions = {},
  transport: Transport = new StdioServerTransport(),
): Promise<Server> {
  const server = createMcpServer(options);
  await server.connect(transport);
  return server;
}
