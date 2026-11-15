// Temporary stdio MCP server + file-queue IPC bridge for CodexRunner custom tools.
// Uses atomic files inside tempDir rather than TCP/Unix sockets so it works inside Seatbelt sandboxes,
// runs in-memory ToolDef closures in the parent Maestro process, honours AbortSignal, and records traces.

import { existsSync, type FSWatcher, watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext, ToolDef, TraceToolCall } from './types.js';

const TRACE_INPUT_CHARS = 200;
const POLL_MS = 12;

export interface CodexToolBridge {
  readonly dir: string;
  readonly serverScript: string;
  /** `-c` flag pairs to pass to `codex exec`. */
  readonly codexConfigArgs: string[];
  close(): Promise<void>;
}

interface BridgeRequest {
  id: string;
  name: string;
  arguments: unknown;
}

interface BridgeResponse {
  ok: boolean;
  content: string;
}

function summarizeInput(input: unknown): string {
  try {
    return (JSON.stringify(input) ?? String(input)).slice(0, TRACE_INPUT_CHARS);
  } catch {
    return String(input).slice(0, TRACE_INPUT_CHARS);
  }
}

async function writeAtomicJson(targetPath: string, value: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value));
  await rename(tmpPath, targetPath);
}

function buildServerSource(): string {
  const serverUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/index.js');
  const stdioUrl = import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js');
  const typesUrl = import.meta.resolve('@modelcontextprotocol/sdk/types.js');
  return `import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Server } from ${JSON.stringify(serverUrl)};
import { StdioServerTransport } from ${JSON.stringify(stdioUrl)};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(typesUrl)};

const bridgeDir = process.argv[2];
const reqDir = path.join(bridgeDir, 'req');
const resDir = path.join(bridgeDir, 'res');
const manifest = JSON.parse(await readFile(path.join(bridgeDir, 'manifest.json'), 'utf8'));

const server = new Server({ name: 'maestro_tools', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: manifest.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const id = randomUUID();
  const reqTmp = path.join(reqDir, id + '.tmp');
  const reqFile = path.join(reqDir, id + '.json');
  const resFile = path.join(resDir, id + '.json');
  const cancelFile = path.join(reqDir, id + '.cancel');
  await writeFile(reqTmp, JSON.stringify({ id, name: req.params.name, arguments: req.params.arguments ?? {} }));
  await rename(reqTmp, reqFile);
  try {
    while (!existsSync(resFile)) {
      if (extra.signal?.aborted) {
        await writeFile(cancelFile, '1').catch(() => {});
        throw new Error('aborted');
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    const raw = JSON.parse(await readFile(resFile, 'utf8'));
    await rm(resFile, { force: true }).catch(() => {});
    return {
      content: [{ type: 'text', text: String(raw.content ?? '') }],
      ...(raw.ok ? {} : { isError: true }),
    };
  } finally {
    await rm(reqFile, { force: true }).catch(() => {});
  }
});

await server.connect(new StdioServerTransport());
const shutdown = () => void server.close();
process.stdin.once('end', shutdown);
process.stdin.once('close', shutdown);
if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
`;
}

export async function startCodexToolBridge(opts: {
  dir: string;
  tools: ToolDef[];
  ctx: ToolContext;
  onToolCall: (call: TraceToolCall) => void;
}): Promise<CodexToolBridge> {
  const { dir, tools, ctx, onToolCall } = opts;
  const reqDir = path.join(dir, 'req');
  const resDir = path.join(dir, 'res');
  await mkdir(reqDir, { recursive: true });
  await mkdir(resDir, { recursive: true });

  const byName = new Map<string, ToolDef>();
  for (const t of tools) byName.set(t.name, t);

  const manifest = [...byName.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

  const serverScript = path.join(dir, 'server.mjs');
  await writeFile(serverScript, buildServerSource());

  let closed = false;
  const inflight = new Set<Promise<void>>();
  const seen = new Set<string>();
  const bridgeAbort = new AbortController();

  const handleRequestFile = async (file: string): Promise<void> => {
    const reqPath = path.join(reqDir, file);
    let payload: BridgeRequest;
    try {
      payload = JSON.parse(await readFile(reqPath, 'utf8')) as BridgeRequest;
      await rm(reqPath, { force: true });
    } catch {
      return;
    }
    const resPath = path.join(resDir, `${payload.id}.json`);
    const cancelPath = path.join(reqDir, `${payload.id}.cancel`);
    const tool = byName.get(payload.name);
    if (!tool) {
      const response: BridgeResponse = { ok: false, content: `unknown tool "${payload.name}"` };
      await writeAtomicJson(resPath, response).catch(() => {});
      return;
    }

    const callController = new AbortController();
    const cancelPoll = setInterval(() => {
      if (existsSync(cancelPath)) callController.abort(new Error('cancelled by client'));
    }, POLL_MS);
    const signal = AbortSignal.any([ctx.signal, bridgeAbort.signal, callController.signal]);
    const traceCall: TraceToolCall = {
      tool: tool.name,
      inputSummary: summarizeInput(payload.arguments),
      ok: false,
    };
    onToolCall(traceCall);

    let response: BridgeResponse;
    try {
      const out = await tool.run(payload.arguments, { cwd: ctx.cwd, signal });
      traceCall.ok = true;
      response = { ok: true, content: typeof out === 'string' ? out : String(out ?? '') };
    } catch (err) {
      traceCall.ok = false;
      response = { ok: false, content: err instanceof Error ? err.message : String(err) };
    } finally {
      clearInterval(cancelPoll);
      await rm(cancelPath, { force: true }).catch(() => {});
    }
    if (!closed) await writeAtomicJson(resPath, response).catch(() => {});
  };

  let scanning = false;
  const scanOnce = async (): Promise<void> => {
    if (closed || scanning) return;
    scanning = true;
    try {
      const entries = await readdir(reqDir).catch(() => [] as string[]);
      for (const file of entries) {
        if (!file.endsWith('.json') || seen.has(file)) continue;
        seen.add(file);
        const task = handleRequestFile(file).finally(() => inflight.delete(task));
        inflight.add(task);
      }
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => void scanOnce(), POLL_MS);
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(reqDir, () => void scanOnce());
    watcher.on('error', () => {});
  } catch {
    // Polling handles platforms/sandboxes without fs.watch.
  }

  return {
    dir,
    serverScript,
    codexConfigArgs: [
      '-c',
      `mcp_servers.maestro_tools.command=${JSON.stringify(process.execPath)}`,
      '-c',
      `mcp_servers.maestro_tools.args=${JSON.stringify([serverScript, dir])}`,
      // codex exec cannot ask for approval, and without this it refuses every call to the server
      // ("requires approval, but approvals are disabled"). The tools are the ones the script gave the agent.
      '-c',
      'mcp_servers.maestro_tools.default_tools_approval_mode="approve"',
    ],
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      watcher?.close();
      bridgeAbort.abort();
      if (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
