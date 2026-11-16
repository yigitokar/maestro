import type { AgentMessageReceipt, AgentProgress, Entry, LiveAgentStatus, Usage } from './types.js';
import { addUsage } from './usage.js';

export const MAX_AGENT_MESSAGE_CHARS = 16_000;
export const MAX_AGENT_MESSAGES = 32;
const SUMMARY_CHARS = 300;

/** One agent's bounded control state. Never waits for a backend when accepting a message. */
export class AgentControl {
  private handler?: (message: string) => Promise<void>;
  private closed = false;
  private readonly audit: NonNullable<Entry['messages']> = [];
  private readonly state: LiveAgentStatus;

  constructor(
    identity: Pick<LiveAgentStatus, 'id' | 'label' | 'phase' | 'group'>,
    private readonly signal: AbortSignal,
    private readonly changed: (agent: LiveAgentStatus) => void,
    private readonly messageChanged: (message: NonNullable<Entry['messages']>[number]) => void,
  ) {
    const now = Date.now();
    this.state = {
      ...identity,
      state: 'queued',
      startedAt: now,
      updatedAt: now,
      elapsedMs: 0,
      turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      canMessage: false,
      messages: [],
    };
    signal.addEventListener('abort', this.abort, { once: true });
  }

  private readonly abort = () => {
    void this.finish('Agent was stopped before the message was delivered');
  };

  snapshot(): LiveAgentStatus {
    return {
      ...this.state,
      elapsedMs: Math.max(0, Date.now() - this.state.startedAt),
      usage: { ...this.state.usage },
      ...(this.state.progress ? { progress: { ...this.state.progress } } : {}),
      messages: this.audit.map(({ text: _text, ...receipt }) => ({ ...receipt })),
      canMessage: !this.closed && !this.signal.aborted && this.handler !== undefined,
    };
  }

  private update(): void {
    this.state.updatedAt = Date.now();
    this.changed(this.snapshot());
  }

  running(): void {
    this.state.state = 'running';
    this.state.runningAt = Date.now();
    this.update();
  }

  progress(progress: AgentProgress): void {
    if (this.closed) return;
    this.state.progress = {
      activity: progress.activity,
      summary: progress.summary.slice(0, SUMMARY_CHARS),
      ...(progress.tool ? { tool: progress.tool.slice(0, 100) } : {}),
    };
    if (progress.turns !== undefined && Number.isFinite(progress.turns)) {
      this.state.turns = Math.max(this.state.turns, Math.max(0, Math.floor(progress.turns)));
    }
    this.update();
  }

  usage(usage: Usage): void {
    if (this.closed) return;
    addUsage(this.state.usage, usage);
    this.update();
  }

  register(handler: (message: string) => Promise<void>): () => void {
    if (this.closed || this.signal.aborted) return () => {};
    if (this.handler) throw new Error('Agent already has a message handler');
    this.handler = handler;
    this.update();
    return () => {
      if (this.handler !== handler) return;
      this.handler = undefined;
      this.update();
    };
  }

  send(text: string): AgentMessageReceipt | null {
    if (typeof text !== 'string' || text.trim() === '') throw new Error('message must be a non-empty string');
    if (text.length > MAX_AGENT_MESSAGE_CHARS)
      throw new Error(`message exceeds ${MAX_AGENT_MESSAGE_CHARS} characters`);
    if (this.closed || this.signal.aborted || !this.handler) return null;
    if (this.audit.length >= MAX_AGENT_MESSAGES)
      throw new Error(`agent message limit is ${MAX_AGENT_MESSAGES}`);
    const item: NonNullable<Entry['messages']>[number] = {
      id: this.audit.length,
      text,
      status: 'queued',
      queuedAt: Date.now(),
    };
    this.audit.push(item);
    this.messageChanged({ ...item });
    this.update();
    const handler = this.handler;
    // Catch synchronous custom-runner throws too; no rejected delivery promise escapes the host.
    void Promise.resolve()
      .then(() => {
        if (this.closed || this.signal.aborted || this.handler !== handler) {
          throw new Error('Agent stopped accepting messages before delivery');
        }
        return handler(text);
      })
      .then(
        () => this.settleMessage(item, undefined),
        () =>
          this.settleMessage(
            item,
            'Runner did not accept the message before the agent finished or delivery failed',
          ),
      );
    const { text: _text, ...receipt } = item;
    return { ...receipt };
  }

  private settleMessage(item: NonNullable<Entry['messages']>[number], error: string | undefined): void {
    if (item.status !== 'queued') return;
    if (error !== undefined) {
      item.status = 'failed';
      item.error = error;
    } else {
      item.status = 'delivered';
      item.deliveredAt = Date.now();
    }
    this.messageChanged({ ...item });
    this.update();
  }

  private failPending(reason: string): void {
    for (const item of this.audit) this.settleMessage(item, reason);
  }

  close(reason = 'Agent finished before the message was delivered'): void {
    if (this.closed) return;
    this.closed = true;
    this.handler = undefined;
    this.signal.removeEventListener('abort', this.abort);
    this.failPending(reason);
    this.update();
  }

  async finish(reason?: string): Promise<void> {
    this.handler = undefined;
    // An RPC acknowledgement and completion may arrive in the same I/O batch. Let already
    // resolved handler promises settle before marking genuinely undelivered messages failed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.close(reason);
  }

  messages(): Entry['messages'] {
    return this.audit.length ? this.audit.map((item) => ({ ...item })) : undefined;
  }
}
