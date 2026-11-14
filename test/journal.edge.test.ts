// Edge cases and failure modes of the journal, checked against docs/spec.md 3.1 (plus Seviye 2
// data-flow steps 1/2/7 and ADR-4): hashing of boundary inputs, cross-realm opts, blob threshold,
// append failures, damaged journals and blobs, unwritable paths. The happy paths live in journal.test.ts.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJSON, hashCall, Journal, makeKey, Occurrences } from '../src/journal.js';
import type { AgentOpts, Entry, EntryStatus } from '../src/types.js';
import { MaestroError } from '../src/types.js';

let dir: string;
const opened: Journal[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maestro-journal-edge-'));
});

afterEach(async () => {
  // First: the fsync test patches the shared FileHandle prototype.
  vi.restoreAllMocks();
  for (const j of opened.splice(0)) await j.close().catch(() => {});
  for (const p of [dir, join(dir, 'journal.jsonl'), join(dir, 'blobs')]) {
    try {
      chmodSync(p, 0o700);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

async function openJournal(log?: (m: string) => void, runDir = dir): Promise<Journal> {
  const j = await Journal.open(runDir, log ? { log } : undefined);
  opened.push(j);
  return j;
}

/** An Entry for key "<hash>:<n>"; non-ok rows always carry a null result. */
function row(key: string, status: EntryStatus = 'ok', result: unknown = `r-${key}`, index = 0): Entry {
  const i = key.lastIndexOf(':');
  return {
    index,
    hash: key.slice(0, i),
    n: Number(key.slice(i + 1)),
    key,
    result: status === 'ok' ? result : null,
    usage: { input_tokens: 1, output_tokens: 2 },
    status,
  };
}

const journalFile = () => join(dir, 'journal.jsonl');
const blobFile = (key: string) => join(dir, 'blobs', `${key}.json`);
const lines = () =>
  readFileSync(journalFile(), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
const storedRows = () => lines().map((l) => JSON.parse(l) as Entry);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// chmod-based tests cannot fail for root, and Windows ignores POSIX modes.
const chmodIneffective = process.getuid?.() === 0 || process.platform === 'win32';

describe('hashCall: what is and is not part of the key', () => {
  it('is sha256(prompt + "\\n" + canonicalJSON(opts minus label/phase)); undefined opts hash as {}', () => {
    const expected = sha('p\n{}');
    expect(hashCall('p')).toBe(expected);
    expect(hashCall('p', {})).toBe(expected);
    expect(hashCall('p', { label: 'x', phase: 'y' })).toBe(expected);
    expect(hashCall('p', { model: 'm', label: 'L' })).toBe(sha('p\n{"model":"m"}'));
  });

  it('ignores key order recursively and drops undefined props', () => {
    const a = { effort: 'high', schema: { b: 1, a: { d: 1, c: 2 } } } as unknown as AgentOpts;
    const b = { schema: { a: { c: 2, d: 1 }, b: 1 }, effort: 'high' } as unknown as AgentOpts;
    expect(hashCall('p', a)).toBe(hashCall('p', b));
    expect(hashCall('p', { model: undefined })).toBe(hashCall('p', {}));
    expect(hashCall('p', { label: undefined, model: undefined })).toBe(hashCall('p'));
    expect(hashCall('p', { schema: { a: undefined } })).toBe(hashCall('p', { schema: {} }));
  });

  it('changes with tool order, model and prompt', () => {
    expect(hashCall('p', { tools: ['a', 'b'] })).not.toBe(hashCall('p', { tools: ['b', 'a'] }));
    expect(hashCall('p', { model: 'x' })).not.toBe(hashCall('p'));
    expect(hashCall('p')).not.toBe(hashCall('q'));
  });

  it('a prompt that ends in "\\n" + opts JSON does not collide with the (prompt, opts) pair it imitates', () => {
    // canonicalJSON never contains a raw newline, so the last "\n" of the hashed text is the separator.
    expect(canonicalJSON({ s: 'a\nb' })).not.toContain('\n');
    expect(hashCall('x\n{"model":"m"}')).not.toBe(hashCall('x', { model: 'm' }));
    expect(hashCall('x\n{}')).not.toBe(hashCall('x'));
    expect(hashCall('x\n{}', {})).not.toBe(hashCall('x', { model: '{}' }));
  });

  it('accepts an empty prompt and yields a "<sha256>:<n>" key for it', () => {
    expect(hashCall('', undefined)).toBe(hashCall('', {}));
    expect(hashCall('')).toBe(sha('\n{}'));
    expect(makeKey(hashCall(''), 0)).toMatch(/^[0-9a-f]{64}:0$/);
  });

  // A script cutting text with .slice() can split a surrogate pair. Hashing the string as UTF-8 would
  // turn every lone surrogate into U+FFFD and give both prompts one key (silent wrong cache).
  it('prompts that differ only in a lone surrogate get different hashes', () => {
    const a = 'summarize: abc\uD83D';
    const b = 'summarize: abc\uD83E';
    expect(hashCall(a)).not.toBe(hashCall(b));
    expect(hashCall(a)).not.toBe(hashCall('summarize: abc�'));
    expect(hashCall('p', { model: 'm\uD83D' })).not.toBe(hashCall('p', { model: 'm\uD83E' }));
  });
});

describe('canonicalJSON keeps JSON.stringify semantics on boundary inputs', () => {
  it('matches JSON.stringify for undefined, functions, NaN, -0 and dates inside arrays and objects', () => {
    const v = { z: [1, 'a', null, undefined, () => 1, Number.NaN, -0], a: new Date(0), m: true };
    expect(canonicalJSON(v)).toBe(
      '{"a":"1970-01-01T00:00:00.000Z","m":true,"z":[1,"a",null,null,null,null,0]}',
    );
    expect(JSON.parse(canonicalJSON(v))).toEqual(JSON.parse(JSON.stringify(v)));
  });

  it('sparse array holes serialize as null, like JSON.stringify', () => {
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    const leading = [, 1];
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    const middle = [1, , 3];
    expect(canonicalJSON(leading)).toBe('[null,1]');
    expect(canonicalJSON(middle)).toBe('[1,null,3]');
    expect(canonicalJSON(middle)).toBe(JSON.stringify(middle));
    expect(canonicalJSON(new Array(3))).toBe('[null,null,null]');
    expect(canonicalJSON({ tools: new Array(2) })).toBe('{"tools":[null,null]}');
  });

  it('sparse, explicit-undefined and explicit-null arrays in opts hash the same', () => {
    const holes = new Array<string>(2);
    const viaUndefined = hashCall('p', { tools: [undefined, undefined] as never });
    expect(hashCall('p', { tools: holes })).toBe(viaUndefined);
    expect(hashCall('p', { tools: [null, null] as never })).toBe(viaUndefined);
    // biome-ignore lint/suspicious/noSparseArray: the hole is the point of the test
    const holey = { schema: { enum: [1, , 3] } } as unknown as AgentOpts;
    const dense = { schema: { enum: [1, null, 3] } } as unknown as AgentOpts;
    expect(hashCall('p', holey)).toBe(hashCall('p', dense));
  });
});

// Script opts are created inside the vm context, where host `instanceof` checks are false.
describe('opts from another realm (vm context)', () => {
  it('boxed primitives unbox like JSON.stringify', () => {
    const boxed = vm.runInNewContext('({ a: new Number(5), b: new String("xy"), c: new Boolean(false) })');
    expect(canonicalJSON(boxed)).toBe('{"a":5,"b":"xy","c":false}');
    expect(canonicalJSON(boxed)).toBe(JSON.stringify(boxed));
    const optsLike = vm.runInNewContext(
      '({ model: new String("m"), n: new Number(3), b: new Boolean(true) })',
    );
    expect(canonicalJSON(optsLike)).toBe('{"b":true,"model":"m","n":3}');
  });

  it('opts that differ only in a boxed number get different hashes', () => {
    const ctx = vm.createContext({});
    // e.g. a schema built in the script with boxed numbers: maxItems 1 vs maxItems 2.
    const o1 = vm.runInContext('({ schema: { type: "array", maxItems: new Number(1) } })', ctx);
    const o2 = vm.runInContext('({ schema: { type: "array", maxItems: new Number(2) } })', ctx);
    expect(hashCall('same prompt', o1)).not.toBe(hashCall('same prompt', o2));
    expect(hashCall('same prompt', o1)).toBe(
      hashCall('same prompt', { schema: { maxItems: 1, type: 'array' } }),
    );
  });

  it('plain objects, arrays and dates serialize like same-realm ones', () => {
    const v = vm.runInNewContext(
      '({ z: [1, { y: 2, x: [3] }], a: new Date(Date.UTC(2026, 0, 1)), u: undefined, f() {} })',
    );
    const local = { a: new Date(Date.UTC(2026, 0, 1)), z: [1, { x: [3], y: 2 }] };
    expect(canonicalJSON(v)).toBe(canonicalJSON(local));
    expect(canonicalJSON(v)).toBe('{"a":"2026-01-01T00:00:00.000Z","z":[1,{"x":[3],"y":2}]}');
  });

  it('opts hash equal to same-realm opts and still ignore label/phase', () => {
    const vmOpts = vm.runInNewContext(
      '({ label: "L", phase: "P", schema: { type: "object", properties: { b: {}, a: {} } }, effort: "high" })',
    );
    expect(hashCall('p', vmOpts)).toBe(
      hashCall('p', { effort: 'high', schema: { properties: { a: {}, b: {} }, type: 'object' } }),
    );
    const withTools = vm.runInNewContext(
      '({ tools: ["read_file"], schema: { type: "object", properties: {} } })',
    );
    expect(hashCall('p', withTools)).toBe(
      hashCall('p', { schema: { properties: {}, type: 'object' }, tools: ['read_file'] }),
    );
  });
});

describe('Occurrences', () => {
  it('counts each hash independently, 0-based, also when calls interleave', () => {
    const occ = new Occurrences();
    expect([occ.next('a'), occ.next('b'), occ.next('a'), occ.next('a'), occ.next('b')]).toEqual([
      0, 0, 1, 2, 1,
    ]);
    // A new execution starts from 0 again: n is never carried over.
    expect(new Occurrences().next('a')).toBe(0);
  });
});

describe('Journal.get', () => {
  it('a later skipped/null row does not shadow the latest ok row; a newer ok row wins, also after re-open', async () => {
    const j = await openJournal();
    await j.append(row('k:0', 'null'));
    expect(j.get('k:0')).toBeUndefined();
    await j.append(row('k:0', 'ok', 'first'));
    await j.append(row('k:0', 'skipped'));
    expect(j.get('k:0')?.result).toBe('first');
    await j.append(row('k:0', 'ok', 'second'));
    const r = await openJournal();
    expect(r.get('k:0')?.result).toBe('second');
    expect(r.entries()).toHaveLength(4);
  });

  it('budget resume: 6 ok + 4 skipped rows give 6 hits and 4 misses after re-open; the 4 live appends then hit', async () => {
    const j1 = await openJournal();
    for (let i = 0; i < 10; i++) await j1.append(row(`h${i}:0`, i < 6 ? 'ok' : 'skipped', `v${i}`, i));
    await j1.close();

    const j2 = await openJournal();
    const hits = Array.from({ length: 10 }, (_, i) => j2.get(`h${i}:0`)?.result);
    expect(hits).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5', undefined, undefined, undefined, undefined]);
    for (let i = 6; i < 10; i++) await j2.append(row(`h${i}:0`, 'ok', `live${i}`, i));
    expect(j2.entries()).toHaveLength(14);
    expect(lines()).toHaveLength(14);
    await j2.close();

    const j3 = await openJournal();
    for (let i = 0; i < 10; i++) expect(j3.get(`h${i}:0`)?.result).toBe(i < 6 ? `v${i}` : `live${i}`);
  });

  it('is synchronous and returns a copy whose top-level fields can be changed without affecting the journal', async () => {
    const j = await openJournal();
    await j.append(row('k:0', 'ok', 'A'));
    const e = j.get('k:0');
    expect(e).toMatchObject({ key: 'k:0', status: 'ok', result: 'A' });
    (e as Entry).status = 'null';
    (e as Entry).result = 'changed';
    expect(j.get('k:0')).toMatchObject({ status: 'ok', result: 'A' });
    expect(j.entries()[0]).toMatchObject({ status: 'ok', result: 'A' });
  });
});

describe('blob threshold: strictly above 64 KB of serialized result', () => {
  it('exactly 65536 serialized bytes stays inline; 65537 goes to blobs/', async () => {
    const j = await openJournal();
    const exact = 'a'.repeat(64 * 1024 - 2); // + 2 quote bytes = 65536
    const over = 'a'.repeat(64 * 1024 - 1); // 65537
    await j.append(row('h1:0', 'ok', exact));
    await j.append(row('h2:0', 'ok', over));
    const [r1, r2] = storedRows();
    expect(r1?.blob).toBeUndefined();
    expect(r1?.result).toBe(exact);
    expect(r2?.blob).toBe(true);
    expect(r2?.result).toEqual({ blob: 'h2:0' });
    expect(existsSync(blobFile('h1:0'))).toBe(false);
    expect(existsSync(blobFile('h2:0'))).toBe(true);
    expect(j.get('h2:0')?.result).toBe(over);
  });

  it('counts UTF-8 bytes, not string length', async () => {
    const j = await openJournal();
    const multi = 'ş'.repeat(40 * 1024); // 40k chars, 80 KB
    expect(multi.length).toBeLessThan(64 * 1024);
    await j.append(row('m:0', 'ok', multi));
    expect(storedRows()[0]?.blob).toBe(true);
    expect(j.get('m:0')?.result).toBe(multi);
    const reopened = await openJournal();
    expect(reopened.get('m:0')?.result).toBe(multi);
  });

  it('a small result shaped like a blob reference is stored inline and returned verbatim', async () => {
    const j = await openJournal();
    await j.append(row('r:0', 'ok', { blob: 'r:0' }));
    expect(storedRows()[0]?.blob).toBeUndefined();
    expect(existsSync(blobFile('r:0'))).toBe(false);
    expect(j.get('r:0')?.result).toEqual({ blob: 'r:0' });
    const reopened = await openJournal();
    expect(reopened.get('r:0')?.result).toEqual({ blob: 'r:0' });
  });
});

describe('damaged blobs count as a miss', () => {
  it.each([
    ['missing', (p: string) => rmSync(p)],
    ['empty', (p: string) => writeFileSync(p, '')],
    ['garbled', (p: string) => writeFileSync(p, '{"half":')],
  ])(
    '%s blob: get() is undefined, the log names the key, and the journal keeps working',
    async (_name, damage) => {
      const log = vi.fn();
      const j = await openJournal(log);
      await j.append(row('b:0', 'ok', { big: 'z'.repeat(70 * 1024) }));
      expect(j.get('b:0')?.result).toEqual({ big: 'z'.repeat(70 * 1024) });
      expect(log).not.toHaveBeenCalled();

      damage(blobFile('b:0'));
      expect(j.get('b:0')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toContain('b:0');
      await j.append(row('c:0', 'ok', 'after'));
      expect(j.get('c:0')?.result).toBe('after');
      expect(j.entries().map((e) => e.key)).toEqual(['b:0', 'c:0']);
    },
  );
});

describe('append failure modes', () => {
  it('a failed fsync rolls the line back, rejects journal_unwritable, and the next append is clean', async () => {
    const j = await openJournal();
    await j.append(row('a:0', 'ok', 1));
    const before = readFileSync(journalFile());

    const probe = await open(join(dir, 'probe'), 'w');
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    vi.spyOn(proto, 'sync').mockRejectedValueOnce(new Error('EIO'));

    const err = await j.append(row('b:0', 'ok', 2)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    expect(readFileSync(journalFile()).equals(before)).toBe(true);
    expect(j.get('b:0')).toBeUndefined();
    expect(j.entries().map((e) => e.key)).toEqual(['a:0']);

    await j.append(row('c:0', 'ok', 3));
    const reopened = await openJournal();
    expect(reopened.entries().map((e) => e.key)).toEqual(['a:0', 'c:0']);
  });

  it('when the blob cannot be written the append rejects and no row is written', async () => {
    const j = await openJournal();
    rmSync(join(dir, 'blobs'), { recursive: true, force: true });
    const err = await j.append(row('big:0', 'ok', 'x'.repeat(70 * 1024))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    expect(readFileSync(journalFile(), 'utf8')).toBe('');
    expect(j.entries()).toHaveLength(0);
    expect(j.get('big:0')).toBeUndefined();
  });

  it('a non-serializable result rejects, writes nothing, and the next append still lands', async () => {
    const j = await openJournal();
    const err = await j.append(row('bi:0', 'ok', { n: 1n })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
    expect(readFileSync(journalFile(), 'utf8')).toBe('');
    await j.append(row('ok:0', 'ok', 'fine'));
    expect(storedRows().map((r) => r.key)).toEqual(['ok:0']);
    expect(j.entries().map((e) => e.key)).toEqual(['ok:0']);
    expect(j.get('bi:0')).toBeUndefined();
  });

  it('50 concurrent appends land in call order, each on disk when its own promise resolves', async () => {
    const j = await openJournal();
    const seenOnDisk: number[] = [];
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        j.append(row(`k${i}:0`, 'ok', i, i)).then(() => {
          const keys = storedRows().map((r) => r.key);
          seenOnDisk.push(keys.length);
          expect(keys).toContain(`k${i}:0`);
        }),
      ),
    );
    expect(storedRows().map((r) => r.index)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(seenOnDisk).toHaveLength(50);
    expect(seenOnDisk.every((n, i) => n >= i + 1)).toBe(true);
  });
});

describe('opening a damaged or unusual journal', () => {
  it.each(['{}', '[]', '"x"', 'null', '{"key":"k","status":"done"}'])(
    'a parseable non-entry line %s is dropped with everything after it, logged once and truncated away',
    async (bad) => {
      const first = `${JSON.stringify(row('a:0', 'ok', 1))}\n`;
      writeFileSync(journalFile(), `${first}${bad}\n${JSON.stringify(row('b:0', 'ok', 2))}\n`);
      const log = vi.fn();
      const r = await openJournal(log);
      expect(r.entries().map((e) => e.key)).toEqual(['a:0']);
      expect(r.get('b:0')).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[0]).toMatch(/line 2/);
      expect(statSync(journalFile()).size).toBe(Buffer.byteLength(first));
    },
  );

  it('an empty journal file and a fresh run dir both open with zero rows and log nothing', async () => {
    writeFileSync(journalFile(), '');
    const log = vi.fn();
    const empty = await openJournal(log);
    expect(empty.entries()).toHaveLength(0);
    expect(empty.get('x:0')).toBeUndefined();

    const freshDir = join(dir, 'fresh');
    const fresh = await openJournal(log, freshDir);
    expect(fresh.entries()).toHaveLength(0);
    expect(fresh.get('x:0')).toBeUndefined();
    expect(readFileSync(join(freshDir, 'journal.jsonl'), 'utf8')).toBe('');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('unwritable journal: open rejects with journal_unwritable so the run does not start', () => {
  it.skipIf(chmodIneffective)('existing journal.jsonl is read-only', async () => {
    writeFileSync(journalFile(), `${JSON.stringify(row('a:0'))}\n`);
    chmodSync(journalFile(), 0o400);
    const err = await Journal.open(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
  });

  it('run dir path is a regular file', async () => {
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const err = await Journal.open(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
  });

  it('journal.jsonl path is a directory', async () => {
    mkdirSync(journalFile());
    const err = await Journal.open(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MaestroError);
    expect((err as MaestroError).code).toBe('journal_unwritable');
  });
});

describe('Journal rows are not shared with callers', () => {
  it('mutating a result got from the journal, or the appended entry, does not change later reads', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Journal } = await import('../src/journal.js');
    const dir = await mkdtemp(join(tmpdir(), 'maestro-journal-copy-'));
    try {
      const j = await Journal.open(dir);
      const entry = {
        index: 0,
        hash: 'k',
        n: 0,
        key: 'k:0',
        result: { list: [1] },
        usage: { input_tokens: 1, output_tokens: 1 },
        status: 'ok' as const,
      };
      await j.append(entry);
      entry.result.list.push(9);
      (j.get('k:0')!.result as { list: number[] }).list.push(2);
      (j.entries()[0]!.result as { list: number[] }).list.push(3);
      expect(j.get('k:0')!.result).toEqual({ list: [1] });
      expect(j.entries()[0]!.result).toEqual({ list: [1] });
      await j.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
