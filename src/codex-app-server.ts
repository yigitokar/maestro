// Bidirectional Codex protocol for workflow agents that accept live messages. No listening socket.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { JSONSchema, RunRequest, Usage } from './types.js';

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

interface Options {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  req: RunRequest;
  prompt: string;
  model?: string;
  schema?: JSONSchema;
  killGraceMs: number;
  /** Sent as clientInfo.version in `initialize`. */
  clientVersion: string;
  /** How long a `turn/steer` may go unanswered before that one message fails (default 30 seconds). */
  steerTimeoutMs?: number;
  onEvent(event: unknown): void;
  onUsage(usage: Usage): void;
}

/**
 * The process ended before it answered `initialize`: this Codex CLI has no usable `app-server`. The
 * prompt was never sent, so nothing ran and the caller can safely run the agent with `codex exec`.
 * A failure after the handshake is a real error and is reported as one.
 */
export class CodexAppServerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerUnavailable';
  }
}

/** A successful turn is followed by deliberate server shutdown; it does not exit by itself. */
export function executeCodexAppServer(opts: Options): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  const { req } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin, opts.args, {
      cwd: req.cwd,
      env: opts.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map<
      number,
      { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
    >();
    const messages: Array<{ text: string; resolve(): void; reject(error: Error): void }> = [];
    let id = 0;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let sending = false;
    let stopped = false;
    let completed = false;
    let handshake = false;
    let settled = false;
    let failure: Error | undefined;
    let stderr = '';
    let unregister: (() => void) | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let pipeTimer: ReturnType<typeof setTimeout> | undefined;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let closed = false;
    let killed = false;
    let pipesExpired = false;
    const totals: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const textByItem = new Map<string, string>();

    function fail(error: unknown): void {
      failure ??= error instanceof Error ? error : new Error(String(error));
      stop();
    }

    function send(value: unknown): void {
      if (child.stdin.destroyed) throw new Error('Codex app-server input is closed');
      child.stdin.write(`${JSON.stringify(value)}\n`);
    }

    function rpc(
      method: string,
      params: unknown,
      onResult?: (result: any) => void,
      /** Set for a request whose timeout must fail only that request, not the agent. */
      softTimeoutMs?: number,
    ): Promise<any> {
      if (stopped) return Promise.reject(new Error('Codex agent is no longer running'));
      return new Promise((resolveRequest, rejectRequest) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          const error = new Error(`Codex app-server ${method} timed out`);
          rejectRequest(error);
          if (softTimeoutMs === undefined) fail(error);
        }, softTimeoutMs ?? 30_000);
        pending.set(requestId, {
          resolve: (result) => {
            try {
              onResult?.(result);
              resolveRequest(result);
            } catch (error) {
              rejectRequest(error);
            }
          },
          reject: rejectRequest,
          timer,
        });
        try {
          send({ id: requestId, method, params });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          rejectRequest(error);
          fail(error);
        }
      });
    }

    function rejectPending(): void {
      const error = new Error(
        req.signal.aborted
          ? 'Codex agent was aborted before message delivery'
          : 'Codex agent ended before message delivery',
      );
      unregister?.();
      unregister = undefined;
      for (const message of messages.splice(0)) message.reject(error);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    }

    function finish(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(pipeTimer);
      req.signal.removeEventListener('abort', stop);
      rejectPending();
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!handshake && !req.signal.aborted) {
        const detail =
          failure?.message ?? `exited (${signal ?? code}): ${stderr.trim() || 'no error details'}`;
        reject(new CodexAppServerUnavailable(`codex app-server did not start: ${detail}`));
      } else if (failure) reject(failure);
      else
        resolve(
          completed && !req.signal.aborted ? { code: 0, signal: null, stderr } : { code, signal, stderr },
        );
    }

    function signalGroup(signal: NodeJS.Signals, quiet = false): void {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!quiet && object(error)?.code !== 'ESRCH') failure ??= error as Error;
      }
    }

    function stop(): void {
      if (stopped || settled) return;
      stopped = true;
      rejectPending();
      signalGroup('SIGTERM');
      // Escalate for descendants even when the leader and its own pipes already closed.
      killTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        killed = true;
        if (closed && exited) finish(exited.code, exited.signal);
        else
          pipeTimer = setTimeout(() => {
            pipesExpired = true;
            lines.close();
            child.stdin.destroy();
            child.stdout.destroy();
            child.stderr.destroy();
            if (exited) finish(exited.code, exited.signal);
          }, 100);
      }, opts.killGraceMs);
    }

    async function flushMessages(): Promise<void> {
      if (sending || !threadId || !turnId || stopped) return;
      sending = true;
      try {
        while (messages.length && !stopped) {
          const message = messages[0]!;
          try {
            await rpc(
              'turn/steer',
              {
                threadId,
                expectedTurnId: turnId,
                input: [{ type: 'text', text: message.text }],
              },
              (response) => {
                if (stopped || response.turnId !== turnId)
                  throw new Error('Codex turn ended before message delivery');
                // Settle in the JSONL callback: completion may be the next line in the same chunk.
                message.resolve();
              },
              // A lost acknowledgement fails this message only; the agent keeps working.
              opts.steerTimeoutMs ?? 30_000,
            );
          } catch (error) {
            message.reject(error instanceof Error ? error : new Error(String(error)));
          }
          if (messages[0] === message) messages.shift();
        }
      } finally {
        sending = false;
      }
    }

    function progress(
      activity: 'model' | 'tool' | 'message' | 'status',
      summary: string,
      tool?: string,
    ): void {
      req.onProgress?.({
        activity,
        summary: summary.slice(0, 2_000),
        ...(tool ? { tool } : {}),
        ...(turnId ? { turns: 1 } : {}),
      });
    }

    function itemEvent(item: ObjectValue, done: boolean): void {
      if (item.type === 'agentMessage') {
        if (typeof item.text === 'string') {
          progress('message', item.text);
          if (done && (item.phase == null || item.phase === 'final_answer'))
            opts.onEvent({ type: 'item.completed', item: { type: 'agent_message', text: item.text } });
        }
        if (done && typeof item.id === 'string') textByItem.delete(item.id);
      } else if (item.type === 'commandExecution') {
        progress('tool', `${done ? 'Finished: ' : ''}${String(item.command ?? 'Running command')}`, 'shell');
        if (done)
          opts.onEvent({
            type: 'item.completed',
            item: { type: 'command_execution', command: item.command, exit_code: item.exitCode },
          });
      } else if (item.type === 'mcpToolCall') {
        progress(
          'tool',
          `${done ? 'Finished' : 'Calling'} ${String(item.server)}.${String(item.tool)}`,
          String(item.tool),
        );
      } else if (item.type === 'fileChange')
        progress('tool', done ? 'Finished editing files' : 'Editing files', 'edit_file');
      else if (item.type === 'reasoning') progress('model', 'Working on the task');
    }

    function notification(method: string, params: ObjectValue): void {
      if (params.threadId !== threadId) return;
      if (method === 'turn/started' && typeof params.turn?.id === 'string') {
        turnId = params.turn.id;
        progress('model', 'Codex is working');
        void flushMessages().catch(fail);
      } else if (method === 'thread/tokenUsage/updated') {
        const total = object(params.tokenUsage?.total);
        if (!total) return;
        const next: Usage = {
          input_tokens: Math.max(0, count(total.inputTokens) - count(total.cachedInputTokens)),
          output_tokens: count(total.outputTokens),
          cache_read_input_tokens: count(total.cachedInputTokens),
          cache_creation_input_tokens: count(total.cacheWriteInputTokens),
        };
        const delta: Usage = { input_tokens: 0, output_tokens: 0 };
        for (const key of Object.keys(next) as Array<keyof Usage>) {
          delta[key] = Math.max(0, (next[key] ?? 0) - (totals[key] ?? 0));
          totals[key] = Math.max(totals[key] ?? 0, next[key] ?? 0);
        }
        if (Object.values(delta).some((value) => value > 0)) opts.onUsage(delta);
      } else if (method === 'item/started' || method === 'item/completed') {
        const item = object(params.item);
        if (item) itemEvent(item, method === 'item/completed');
      } else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        const key = String(params.itemId);
        const text = ((textByItem.get(key) ?? '') + params.delta).slice(-2_000);
        textByItem.set(key, text);
        progress('message', text);
      } else if (method === 'error') {
        if (params.willRetry) progress('status', 'Codex is retrying a request');
        else opts.onEvent({ type: 'error', error: params.error });
      } else if (method === 'turn/completed' && params.turn?.id === turnId) {
        const turn = params.turn;
        if (turn.status === 'completed') {
          completed = true;
          opts.onEvent({ type: 'turn.completed' });
        } else
          opts.onEvent({
            type: 'turn.failed',
            error: turn.error ?? { message: `Codex turn ${String(turn.status)}` },
          });
        stop();
      }
    }

    function serverRequest(request: ObjectValue): void {
      progress('status', 'Codex requested unavailable interactive input');
      const method = request.method;
      let result: unknown;
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')
        result = { decision: 'decline' };
      else if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
      else if (method === 'mcpServer/elicitation/request') result = { action: 'decline' };
      else if (method === 'item/tool/requestUserInput') result = { answers: {} };
      else {
        send({ id: request.id, error: { code: -32601, message: 'Unsupported interactive request' } });
        return;
      }
      send({ id: request.id, result });
    }

    lines.on('line', (line) => {
      try {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          return;
        }
        const event = object(value);
        if (!event) return;
        if (typeof event.method === 'string') {
          if (event.id !== undefined) serverRequest(event);
          else notification(event.method, object(event.params) ?? {});
        } else if (typeof event.id === 'number') {
          const request = pending.get(event.id);
          if (!request) return;
          clearTimeout(request.timer);
          pending.delete(event.id);
          if (event.error) request.reject(new Error(String(event.error.message ?? 'Codex RPC failed')));
          else request.resolve(event.result);
        }
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.stdin.on('error', (error) => {
      if (!stopped) fail(error);
    });
    child.on('error', fail);
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (pipesExpired) finish(code, signal);
    });
    child.on('close', (code, signal) => {
      closed = true;
      exited = { code, signal };
      if (completed && stopped && !killed) {
        // The turn is done and the server has gone: nothing is left to wait for. Descendants that
        // outlived it get the SIGKILL now instead of after the grace period; a failed kill here must
        // not turn a finished agent into an error.
        signalGroup('SIGKILL', true);
        finish(code, signal);
      } else if (!stopped || killed) finish(code, signal);
    });
    req.signal.addEventListener('abort', stop, { once: true });
    if (req.signal.aborted) stop();

    void (async () => {
      await rpc('initialize', { clientInfo: { name: 'maestro', version: opts.clientVersion } });
      handshake = true;
      if (stopped) return;
      send({ method: 'initialized', params: {} });
      const response = await rpc('thread/start', {
        cwd: req.cwd,
        ephemeral: true,
        sandbox: req.isolated ? 'workspace-write' : 'read-only',
        approvalPolicy: 'never',
        ...(opts.model ? { model: opts.model } : {}),
      });
      threadId = response.thread?.id;
      if (typeof threadId !== 'string') throw new Error('Codex app-server returned no thread id');
      if (stopped) return;
      unregister = req.registerMessageHandler?.(
        (message) =>
          new Promise<void>((accept, deny) => {
            if (stopped) {
              deny(new Error('Codex agent is no longer running'));
              return;
            }
            messages.push({ text: message, resolve: accept, reject: deny });
            void flushMessages().catch(fail);
          }),
      );
      const started = await rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text: opts.prompt }],
        ...(req.effort ? { effort: req.effort === 'max' ? 'xhigh' : req.effort } : {}),
        ...(opts.schema ? { outputSchema: opts.schema } : {}),
      });
      if (stopped) return;
      if (typeof started.turn?.id !== 'string') throw new Error('Codex app-server returned no turn id');
      turnId = started.turn.id;
      void flushMessages().catch(fail);
    })().catch((error) => {
      if (!stopped) fail(error);
    });
  });
}
