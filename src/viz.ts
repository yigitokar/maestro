// `maestro viz`: a browser view of one run, built from <runDir>/events.jsonl (when) and the journal
// (what came back). serveViz() serves a page that polls the files, so it follows a run that another
// process (an MCP server, a terminal `maestro run`) is executing; exportVizHtml() writes the same page
// as one self-contained file with the data embedded. The server binds to 127.0.0.1 only.

import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type EventLogLine, readEventLines } from './event-log.js';
import { readEntries, readResultBlob, readTrace } from './journal.js';
import type { Entry, EntryStatus, Trace, Usage } from './types.js';
import { vizPage } from './viz-page.js';
import { vizWidget, widgetModel } from './viz-widget.js';
import { OUTCOME_FILE, type PersistedOutcome, readOutcome } from './workflow.js';

export { readEventLines } from './event-log.js';

/** A journal row without its result, for the timeline (sent on every poll, so kept small). */
export interface VizEntrySummary {
  index: number;
  key: string;
  label?: string;
  phase?: string;
  status: EntryStatus;
  usage: Usage;
  error?: string;
}

/** What the detail panel shows for one agent. */
export interface VizEntryDetail extends VizEntrySummary {
  /** Pretty JSON of the result, cut at VIZ_RESULT_CHARS. */
  result: string;
  resultTruncated: boolean;
  raw?: string;
  trace?: Trace;
  worktree?: { path: string; diffStat: string };
}

export interface VizSnapshot {
  runId: string;
  /** Event lines from byte `from` on. */
  lines: EventLogLine[];
  /** Byte offset to ask for next time (end of the last complete line). */
  offset: number;
  entries: VizEntrySummary[];
  /** Settled outcome from `<runDir>/outcome.json`; left out when the caller already has this version. */
  outcome?: PersistedOutcome;
  /** Identifies the outcome file as it is now (absent: no outcome). A poll sends back the one it has. */
  outcomeVersion?: string;
  /** Server clock, so a live page measures running agents against the same clock that wrote `t`. */
  now: number;
}

/** Result text kept per agent in the detail panel and in an exported file. */
export const VIZ_RESULT_CHARS = 20_000;

function summary(row: Entry): VizEntrySummary {
  const s: VizEntrySummary = { index: row.index, key: row.key, status: row.status, usage: row.usage };
  if (row.label !== undefined) s.label = row.label;
  if (row.phase !== undefined) s.phase = row.phase;
  if (row.error !== undefined) s.error = row.error;
  return s;
}

/** Journal rows per run dir, kept while the file's size and mtime stay the same (it is append-only). */
const rowCache = new Map<string, { size: number; mtimeMs: number; rows: Entry[] }>();

