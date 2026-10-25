// Observability consumers (spec 3.7): a progress tree fed by WorkflowEvents, and a terminal attachment
// that redraws it in place on a TTY or prints one line per agent_end / phase / log otherwise.

import type { EventEmitter } from 'node:events';
import type { EntryStatus, WorkflowEvent } from './types.js';

type AgentState = 'running' | EntryStatus | 'cached';

export const GLYPHS: Record<AgentState, string> = {
  running: '…',
  ok: '✓',
  null: '∅',
  skipped: '⤼',
  cached: '↺',
};

interface AgentRow {
  id: number;
  name: string;
  state: AgentState;
  outputTokens: number;
}

interface PhaseBox {
  title: string;
  agents: AgentRow[];
}

/** Phases of one script: the top run (group undefined) or a nested workflow ("▸ name"). */
interface Section {
  phases: Map<string, PhaseBox>;
}

type TopItem = { kind: 'phase'; box: PhaseBox } | { kind: 'group'; name: string; section: Section };

const NO_PHASE = '(no phase)';

export interface ProgressTreeOptions {
  /** Header name, e.g. the workflow's meta.name. Default: the runId of the first event. */
  name?: string;
  /** How many of the latest log lines to show above the tree. Default 8. */
  maxLogLines?: number;
}

export class ProgressTree {
  private name: string | undefined;
  private runId: string | undefined;
  private readonly maxLogLines: number;
  private readonly logs: string[] = [];
  private readonly items: TopItem[] = [];
  private readonly top: Section = { phases: new Map() };
  private readonly groups = new Map<string, Section>();
  private readonly agents = new Map<number, AgentRow>();
  private budget: { spent: number; total: number | null; remaining: number } | undefined;

  constructor(opts: ProgressTreeOptions = {}) {
    this.name = opts.name;
    this.maxLogLines = opts.maxLogLines ?? 8;
  }

  push(ev: WorkflowEvent): void {
    this.runId ??= ev.runId;
    switch (ev.type) {
      case 'phase':
        this.box(ev.group, ev.title);
        break;
      case 'log':
        this.logs.push(ev.group ? `[${ev.group}] ${ev.message}` : ev.message);
        break;
      case 'budget_tick':
        this.budget = { spent: ev.spent, total: ev.total, remaining: ev.remaining };
        break;
      case 'agent_start': {
        const row: AgentRow = {
          id: ev.id,
          name: ev.label ?? ev.key.slice(0, 12),
          state: 'running',
          outputTokens: 0,
        };
        this.agents.set(ev.id, row);
        this.box(ev.group, ev.phase ?? NO_PHASE).agents.push(row);
        break;
      }
      case 'agent_end': {
        let row = this.agents.get(ev.id);
        if (!row) {
          row = { id: ev.id, name: ev.label ?? ev.key.slice(0, 12), state: 'running', outputTokens: 0 };
          this.agents.set(ev.id, row);
          this.box(ev.group, ev.phase ?? NO_PHASE).agents.push(row);
        }
        row.state = ev.cached ? 'cached' : ev.status;
        row.outputTokens = ev.usage.output_tokens;
        break;
      }
    }
  }

  render(): string {
    const lines: string[] = [];
    lines.push(
      `maestro: ${this.name ?? this.runId ?? 'workflow'}${this.name && this.runId ? ` (${this.runId})` : ''}`,
    );
    lines.push(this.budgetLine());
    const logs = this.logs.slice(-this.maxLogLines);
    const hidden = this.logs.length - logs.length;
    if (hidden > 0) lines.push(`  · … ${hidden} earlier log line${hidden === 1 ? '' : 's'}`);
    for (const l of logs) lines.push(`  · ${l}`);
    for (const item of this.items) {
      if (item.kind === 'phase') this.renderBox(lines, item.box, '');
      else {
        lines.push(`▸ ${item.name}`);
        for (const box of item.section.phases.values()) this.renderBox(lines, box, '  ');
      }
    }
    return lines.join('\n');
  }

