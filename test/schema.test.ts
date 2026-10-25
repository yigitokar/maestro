// Schema helper tests (null/throw table: unsatisfiable schema → agent() throws; spec 3.2 validation).

import { describe, expect, it } from 'vitest';
import { assertSatisfiableSchema, validateAgainstSchema } from '../src/schema.js';
import { MaestroError } from '../src/types.js';

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string' },
        },
        required: ['file', 'line', 'claim'],
        additionalProperties: false,
      },
    },
    severity: { enum: ['low', 'high'] },
    kind: { const: 'bug' },
  },
  required: ['findings'],
};

function code(schema: unknown): string | undefined {
  try {
    assertSatisfiableSchema(schema);
  } catch (e) {
    return e instanceof MaestroError ? e.code : 'other';
  }
  return undefined;
}

describe('assertSatisfiableSchema', () => {
  it('accepts object schemas with required ⊆ properties', () => {
    expect(code(FINDINGS)).toBeUndefined();
    expect(code({ type: 'object', properties: {} })).toBeUndefined();
    expect(
      code({ type: 'object', properties: { a: true, b: { type: ['string', 'null'] } } }),
    ).toBeUndefined();
    expect(
      code({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }),
    ).toBeUndefined();
  });

  it.each([
    ['not an object', 'string'],
    ['null', null],
    ['array', [{ type: 'object' }]],
    ['root type array', { type: 'array', items: { type: 'string' } }],
    ['root without type', { properties: {} }],
    ['root without properties', { type: 'object' }],
    ['required not subset', { type: 'object', properties: { a: {} }, required: ['a', 'b'] }],
    ['required not an array', { type: 'object', properties: { a: {} }, required: 'a' }],
    ['required non-string', { type: 'object', properties: { a: {} }, required: [1] }],
    [
      'nested via properties',
      { type: 'object', properties: { x: { type: 'object', properties: { a: {} }, required: ['z'] } } },
    ],
    [
      'nested via items',
      {
        type: 'object',
        properties: { x: { type: 'array', items: { type: 'object', properties: {}, required: ['q'] } } },
      },
    ],
    [
      'nested via anyOf',
      { type: 'object', properties: { x: { anyOf: [{ type: 'object', properties: {}, required: ['q'] }] } } },
    ],
    [
      'nested via oneOf',
      { type: 'object', properties: { x: { oneOf: [{ type: 'object', required: ['q'] }] } } },
    ],
    ['nested via allOf', { type: 'object', properties: {}, allOf: [{ required: ['q'] }] }],
    ['empty anyOf', { type: 'object', properties: { x: { anyOf: [] } } }],
    ['property schema not an object', { type: 'object', properties: { a: 'string' } }],
    ['unknown type', { type: 'object', properties: { a: { type: 'str' } } }],
  ])('%s → schema_invalid', (_n, schema) => {
    expect(code(schema)).toBe('schema_invalid');
  });

  it('rejects cyclic schemas', () => {
    const s: Record<string, unknown> = { type: 'object', properties: {} };
    (s.properties as Record<string, unknown>).self = s;
    expect(code(s)).toBe('schema_invalid');
  });

  it('accepts schemas from another realm', async () => {
    const vm = await import('node:vm');
    const foreign = vm.runInNewContext(
      "({ type: 'object', properties: { a: { type: 'array', items: {} } } })",
    );
    expect(code(foreign)).toBeUndefined();
  });
});

describe('validateAgainstSchema', () => {
  it('accepts a matching value', () => {
    expect(
      validateAgainstSchema(FINDINGS, {
        findings: [{ file: 'a.ts', line: 3, claim: 'x' }],
        severity: 'high',
        kind: 'bug',
      }),
    ).toEqual({ ok: true });
  });

  it('reports type, required, enum, const and additionalProperties errors with paths', () => {
    const r = validateAgainstSchema(FINDINGS, {
      findings: [
        { file: 'a.ts', line: 1.5, claim: 'x', extra: 1 },
        { file: 2, claim: 'y' },
      ],
      severity: 'mid',
      kind: 'feature',
    });
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors).toContain('$.findings[0].line: expected integer, got number');
    expect(errors).toContain('$.findings[0]: unexpected property "extra"');
    expect(errors).toContain('$.findings[1]: missing required "line"');
    expect(errors).toContain('$.findings[1].file: expected string, got integer');
    expect(errors.some((e) => e.startsWith('$.severity: not one of'))).toBe(true);
    expect(errors.some((e) => e.startsWith('$.kind: expected const'))).toBe(true);
  });

  it('checks the root type and missing required at the root', () => {
    expect(validateAgainstSchema(FINDINGS, null).ok).toBe(false);
    expect(validateAgainstSchema(FINDINGS, []).ok).toBe(false);
    expect(validateAgainstSchema(FINDINGS, {})).toEqual({
      ok: false,
      errors: ['$: missing required "findings"'],
    });
  });

  it('handles type unions, null, boolean schemas, tuples and *Of', () => {
    const s = {
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: false,
        c: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
        d: { anyOf: [{ type: 'string' }, { type: 'boolean' }] },
        e: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      },
    };
    expect(validateAgainstSchema(s, { a: null, c: ['x', 1], d: true, e: 1.5 })).toEqual({ ok: true });
    const bad = validateAgainstSchema(s, { a: 1, b: 1, c: [1, 'x'], d: 3, e: 2 });
    expect(bad.ok).toBe(false);
    expect(bad.ok ? 0 : bad.errors.length).toBe(6);
  });

  it('rejects non-finite numbers', () => {
    expect(validateAgainstSchema({ type: 'number' }, Number.NaN).ok).toBe(false);
    expect(validateAgainstSchema({ type: 'number' }, 2.5).ok).toBe(true);
  });
});
