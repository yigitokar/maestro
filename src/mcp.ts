// `maestro mcp`: the Workflow tool as a stdio MCP server. MCP has no push, so completion is polled
// through a second tool, WorkflowResult({ runId }), which returns the outcome or "running".

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  handleWorkflowToolCall,
  maestroToolDefinition,
  type WorkflowOutcome,
  type WorkflowToolContext,
} from './tool.js';

export const WORKFLOW_RESULT_TOOL_NAME = 'WorkflowResult';

type CallResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): CallResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Builds the MCP server. `ctx` configures runs exactly like handleWorkflowToolCall's context. */
export function createMcpServer(ctx: Omit<WorkflowToolContext, 'onComplete'> = {}): Server {
  const outcomes = new Map<string, WorkflowOutcome | 'running'>();
  const def = maestroToolDefinition();
  const server = new Server({ name: 'maestro', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: def.name, description: def.description, inputSchema: def.input_schema as any },
      {
        name: WORKFLOW_RESULT_TOOL_NAME,
        description:
          'Result of a Workflow run started earlier: { status: "running" } while it runs, then { status: "done", result } or { status: "failed", error }.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string', description: 'runId returned by the Workflow tool.' } },
          required: ['runId'],
          additionalProperties: false,
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallResult> => {
    const { name, arguments: input } = req.params;
    if (name === def.name) {
      const res = await handleWorkflowToolCall(input ?? {}, {
        ...ctx,
        onComplete: (runId, outcome) => outcomes.set(runId, outcome),
      });
      if ('is_error' in res) return text(res.content, true);
      if (!outcomes.has(res.runId)) outcomes.set(res.runId, 'running');
      return text(res);
    }
    if (name === WORKFLOW_RESULT_TOOL_NAME) {
      const runId = (input as { runId?: unknown } | undefined)?.runId;
      if (typeof runId !== 'string' || !runId) return text('runId is required', true);
      const outcome = outcomes.get(runId);
      if (outcome === undefined)
        return text(`unknown runId ${runId} (runs started by another server process are not tracked)`, true);
      if (outcome === 'running') return text({ runId, status: 'running' });
      return outcome.ok
        ? text({ runId, status: 'done', result: outcome.result })
        : text({ runId, status: 'failed', error: outcome.error }, true);
    }
    return text(`unknown tool ${name}`, true);
  });

  return server;
}

/** Serves over the given transport (stdio by default) until the transport closes. */
export async function serveMcp(
  ctx: Omit<WorkflowToolContext, 'onComplete'> = {},
  transport: Transport = new StdioServerTransport(),
): Promise<Server> {
  const server = createMcpServer(ctx);
  await server.connect(transport);
  return server;
}