  /** Counts per state, for summaries. */
  counts(): Record<AgentState, number> {
    const out: Record<AgentState, number> = { running: 0, ok: 0, null: 0, skipped: 0, cached: 0 };
    for (const a of this.agents.values()) out[a.state]++;
    return out;
  }

  private budgetLine(): string {
    const b = this.budget;
    if (!b) return 'budget: 0 output tokens spent';
    if (b.total === null) return `budget: ${fmt(b.spent)} output tokens spent (no limit)`;
    return `budget: ${fmt(b.spent)} / ${fmt(b.total)} output tokens (${fmt(b.remaining)} left)`;
  }

  private renderBox(lines: string[], box: PhaseBox, indent: string): void {
    const c = box.agents.filter((a) => a.state !== 'running').length;
    lines.push(`${indent}${box.title}${box.agents.length ? ` [${c}/${box.agents.length}]` : ''}`);
    for (const a of box.agents) {
      const tok = a.state === 'running' ? '' : `  ${fmt(a.outputTokens)} tok`;
      lines.push(`${indent}  ${GLYPHS[a.state]} ${a.name}${tok}`);
    }
  }

  private box(group: string | undefined, title: string): PhaseBox {
    let section: Section;
    if (group === undefined) section = this.top;
    else {
      let g = this.groups.get(group);
      if (!g) {
        g = { phases: new Map() };
        this.groups.set(group, g);
        this.items.push({ kind: 'group', name: group, section: g });
      }
      section = g;
    }
    let box = section.phases.get(title);
    if (!box) {
      box = { title, agents: [] };
      section.phases.set(title, box);
      if (group === undefined) this.items.push({ kind: 'phase', box });
    }
    return box;
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  return Math.round(n).toLocaleString('en-US');
}

/** One line for the non-TTY stream, or null when the event is not printed. */
export function formatEventLine(ev: WorkflowEvent): string | null {
  const g = 'group' in ev && ev.group ? `▸ ${ev.group} ` : '';
  switch (ev.type) {
    case 'phase':
      return `${g}== ${ev.title}`;
    case 'log':
      return `${g}· ${ev.message}`;
    case 'agent_end': {
      const state: AgentState = ev.cached ? 'cached' : ev.status;
      const where = ev.phase ? `${ev.phase} / ` : '';
      return `${g}${GLYPHS[state]} ${where}${ev.label ?? ev.key.slice(0, 12)}  ${fmt(ev.usage.output_tokens)} tok`;
    }
    default:
      return null;
  }
}

export interface ProgressStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/**
 * Feeds a run's events to the terminal. TTY: redraws the tree in place (ANSI, throttled). Otherwise one
 * line per agent_end / phase / log. Returns detach(), which draws the final tree on a TTY.
 */
export function attachTerminalProgress(
  handle: { events: EventEmitter },
  stream: ProgressStream = process.stderr,
  opts: ProgressTreeOptions & { throttleMs?: number } = {},
): () => void {
  const tty = stream.isTTY === true;
  const tree = new ProgressTree(opts);
  let drawnLines = 0;
  let timer: NodeJS.Timeout | undefined;

  const draw = () => {
    timer = undefined;
    const text = tree.render();
    const clear = drawnLines > 0 ? `\x1b[${drawnLines}F\x1b[J` : '';
    stream.write(`${clear}${text}\n`);
    drawnLines = text.split('\n').length;
  };

  const onEvent = (ev: WorkflowEvent) => {
    tree.push(ev);
    if (tty) {
      timer ??= setTimeout(draw, opts.throttleMs ?? 50);
      timer.unref?.();
    } else {
      const line = formatEventLine(ev);
      if (line !== null) stream.write(`${line}\n`);
    }
  };
  handle.events.on('event', onEvent);
  return () => {
    handle.events.off('event', onEvent);
    if (tty) {
      if (timer) clearTimeout(timer);
      draw();
    }
  };
}
