// `maestro mcp`: the Workflow tool as a stdio MCP server. Workflow returns a runId at once and a
// second tool, WorkflowResult({ runId, wait? }), gives the outcome. Without wait it answers now: the
// outcome, or "running" with the live agents. With wait: true it holds the call until the run
// settles, so a client that moves long tool calls to the background (Claude Code, after 2 minutes)
// hands the result to the model as a notification and nobody polls. A waiting call sends
// notifications/progress when the client gave a progressToken, so an idle-call timeout does not end
// it. WorkflowStop and WorkflowSkip are the user controls of the spec Seviye 1 null/throw table: stop
// the run (script rejects, journal stays) and skip a live agent (agent() → null).

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
import { defaultConcurrency } from './scheduler.js';
import {
  handleWorkflowToolCall,
  liveWorkflowAgents,
  maestroToolDefinitionFor,
  skipWorkflowAgent,
  stopWorkflowRun,
  WORKFLOW_TOOL_NAME,
  type WorkflowOutcome,
  type WorkflowToolContext,
} from './tool.js';
import { readOutcome, SAFE_ID } from './workflow.js';

export const WORKFLOW_RESULT_TOOL_NAME = 'WorkflowResult';
export const WORKFLOW_STOP_TOOL_NAME = 'WorkflowStop';
export const WORKFLOW_SKIP_TOOL_NAME = 'WorkflowSkip';

type CallResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): CallResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

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
  const server = new Server({ name: 'maestro', version: '1.2.0' }, { capabilities: { tools: {} } });
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
              const message = live.length
                ? `running: ${live.map((a) => a.label ?? `agent ${a.id}`).join(', ')}`
                : 'running';
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
        { name: def.name, description: def.description, inputSchema: def.input_schema as any },
        {
          name: WORKFLOW_RESULT_TOOL_NAME,
          description:
            'Result of a Workflow run started earlier: { status: "running" } while it runs, then { status: "done", result } or { status: "failed", error }. Also reads settled runs persisted on disk (<stateDir>/runs/<runId>/outcome.json) across MCP sessions. Prefer wait: true over polling: the call then returns only once the run settles. Claude Code moves a call that runs past 2 minutes to the background and delivers its result as a notification, so you can keep working meanwhile. If a timeout ends the call, the run goes on: call WorkflowResult again.',
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
          name: WORKFLOW_SKIP_TOOL_NAME,
          description:
            "Skip one live agent of a running Workflow run: its agent() call returns null and its journal row is 'skipped'. Live agent ids are listed by WorkflowResult while the run is running.",
          inputSchema: {
            type: 'object',
            properties: {
              ...RUN_ID_PROPERTY,
              agentId: {
                type: 'integer',
                description: 'id of a live agent, from WorkflowResult.liveAgents.',
              },
            },
            required: ['runId', 'agentId'],
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
    if (
      name === WORKFLOW_RESULT_TOOL_NAME ||
      name === WORKFLOW_STOP_TOOL_NAME ||
      name === WORKFLOW_SKIP_TOOL_NAME
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
        if (typeof agentId !== 'number' || !Number.isInteger(agentId))
          return text('agentId must be an integer', true);
        if (outcome !== 'running' || !skipWorkflowAgent(runId, agentId))
          return text(`agent ${agentId} of run ${runId} is not live`, true);
        return text({ runId, agentId, status: 'skipped' });
      }
      if ((input as { wait?: unknown }).wait === true) await waitForRun(runId, extra);
      const current = outcomes.get(runId) ?? outcome;
      if (current === 'running')
        return text({ runId, status: 'running', liveAgents: liveWorkflowAgents(runId) ?? [] });
      return current.ok
        ? text({ runId, status: 'done', result: current.result })
        : text({ runId, status: 'failed', error: current.error }, true);
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
