// `maestro mcp`: the Workflow tool as a stdio MCP server. MCP has no push, so completion is polled
// through a second tool, WorkflowResult({ runId }), which returns the outcome or "running" (with the
// live agents). WorkflowStop and WorkflowSkip are the user controls of the spec Seviye 1 null/throw
// table: stop the run (script rejects, journal stays) and skip a live agent (agent() → null).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
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

export const WORKFLOW_RESULT_TOOL_NAME = 'WorkflowResult';
export const WORKFLOW_STOP_TOOL_NAME = 'WorkflowStop';
export const WORKFLOW_SKIP_TOOL_NAME = 'WorkflowSkip';

type CallResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): CallResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const RUN_ID_PROPERTY = { runId: { type: 'string', description: 'runId returned by the Workflow tool.' } };

/**
 * Builds the MCP server. `ctx` configures runs exactly like handleWorkflowToolCall's context, except
 * that a numeric `budget` becomes one Budget shared by every run of this server: spec 3.5 "tek
 * havuz", so --budget is the session total, not a fresh pool per Workflow call.
 */
export function createMcpServer(ctx: Omit<WorkflowToolContext, 'onComplete'> = {}): Server {
  const outcomes = new Map<string, WorkflowOutcome | 'running'>();
  const budget =
    ctx.budget instanceof Budget
      ? ctx.budget
      : new Budget({ total: ctx.budget ?? null, concurrency: ctx.concurrency ?? defaultConcurrency() });
  const runCtx = { ...ctx, budget };
  const server = new Server({ name: 'maestro', version: '0.1.0' }, { capabilities: { tools: {} } });
  // The client is gone: nobody can poll the result, so live runs stop (their journals stay for resume).
  server.onclose = () => {
    for (const [runId, outcome] of outcomes)
      if (outcome === 'running') stopWorkflowRun(runId, 'MCP client disconnected');
  };

  // Listed fresh on every tools/list, so the description names the custom tools as they are on disk now.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const def = await maestroToolDefinitionFor(ctx);
    return {
      tools: [
        { name: def.name, description: def.description, inputSchema: def.input_schema as any },
        {
          name: WORKFLOW_RESULT_TOOL_NAME,
          description:
            'Result of a Workflow run started earlier: { status: "running" } while it runs, then { status: "done", result } or { status: "failed", error }.',
          inputSchema: {
            type: 'object',
            properties: RUN_ID_PROPERTY,
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

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallResult> => {
    const { name, arguments: input } = req.params;
    if (name === WORKFLOW_TOOL_NAME) {
      const res = await handleWorkflowToolCall(input ?? {}, {
        ...runCtx,
        onComplete: (runId, outcome) => outcomes.set(runId, outcome),
      });
      if ('is_error' in res) return text(res.content, true);
      if (!outcomes.has(res.runId)) outcomes.set(res.runId, 'running');
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
      if (outcome === undefined)
        return text(`unknown runId ${runId} (runs started by another server process are not tracked)`, true);
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
      if (outcome === 'running')
        return text({ runId, status: 'running', liveAgents: liveWorkflowAgents(runId) ?? [] });
      return outcome.ok
        ? text({ runId, status: 'done', result: outcome.result })
        : text({ runId, status: 'failed', error: outcome.error }, true);
    }
    return text(`unknown tool ${name}`, true);
  });

  return server;
}

/** Serves over the given transport (stdio by default); closing the server stops its live runs. */
export async function serveMcp(
  ctx: Omit<WorkflowToolContext, 'onComplete'> = {},
  transport: Transport = new StdioServerTransport(),
): Promise<Server> {
  const server = createMcpServer(ctx);
  await server.connect(transport);
  return server;
}