async function readRows(runDir: string): Promise<Entry[]> {
  try {
    const { size, mtimeMs } = await stat(join(runDir, 'journal.jsonl'));
    const hit = rowCache.get(runDir);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.rows;
    const rows = await readEntries(runDir);
    rowCache.set(runDir, { size, mtimeMs, rows });
    return rows;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Size and mtime of outcome.json: changes when a resume removes it or a new end rewrites it. */
async function outcomeVersionOf(runDir: string): Promise<string | undefined> {
  try {
    const st = await stat(join(runDir, OUTCOME_FILE));
    return `${st.size}-${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * `haveOutcome` is the outcomeVersion the caller already holds: the outcome (a run's whole result) is
 * then read and sent only when the file changed, not on every poll.
 */
export async function readSnapshot(
  runDir: string,
  runId: string,
  from = 0,
  haveOutcome?: string,
): Promise<VizSnapshot> {
  const [{ lines, offset }, rows, version] = await Promise.all([
    readEventLines(runDir, from),
    readRows(runDir),
    outcomeVersionOf(runDir),
  ]);
  const outcome = version !== undefined && version !== haveOutcome ? await readOutcome(runDir) : undefined;
  return {
    runId,
    lines,
    offset,
    entries: rows.map(summary),
    ...(outcome !== undefined ? { outcome } : {}),
    // An unreadable file has no version, so the next poll tries it again.
    ...(version !== undefined && (outcome !== undefined || version === haveOutcome)
      ? { outcomeVersion: version }
      : {}),
    now: Date.now(),
  };
}

/**
 * The row behind an agent. A key re-run on resume has several rows: `nth` picks the nth row (0-based)
 * with this key and status, which is the row the nth live agent_end with that key and status wrote.
 * Without `nth`, or when there is no such row, the last row with the key, preferring the status.
 */
function pickRow(rows: Entry[], key: string, status?: string, nth?: number): Entry | undefined {
  let any: Entry | undefined;
  let matching: Entry | undefined;
  let seen = 0;
  for (const row of rows) {
    if (row.key !== key) continue;
    any = row;
    if (status === undefined || row.status === status) {
      matching = row;
      if (status !== undefined && nth === seen++) return row;
    }
  }
  return matching ?? any;
}

async function detail(runDir: string, row: Entry): Promise<VizEntryDetail> {
  let result: unknown = row.result;
  if (row.blob === true) {
    try {
      result = await readResultBlob(runDir, row.key);
    } catch {
      result = '(result blob unreadable)';
    }
  }
  const json = (typeof result === 'string' ? result : JSON.stringify(result, null, 2)) ?? 'null';
  const d: VizEntryDetail = {
    ...summary(row),
    result: json.length > VIZ_RESULT_CHARS ? json.slice(0, VIZ_RESULT_CHARS) : json,
    resultTruncated: json.length > VIZ_RESULT_CHARS,
  };
  if (row.raw !== undefined) d.raw = row.raw.slice(0, VIZ_RESULT_CHARS);
  const trace = await readTrace(runDir, row);
  if (trace) d.trace = trace;
  if (row.worktree) d.worktree = row.worktree;
  return d;
}

export async function readEntryDetail(
  runDir: string,
  key: string,
  status?: string,
  nth?: number,
): Promise<VizEntryDetail | undefined> {
  const row = pickRow(await readRows(runDir), key, status, nth);
  return row ? detail(runDir, row) : undefined;
}

/** The page as one file: every event line, every row and every row's detail embedded. */
export async function exportVizHtml(runDir: string, runId: string): Promise<string> {
  const snapshot = await readSnapshot(runDir, runId);
  const rows = await readRows(runDir);
  const details: Record<string, VizEntryDetail> = {};
  // Three names per row, as pickRow resolves them: "key|status|nth" for the attempt that wrote it, and
  // "key|status" and "key" for the last such row.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const name = `${row.key}|${row.status}`;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    details[name] = await detail(runDir, row);
    details[`${name}|${n}`] = details[name];
  }
  for (const row of rows) details[row.key] = details[`${row.key}|${row.status}`]!;
  return vizPage({ mode: 'static', runId, snapshot, details });
}

/** The latest attempt as a fragment for a chat host's inline widget tool (see viz-widget.ts). */
export async function exportVizWidget(runDir: string, runId: string): Promise<string> {
  const snapshot = await readSnapshot(runDir, runId);
  const previews: Record<string, { result: string; error?: string }> = {};
  for (const row of await readRows(runDir)) {
    const d = await detail(runDir, row);
    const v = {
      result: row.status === 'ok' ? d.result : '',
      ...(d.error !== undefined ? { error: d.error } : {}),
    };
    previews[`${row.key}|${row.status}`] = v;
    previews[row.key] = v;
  }
  return vizWidget(widgetModel(snapshot, previews));
}

export interface VizServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const STATUSES = new Set(['ok', 'null', 'skipped']);

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** Serves the live page for one run until close(). Port 0 (default) picks a free one. */
export async function serveViz(opts: {
  runDir: string;
  runId: string;
  port?: number;
  host?: string;
}): Promise<VizServer> {
  const { runDir, runId } = opts;
  const host = opts.host ?? '127.0.0.1';
  const page = vizPage({ mode: 'live', runId });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page);
    if (url.pathname === '/api/poll') {
      const from = Number(url.searchParams.get('from') ?? '0');
      const snap = await readSnapshot(
        runDir,
        runId,
        Number.isSafeInteger(from) && from > 0 ? from : 0,
        url.searchParams.get('outcome') ?? undefined,
      );
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snap));
    }
    if (url.pathname === '/api/entry') {
      const key = url.searchParams.get('key') ?? '';
      const status = url.searchParams.get('status') ?? undefined;
      if (!KEY.test(key) || (status !== undefined && !STATUSES.has(status)))
        return send(res, 400, 'text/plain; charset=utf-8', 'bad key');
      const nthParam = url.searchParams.get('nth');
      const nth = nthParam !== null && /^\d{1,6}$/.test(nthParam) ? Number(nthParam) : undefined;
      const d = await readEntryDetail(runDir, key, status, nth);
      if (!d) return send(res, 404, 'text/plain; charset=utf-8', 'no row yet');
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(d));
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  };
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      send(res, 500, 'text/plain; charset=utf-8', err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
