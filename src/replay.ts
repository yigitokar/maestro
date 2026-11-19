// Time-travel replay (`maestro replay <runId> --from <node>` & MCP `WorkflowReplay`).
// Forks a previous run's upstream `'ok'` journal entries (and their blobs) into a brand-new runId,
// invalidating the target node and everything at/after it in execution order while leaving the
// original run directory completely untouched for diffing and audit.

import { existsSync } from 'node:fs';
import { copyFile, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import type { EventLogLine } from './event-log.js';
import { blobFileName, readEntries, resolveBlobFile } from './journal.js';
import type { Entry } from './types.js';
import { readEventLines } from './viz.js';

export interface ReplaySpec {
  /** Source runId whose upstream `'ok'` journal rows seed the new run (source run is never mutated). */
  runId: string;
  /**
   * Node selector to start live re-execution from: exact `label`, `#<index>` / `<index>`,
   * `phase:<title>`, or key prefix. When omitted, all `'ok'` rows are forked into the new run.
   */
  from?: string;
}

export interface TimelineNode {
  pos: number;
  id: number;
  key: string;
  label?: string;
  phase?: string;
  group?: string;
}

export interface ReplaySeed {
  sourceRunId: string;
  sourceRunDir: string;
  from?: string;
  /** Matched target node when `from` was specified. */
  target?: TimelineNode;
  /** Ordered `'ok'` journal rows copied into the forked run's journal. */
  seededRows: Entry[];
  /** Number of source timeline nodes invalidated (target + downstream). */
  invalidatedCount: number;
}

/**
 * Reconstructs the ordered agent execution sequence of the source run's latest attempt.
 * Prefers `events.jsonl` (exact last-attempt call order including cache hits), falling back
 * to deduplicated `journal.jsonl` rows when no event log exists.
 */
export function buildTimeline(rows: Entry[], events: EventLogLine[]): TimelineNode[] {
  let lastStartIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'run_start') {
      lastStartIdx = i;
      break;
    }
  }
  const fromEvents: TimelineNode[] = [];
  if (lastStartIdx >= 0) {
    for (let i = lastStartIdx + 1; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.type === 'agent_start') {
        fromEvents.push({
          pos: fromEvents.length,
          id: ev.id,
          key: ev.key,
          ...(ev.label !== undefined ? { label: ev.label } : {}),
          ...(ev.phase !== undefined ? { phase: ev.phase } : {}),
          ...(ev.group !== undefined ? { group: ev.group } : {}),
        });
      }
    }
  }
  if (fromEvents.length > 0) return fromEvents;

  // Fallback when events.jsonl is absent or has no agent_start lines: latest row per key in journal order.
  const byKey = new Map<string, Entry>();
  const order: string[] = [];
  for (const row of rows) {
    if (!byKey.has(row.key)) order.push(row.key);
    byKey.set(row.key, row);
  }
  return order.map((key, pos) => {
    const row = byKey.get(key)!;
    return {
      pos,
      id: row.index,
      key: row.key,
      ...(row.label !== undefined ? { label: row.label } : {}),
      ...(row.phase !== undefined ? { phase: row.phase } : {}),
    };
  });
}

/**
 * Resolves a `--from <node>` selector against a run's execution timeline.
 * Resolution order: `phase:<title>`, exact `label`, `#<index>` / `<index>`, key prefix.
 */
export function resolveReplayTarget(timeline: TimelineNode[], selector: string): TimelineNode | undefined {
  const trimmed = selector.trim();
  if (!trimmed) return undefined;

  if (/^phase:/i.test(trimmed)) {
    const wanted = trimmed.slice(6).trim();
    if (!wanted) return undefined;
    const exact = timeline.find((n) => n.phase === wanted);
    if (exact) return exact;
    const lower = wanted.toLowerCase();
    return timeline.find((n) => n.phase?.toLowerCase() === lower);
  }

  function uniqueMatch(matches: TimelineNode[]): TimelineNode | undefined {
    if (matches.length > 1) {
      const indices = matches.map((node) => `#${node.id}`).join(', ');
      throw new Error(`replay: node "${trimmed}" is ambiguous. Pass one of ${indices} with --from.`);
    }
    return matches[0];
  }

  const byLabel = uniqueMatch(timeline.filter((n) => n.label === trimmed));
  if (byLabel) return byLabel;

  if (/^#?\d+$/.test(trimmed)) {
    const idx = Number(trimmed.startsWith('#') ? trimmed.slice(1) : trimmed);
    const byId = timeline.find((n) => n.id === idx);
    if (byId) return byId;
  }

  return uniqueMatch(timeline.filter((n) => n.key.startsWith(trimmed)));
}

