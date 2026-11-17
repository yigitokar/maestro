import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicRunner, type StructuredMode, SUBMIT_RESULT_TOOL_NAME } from '../src/runner.js';
import type { AgentProgress, RunRequest, ToolDef } from '../src/types.js';

const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (name: string, input: unknown = {}) => ({ type: 'tool_use', id: 'tool_1', name, input });
function reply(content: unknown[], stop_reason = 'end_turn') {
  return new Response(
    JSON.stringify({
      id: 'message',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content,
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

type Step = (body: any, signal: AbortSignal | null | undefined) => Response | Promise<Response>;
function fixture(steps: Step[], options: { maxTurns?: number; structuredMode?: StructuredMode } = {}) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const step = steps.shift();
    if (!step) throw new Error('Unexpected model request');
    return step(body, init?.signal);
  });
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch });
  const runner = new AnthropicRunner({ client, retryDelayMs: 0, ...options });
  let handler: ((message: string) => Promise<void>) | undefined;
  const progress: AgentProgress[] = [];
  const unregister = vi.fn();
  const controller = new AbortController();
  const req: RunRequest = {
    prompt: 'initial task',
    system: 'You are a test agent.',
    model: 'claude-test',
    tools: [],
    cwd: process.cwd(),
    isolated: false,
    signal: controller.signal,
    onUsage: vi.fn(),
    log: vi.fn(),
    onProgress: (value) => progress.push(value),
    registerMessageHandler: (value) => {
      handler = value;
      return unregister;
    },
  };
  return {
    runner,
    req,
    bodies,
    progress,
    unregister,
    controller,
    send(message: string) {
      if (!handler) throw new Error('Message handler not registered');
      return handler(message);
    },
  };
}

