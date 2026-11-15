// Journal: content-addressed, fsync'd append-only log of agent() calls (spec 3.1, ADR-4).
// One Entry per line in <runDir>/journal.jsonl; results above 64 KB live in <runDir>/blobs/<key>.json.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { access, constants, type FileHandle, mkdir, open, readFile, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOpts, Entry, Trace } from './types.js';
import { LIMITS, MaestroError } from './types.js';

/** Deterministic JSON: object keys sorted recursively, otherwise JSON.stringify semantics. */
export function canonicalJSON(value: unknown): string {
  const out = serialize(value, '', new Set());
  // Top-level undefined/function/symbol: JSON.stringify returns undefined; keep the return type a string.
  return out ?? 'null';
}

function serialize(value: unknown, key: string, stack: Set<object>): string | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON(k: string): unknown }).toJSON(key);
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJSON: BigInt value cannot be serialized');
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
  }
  if (value === null) return 'null';
  const obj = value as object;
  // Boxed primitives behave like JSON.stringify, including ones from another realm (script opts come
  // from the vm context, where host `instanceof` is false).
  const unboxed = unbox(obj);
  if (unboxed !== NOT_BOXED) return serialize(unboxed, key, stack);
  if (stack.has(obj)) throw new TypeError('canonicalJSON: circular structure');
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      // Index loop, not map: map skips holes, while JSON.stringify writes them as null.
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) items.push(serialize(obj[i], String(i), stack) ?? 'null');
      return `[${items.join(',')}]`;
    }
    const record = obj as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of Object.keys(record).sort()) {
      const v = serialize(record[k], k, stack);
      if (v !== undefined) parts.push(`${JSON.stringify(k)}:${v}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(obj);
  }
}

const NOT_BOXED: unique symbol = Symbol('not boxed');

/** Detects boxed primitives by internal slot (realm-independent), unboxing them like JSON.stringify. */
function unbox(obj: object): unknown {
  if (hasSlot(Number.prototype.valueOf, obj)) return Number(obj);
  if (hasSlot(String.prototype.valueOf, obj)) return String(obj);
  if (hasSlot(Boolean.prototype.valueOf, obj)) return Boolean.prototype.valueOf.call(obj);
  return NOT_BOXED;
}

function hasSlot(thisValueOf: () => unknown, obj: object): boolean {
  try {
    thisValueOf.call(obj);
    return true;
  } catch {
    return false;
  }
}

/** Matches an unpaired surrogate (with the u flag a valid pair is one code point, not \p{Cs}). */
const LONE_SURROGATE = /\p{Cs}/u;

/** sha256(prompt + "\n" + canonicalJSON(opts without label/phase)); label/phase never affect the key (spec 3.1). */
export function hashCall(prompt: string, opts?: AgentOpts): string {
  const { label: _label, phase: _phase, ...rest } = opts ?? {};
  const text = `${prompt}\n${canonicalJSON(rest)}`;
  const h = createHash('sha256');
  if (LONE_SURROGATE.test(text)) {
    // UTF-8 would turn every lone surrogate into U+FFFD, so distinct prompts would share a key
    // (silent wrong cache, spec 3.1). Hash the UTF-16 code units losslessly instead, behind a 0xFF
    // prefix byte that never occurs in UTF-8, so these inputs cannot collide with well-formed ones.
    h.update(Buffer.from([0xff]));
    h.update(Buffer.from(text, 'utf16le'));
  } else {
    h.update(text);
  }
  return h.digest('hex');
}

export function makeKey(hash: string, n: number): string {
  return `${hash}:${n}`;
}

/**
 * Blob filename for `key`: POSIX keeps `<hash>:<n><ext>`, while Windows (`win32`) turns `:` into `-`
 * because NTFS rejects colons as alternate data stream separators.
 */
export function blobFileName(
  key: string,
  ext = '.json',
  platform: NodeJS.Platform = process.platform,
): string {
  return `${platform === 'win32' ? key.replaceAll(':', '-') : key}${ext}`;
}

/**
 * Resolves a blob path on disk, falling back to the other OS's filename convention so a `.maestro`
 * directory copied between POSIX and Windows remains readable without migration.
 */
export function resolveBlobFile(
  blobDir: string,
  key: string,
  ext = '.json',
  platform: NodeJS.Platform = process.platform,
): string {
  const primary = join(blobDir, blobFileName(key, ext, platform));
  if (existsSync(primary)) return primary;
  const alt = join(blobDir, blobFileName(key, ext, platform === 'win32' ? 'linux' : 'win32'));
  if (alt !== primary && existsSync(alt)) return alt;
  return primary;
}

/** Per-execution occurrence counter: n is never derived from journal rows (spec Seviye 2 adım 1). */
export class Occurrences {
  private readonly counts = new Map<string, number>();

  next(hash: string): number {
    const n = this.counts.get(hash) ?? 0;
    this.counts.set(hash, n + 1);
    return n;
  }
}

const STATUSES = new Set(['ok', 'null', 'skipped']);

function isEntryRow(v: unknown): v is Entry {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.key === 'string' && typeof r.status === 'string' && STATUSES.has(r.status);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Journal {
  readonly path: string;
  private readonly blobDir: string;
  private readonly log: (m: string) => void;
  private readonly rows: Entry[];
  private readonly latestOk = new Map<string, Entry>();
  /** Byte length of the known-good prefix of journal.jsonl. */
  private size: number;
  private fh: FileHandle | null;
  private chain: Promise<void> = Promise.resolve();

  private constructor(
    path: string,
    blobDir: string,
    fh: FileHandle,
    rows: Entry[],
    size: number,
    log: (m: string) => void,
  ) {
    this.path = path;
    this.blobDir = blobDir;
    this.fh = fh;
    this.rows = rows;
    this.size = size;
    this.log = log;
    for (const row of rows) this.index(row);
  }

  static async open(runDir: string, opts?: { log?: (m: string) => void }): Promise<Journal> {
    const log = opts?.log ?? (() => {});
    const path = join(runDir, 'journal.jsonl');
    const blobDir = join(runDir, 'blobs');
    try {
      await mkdir(runDir, { recursive: true });
      await mkdir(blobDir, { recursive: true });
      await access(blobDir, constants.W_OK);

      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        data = Buffer.alloc(0);
      }

      const { rows, goodBytes, bad } = scan(data);
      if (bad) {
        // spec 3.1: a torn/corrupt line and everything after it is ignored and logged; truncate so later
        // appends do not glue onto garbage.
        log(
          `journal: corrupt or torn line ${bad.line} in ${path}; ignoring it and everything after ` +
            `(${data.length - goodBytes} bytes dropped)`,
        );
        await truncate(path, goodBytes);
      }

      const fh = await open(path, 'a');
      return new Journal(path, blobDir, fh, rows, goodBytes, log);
    } catch (err) {
      // spec 3.1: if the journal cannot be written the run must not start.
      throw new MaestroError(`journal unwritable at ${path}: ${describe(err)}`, 'journal_unwritable');
    }
  }

  /** Latest row with status 'ok' for key, blob resolved; null/skipped rows are never cache hits (spec 3.1). */
  get(key: string): Entry | undefined {
    const row = this.latestOk.get(key);
    if (!row) return undefined;
    // A deep copy: the caller's edits to a result must not reach the row later reads are served from.
    if (row.blob !== true) return structuredClone(row);
    const blobPath = resolveBlobFile(this.blobDir, key, '.json');
    let result: unknown;
    try {
      result = JSON.parse(readFileSync(blobPath, 'utf8'));
    } catch (err) {
      // spec 3.1: missing blob → the row counts as null and is logged; the run continues.
      this.log(`journal: blob for ${key} unreadable at ${blobPath} (${describe(err)}); treating row as null`);
      return undefined;
    }
    const { blob: _blob, ...rest } = row;
    return { ...rest, result };
  }

  /** Serialized, fsync'd append; resolves only after the row is on disk (spec 3.1, Seviye 2 adım 7). */
  append(entry: Entry): Promise<void> {
    const run = this.chain.then(() => this.write(entry));
    // Keep the chain alive after a failed append; the caller still sees the rejection.
    this.chain = run.catch(() => {});
    return run;
  }

  entries(): readonly Entry[] {
    return this.rows.map((row) => structuredClone(row));
  }

  async close(): Promise<void> {
    await this.chain;
    const fh = this.fh;
    this.fh = null;
    if (fh) await fh.close();
  }

  private async write(entry: Entry): Promise<void> {
    const fh = this.fh;
    if (!fh) throw new MaestroError(`journal ${this.path} is closed`, 'journal_unwritable');

    let row: Entry = entry;
    let buf: Buffer;
    try {
      const json = entry.result === undefined ? undefined : JSON.stringify(entry.result);
      if (json !== undefined && Buffer.byteLength(json) > LIMITS.blobThresholdBytes) {
        // Blob first, then the row, so a row never references a blob that is not on disk.
        await writeDurable(this.blobPath(entry.key), json);
        row = { ...entry, result: { blob: entry.key }, blob: true };
      }
      // The trace follows the same 64 KB rule, in its own blob.
      const traceJson = row.trace === undefined ? undefined : JSON.stringify(row.trace);
      if (traceJson !== undefined && Buffer.byteLength(traceJson) > LIMITS.blobThresholdBytes) {
        await writeDurable(traceBlobPath(this.blobDir, entry.key), traceJson);
        row = { ...row, trace: { blob: entry.key }, traceBlob: true };
      }
      const line = JSON.stringify(row);
      buf = Buffer.from(`${line}\n`);
      // Keep what went to disk, not the caller's object: a resume reads back exactly this.
      row = JSON.parse(line) as Entry;
      const { bytesWritten } = await fh.write(buf);
      if (bytesWritten !== buf.length) {
        throw new Error(`short write (${bytesWritten}/${buf.length} bytes)`);
      }
      await fh.sync();
    } catch (err) {
      // Roll back a partial line so the next append starts on a clean line boundary.
      await fh.truncate(this.size).catch(() => {});
      throw new MaestroError(`journal append failed at ${this.path}: ${describe(err)}`, 'journal_unwritable');
    }
    this.size += buf.length;
    this.rows.push(row);
    this.index(row);
  }

  private index(row: Entry): void {
    if (row.status === 'ok') this.latestOk.set(row.key, row);
  }

  private blobPath(key: string): string {
    return join(this.blobDir, blobFileName(key, '.json'));
  }
}

function traceBlobPath(blobDir: string, key: string): string {
  return join(blobDir, blobFileName(key, '.trace.json'));
}

/** Read-only view of a run's journal (for `maestro show`): rows of the good prefix, nothing truncated. */
export async function readEntries(runDir: string): Promise<Entry[]> {
  const data = await readFile(join(runDir, 'journal.jsonl'));
  return scan(data).rows;
}

/** Reads a >64 KB result blob for `key` (resolving POSIX/Windows filename conventions). */
export async function readResultBlob(runDir: string, key: string): Promise<unknown> {
  return JSON.parse(await readFile(resolveBlobFile(join(runDir, 'blobs'), key, '.json'), 'utf8'));
}

/** The row's trace with its blob resolved; undefined when the row has none or the blob is unreadable. */
export async function readTrace(runDir: string, row: Entry): Promise<Trace | undefined> {
  if (row.trace === undefined) return undefined;
  if (row.traceBlob !== true) return row.trace as Trace;
  try {
    return JSON.parse(
      await readFile(resolveBlobFile(join(runDir, 'blobs'), row.key, '.trace.json'), 'utf8'),
    ) as Trace;
  } catch {
    return undefined;
  }
}

async function writeDurable(path: string, data: string): Promise<void> {
  const fh = await open(path, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Parses newline-terminated rows; stops at the first unterminated, unparseable or malformed line. */
function scan(data: Buffer): { rows: Entry[]; goodBytes: number; bad?: { line: number } } {
  const rows: Entry[] = [];
  let pos = 0;
  let line = 1;
  while (pos < data.length) {
    const nl = data.indexOf(0x0a, pos);
    // An unterminated last line is a torn write even if it parses: append never resolved for it.
    if (nl === -1) return { rows, goodBytes: pos, bad: { line } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString('utf8', pos, nl));
    } catch {
      return { rows, goodBytes: pos, bad: { line } };
    }
    if (!isEntryRow(parsed)) return { rows, goodBytes: pos, bad: { line } };
    rows.push(parsed);
    pos = nl + 1;
    line++;
  }
  return { rows, goodBytes: pos };
}
