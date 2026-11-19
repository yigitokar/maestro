import { setImmediate as nextTick } from 'node:timers/promises';
import { readEventLines } from './event-log.js';
import { readEntries, readResultBlob, readTrace } from './journal.js';
import type { Entry } from './types.js';

export interface ReplayFrom {
  runId: string;
  /** Invocation ID (0 or #0), unique label, or full journal key from the source attempt. */
  from: string;
}

interface Node {
  id: number;
  key: string;
  label?: string;
  status?: Entry['status'];
}

/** The journal can span several resumes. The latest attempt's events identify which nodes it called,
 * including cache hits (which never append a resume row) and calls whose runner failed to start. */
export async function loadReplay(sourceDir: string, from: string) {
  const [entries, { lines }] = await Promise.all([readEntries(sourceDir), readEventLines(sourceDir)]);
  const nodes: Node[] = [];
  let completions: string[];
  const start = lines.findLastIndex((line) => line.type === 'run_start');
  const settings = lines[start];
  if (lines.length > 0) {
    const attempt = lines.slice(start + 1);
    completions = attempt.flatMap((line) => (line.type === 'agent_end' ? [line.key] : []));
    const statuses = new Map(
      attempt.flatMap((line) => (line.type === 'agent_end' ? [[line.id, line.status] as const] : [])),
    );
    for (const e of attempt) {
      if (e.type === 'agent_start')
        nodes.push({ id: e.id, key: e.key, label: e.label, status: statuses.get(e.id) });
    }
  } else {
    completions = entries.map((row) => row.key);
    // Historical single-attempt runs may only have a journal. Reject ambiguous IDs below.
    for (const row of entries)
      nodes.push({ id: row.index, key: row.key, label: row.label, status: row.status });
  }
  const ordered = nodes.sort((a, b) => a.id - b.id);
  const ordinal = /^#?\d+$/.test(from);
  const matches = ordered.filter((node) =>
    ordinal ? node.id === Number(from.replace('#', '')) : node.label === from || node.key === from,
  );
  if (!from || !matches.length) throw new Error(`no replay node "${from}" in the source attempt`);
  if (matches.length > 1) {
    throw new Error(
      `ambiguous replay node "${from}" (matches ${matches.map((n) => `#${n.id}`).join(', ')}); select a unique ID`,
    );
  }
  const target = matches[0]!;
  const prefix = ordered.filter((node) => node.id < target.id);
  if (
    ordered[target.id] !== target ||
    ordered[target.id + 1]?.id === target.id ||
    prefix.some((node, i) => node.id !== i)
  ) {
    throw new Error('cannot establish replay order from the source run: missing or ambiguous invocation IDs');
  }
  const ok = new Map(entries.filter((row) => row.status === 'ok').map((row) => [row.key, row]));
  const upstream = new Map<string, Entry>();
  for (const node of prefix) {
    const row = ok.get(node.key);
    if (!row || (node.status !== undefined && node.status !== 'ok') || !/^[a-f0-9]{64}:\d+$/.test(node.key)) {
      throw new Error(
        `no successful upstream cache for #${node.id} (${node.label ?? node.key}); replay from that node or earlier`,
      );
    }
    upstream.set(node.key, row);
  }
  // A fast branch can issue the selected call before its slower siblings. Releasing cached values
  // in start order would give a sibling that invocation ID even with a byte-identical script.
  const rank = new Map(completions.map((key, index) => [key, index]));
  const pending: Array<{ order: number; restore: () => Promise<void> }> = [];
  let restoring = false;
  async function restorePending() {
    if (restoring) return;
    restoring = true;
    while (pending.length) {
      // Let continuations of the previous result enqueue their next call before choosing a sibling.
      await nextTick();
      pending.sort((a, b) => b.order - a.order);
      await pending.pop()!.restore();
    }
    restoring = false;
  }

  let reached = false;
  return {
    settings: settings?.type === 'run_start' ? settings : undefined,
    /** Called before admitting any live work. An edit before the boundary must never charge a cache miss. */
    lookup(id: number, key: string, label: string | undefined): Entry | undefined {
      if (id < target.id) {
        const row = upstream.get(key);
        if (!row)
          throw new Error(
            `upstream node #${id} (${label ?? key}) changed; replay from the changed node or earlier`,
          );
        upstream.delete(key);
        return row;
      }
      if (id === target.id) {
        if (!ordinal && (target.key === from ? key !== from : label !== from)) {
          throw new Error(`replay expected "${from}" at #${id}, encountered "${label ?? key}"`);
        }
        reached = true;
      }
      return undefined;
    },
    restore<T>(row: Entry, task: () => Promise<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        pending.push({
          order: rank.get(row.key) ?? Number.MAX_SAFE_INTEGER,
          restore: async () => {
            try {
              resolve(await task());
            } catch (error) {
              reject(error);
            }
          },
        });
        void restorePending();
      });
    },
    assertReached() {
      if (!reached) throw new Error(`workflow ended before reaching replay node "${from}" (#${target.id})`);
    },
  };
}

/** Materialize a source row in the child run. Both result and trace blobs must survive source removal. */
export async function materializeReplayEntry(sourceDir: string, row: Entry): Promise<Entry> {
  const { blob, traceBlob, ...copy } = row;
  if (blob) {
    try {
      copy.result = await readResultBlob(sourceDir, row.key);
    } catch {
      throw new Error(`upstream cache result blob unreadable for ${row.key}`);
    }
  }
  if (traceBlob) copy.trace = await readTrace(sourceDir, row);
  return copy;
}