describe('Anthropic live control', () => {
  it('adds messages received during a model request in order before a fresh answer', async () => {
    let first!: Promise<void>;
    let second!: Promise<void>;
    const f = fixture([
      () => {
        first = f.send('Focus on security.');
        second = f.send('Include tests.');
        return reply([text('old answer')]);
      },
      () => reply([text('updated answer')]),
    ]);
    const result = await f.runner.run(f.req);
    await Promise.all([first, second]);
    expect(result).toMatchObject({ status: 'ok', result: 'updated answer', turns: 2 });
    expect(f.bodies[1].messages).toEqual([
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: [text('old answer')] },
      { role: 'user', content: 'Focus on security.' },
      { role: 'user', content: 'Include tests.' },
    ]);
    expect(f.unregister).toHaveBeenCalledOnce();
    await expect(f.send('too late')).rejects.toThrow('no longer accepting');
    expect(f.progress).toContainEqual({ activity: 'model', summary: 'Model response received', turns: 2 });
  });

  it('finishes an in-flight tool once and puts its result before the follow-up', async () => {
    let entered!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: (value: string) => void;
    const toolFinished = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const tool: ToolDef = {
      name: 'inspect',
      description: 'Inspect',
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: vi.fn(async () => {
        entered();
        return toolFinished;
      }),
    };
    const f = fixture([() => reply([toolUse('inspect')], 'tool_use'), () => reply([text('revised')])]);
    f.req.tools = [tool];
    const run = f.runner.run(f.req);
    await toolStarted;
    const delivered = vi.fn();
    const message = f.send('Inspect the timeout too.').then(delivered);
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();
    finish('tool result');
    expect(await run).toMatchObject({ status: 'ok', result: 'revised' });
    await message;
    expect(tool.run).toHaveBeenCalledOnce();
    expect(f.bodies[1].messages).toEqual([
      { role: 'user', content: 'initial task' },
      { role: 'assistant', content: [toolUse('inspect')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'tool result' }] },
      { role: 'user', content: 'Inspect the timeout too.' },
    ]);
    expect(f.progress).toContainEqual({
      activity: 'tool',
      summary: 'Running inspect',
      tool: 'inspect',
      turns: 1,
    });
    expect(f.progress).toContainEqual({
      activity: 'tool',
      summary: 'inspect completed',
      tool: 'inspect',
      turns: 1,
    });
    expect(JSON.stringify(f.progress)).not.toContain('tool result');
  });

  it('does not repeat a tool when live control is enabled but no message arrives', async () => {
    const tool: ToolDef = {
      name: 'inspect',
      description: 'Inspect',
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: vi.fn(async () => 'result'),
    };
    const f = fixture([() => reply([toolUse('inspect')], 'tool_use'), () => reply([text('done')])]);
    f.req.tools = [tool];
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: 'done' });
    expect(tool.run).toHaveBeenCalledOnce();
    expect(f.bodies).toHaveLength(2);
  });

  it('keeps completed tools and follow-ups through a transient request retry', async () => {
    let delivery!: Promise<void>;
    const tool: ToolDef = {
      name: 'inspect',
      description: 'Inspect',
      write: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: vi.fn(async () => {
        delivery = f.send('Check the retry.');
        return 'result';
      }),
    };
    const f = fixture([
      () => reply([toolUse('inspect')], 'tool_use'),
      () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
          {
            status: 503,
            headers: { 'content-type': 'application/json' },
          },
        ),
      () => reply([text('done')]),
    ]);
    f.req.tools = [tool];
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: 'done' });
    await delivery;
    expect(tool.run).toHaveBeenCalledOnce();
    expect(f.bodies[2].messages).toEqual(f.bodies[1].messages);
  });

  it('does not prepend an obsolete truncated answer after a follow-up', async () => {
    let delivery!: Promise<void>;
    const f = fixture([
      () => {
        delivery = f.send('Replace the previous answer.');
        return reply([text('obsolete prefix')], 'max_tokens');
      },
      () => reply([text('replacement')]),
    ]);
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: 'replacement' });
    await delivery;
    expect(f.bodies[1].messages.at(-1)).toEqual({ role: 'user', content: 'Replace the previous answer.' });
  });

  it.each(['two-stage', 'single-stage', 'submit-tool'] as const)(
    'does not accept a stale final result after steering in %s mode',
    async (structuredMode) => {
      const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
      let delivery!: Promise<void>;
      const old =
        structuredMode === 'submit-tool'
          ? reply([toolUse(SUBMIT_RESULT_TOOL_NAME, { answer: 'old' })], 'tool_use')
          : reply([text(structuredMode === 'single-stage' ? '{"answer":"old"}' : 'old')]);
      const updated = () =>
        structuredMode === 'submit-tool'
          ? reply([toolUse(SUBMIT_RESULT_TOOL_NAME, { answer: 'updated' })], 'tool_use')
          : reply([text(structuredMode === 'single-stage' ? '{"answer":"updated"}' : 'updated')]);
      const f = fixture(
        [
          () => {
            delivery = f.send('Revise the answer.');
            return old;
          },
          updated,
          ...(structuredMode === 'two-stage' ? [() => reply([text('{"answer":"updated"}')])] : []),
        ],
        { structuredMode },
      );
      f.req.schema = schema;
      expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: { answer: 'updated' } });
      await delivery;
      expect(f.bodies[1].messages.at(-1)).toEqual({ role: 'user', content: 'Revise the answer.' });
      if (structuredMode === 'submit-tool') {
        expect(f.bodies[1].messages.at(-2).content[0].type).toBe('tool_result');
      }
    },
  );

  it('rejects undeliverable messages at the turn cap rather than acknowledging them', async () => {
    let delivery!: Promise<void>;
    const f = fixture(
      [
        () => {
          delivery = f.send('another task');
          return reply([text('done')]);
        },
      ],
      { maxTurns: 1 },
    );
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: 'done', turns: 1 });
    await expect(delivery).rejects.toThrow('before the follow-up could be delivered');
    expect(f.bodies).toHaveLength(1);
  });

  it('rejects messages pending when an in-flight model request is aborted', async () => {
    let delivery!: Promise<void>;
    const f = fixture([
      (_body, signal) => {
        delivery = f.send('pending');
        f.controller.abort();
        expect(signal?.aborted).toBe(true);
        throw new Error('aborted');
      },
    ]);
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'skipped' });
    await expect(delivery).rejects.toThrow('before the follow-up could be delivered');
    expect(f.unregister).toHaveBeenCalledOnce();
  });

  it('delivers guidance queued before structured formatting and rejects guidance arriving after its final request', async () => {
    let before!: Promise<void>;
    let during!: Promise<void>;
    const f = fixture(
      [
        () => reply([text('findings')]),
        (body) => {
          expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Use the new label.' });
          during = f.send('too late for this response');
          return reply([text('{"answer":"new label"}')]);
        },
      ],
      { structuredMode: 'two-stage' },
    );
    f.req.schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    f.req.onProgress = (progress) => {
      if (progress.summary === 'Formatting structured result') before = f.send('Use the new label.');
    };
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'ok', result: { answer: 'new label' } });
    await before;
    await expect(during).rejects.toThrow('before the follow-up could be delivered');
  });

  it('rejects a pending message on API failure and never exposes reasoning as progress', async () => {
    let delivery!: Promise<void>;
    const f = fixture([
      () => {
        delivery = f.send('pending');
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }),
          {
            status: 401,
            headers: { 'content-type': 'application/json' },
          },
        );
      },
    ]);
    expect(await f.runner.run(f.req)).toMatchObject({ status: 'null' });
    await expect(delivery).rejects.toThrow('before the follow-up could be delivered');
    const success = fixture([
      () => reply([{ type: 'thinking', thinking: 'private reasoning', signature: 'test' }, text('done')]),
    ]);
    expect(await success.runner.run(success.req)).toMatchObject({ result: 'done' });
    expect(JSON.stringify(success.progress)).not.toContain('private reasoning');
  });
});