function describeAvailableNodes(timeline: TimelineNode[]): string {
  if (timeline.length === 0) return '(run has no recorded agents)';
  const sample = timeline
    .slice(0, 12)
    .map((n) => (n.label ? `${n.label} (#${n.id})` : `#${n.id} (${n.key.slice(0, 10)})`));
  const suffix = timeline.length > 12 ? `, +${timeline.length - 12} more` : '';
  return `available: ${sample.join(', ')}${suffix}`;
}

/**
 * Computes which `'ok'` journal rows from `sourceRunDir` should seed a forked replay run.
 * Pure read — makes no filesystem mutations, so an invalid `--from` fails cleanly before
 * the new run directory is created.
 */
export async function prepareReplaySeed(
  sourceRunDir: string,
  sourceRunId: string,
  from?: string,
): Promise<ReplaySeed> {
  if (!existsSync(sourceRunDir)) {
    throw new Error(`no run ${sourceRunId} under ${path.dirname(sourceRunDir)}`);
  }
  const [rows, { lines: events }] = await Promise.all([
    readEntries(sourceRunDir).catch(() => [] as Entry[]),
    readEventLines(sourceRunDir),
  ]);

  const latestOk = new Map<string, Entry>();
  for (const row of rows) {
    if (row.status === 'ok') latestOk.set(row.key, row);
  }

  const timeline = buildTimeline(rows, events);
  let cutPos = timeline.length;
  let target: TimelineNode | undefined;
  const trimmedFrom = from?.trim();
  if (trimmedFrom !== undefined && trimmedFrom !== '') {
    target = resolveReplayTarget(timeline, trimmedFrom);
    if (!target) {
      throw new Error(
        `replay: node "${trimmedFrom}" not found in run ${sourceRunId} (${describeAvailableNodes(timeline)})`,
      );
    }
    cutPos = target.pos;
  }

  const invalidatedKeys = new Set(timeline.slice(cutPos).map((n) => n.key));
  const seededRows: Entry[] = [];
  const seen = new Set<string>();
  for (const node of timeline.slice(0, cutPos)) {
    if (invalidatedKeys.has(node.key) || seen.has(node.key)) continue;
    const okRow = latestOk.get(node.key);
    if (!okRow) continue;
    seen.add(node.key);
    seededRows.push(structuredClone(okRow));
  }

  return {
    sourceRunId,
    sourceRunDir,
    ...(trimmedFrom ? { from: trimmedFrom } : {}),
    ...(target ? { target } : {}),
    seededRows,
    invalidatedCount: Math.max(0, timeline.length - cutPos),
  };
}

/**
 * Materializes the forked upstream cache into `targetRunDir` (`journal.jsonl` + referenced blobs)
 * before `Journal.open(targetRunDir)` runs. Does not touch `seed.sourceRunDir`.
 */
export async function writeReplaySeed(targetRunDir: string, seed: ReplaySeed): Promise<void> {
  const srcBlobs = path.join(seed.sourceRunDir, 'blobs');
  const dstBlobs = path.join(targetRunDir, 'blobs');
  await mkdir(dstBlobs, { recursive: true });

  for (const row of seed.seededRows) {
    if (row.blob === true) {
      const src = resolveBlobFile(srcBlobs, row.key, '.json');
      if (existsSync(src)) {
        await copyFile(src, path.join(dstBlobs, blobFileName(row.key, '.json')));
      }
    }
    if (row.traceBlob === true) {
      const src = resolveBlobFile(srcBlobs, row.key, '.trace.json');
      if (existsSync(src)) {
        await copyFile(src, path.join(dstBlobs, blobFileName(row.key, '.trace.json')));
      }
    }
  }

  if (seed.seededRows.length === 0) return;
  const lines = seed.seededRows.map((row) =>
    JSON.stringify({ ...row, cachedFrom: row.cachedFrom ?? seed.sourceRunId }),
  );
  const fh = await open(path.join(targetRunDir, 'journal.jsonl'), 'w');
  try {
    await fh.writeFile(`${lines.join('\n')}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
}
