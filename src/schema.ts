// JSON Schema helpers for agent() (spec Level 1 null/throw table, 3.2).
// assertSatisfiableSchema: the "schema cannot be satisfied" check that makes agent() throw at call time.
// validateAgainstSchema: a small structural validator used by runners and FakeRunner-based tests.
// Schemas usually come from the vm context (another realm): never use instanceof here.

import type { JSONSchema } from './types.js';
import { MaestroError } from './types.js';

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(path: string, why: string): never {
  throw new MaestroError(`schema_invalid: ${path}: ${why}`, 'schema_invalid');
}

/**
 * Throws MaestroError('schema_invalid') unless the root is `{ type: 'object', properties: {...} }`,
 * every `required` is a subset of its `properties` keys, and the same holds for every nested schema
 * reachable through properties / items / anyOf / oneOf / allOf.
 */
export function assertSatisfiableSchema(schema: unknown): asserts schema is JSONSchema {
  if (!isObject(schema)) invalid('$', 'schema must be an object');
  if (schema.type !== 'object') invalid('$', "root schema must have type: 'object'");
  if (!isObject(schema.properties)) invalid('$', 'root schema must have a properties object');
  checkNode(schema, '$', new Set());
}

function checkNode(node: unknown, path: string, ancestors: Set<unknown>): void {
  if (typeof node === 'boolean') return; // true / false are valid JSON Schemas
  if (!isObject(node)) invalid(path, 'subschema must be an object');
  if (ancestors.has(node)) invalid(path, 'cyclic schema');
  ancestors.add(node);

  const { type } = node;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0) invalid(path, 'empty type list');
    for (const t of types) {
      if (typeof t !== 'string' || !JSON_TYPES.has(t)) invalid(path, `unknown type ${JSON.stringify(t)}`);
    }
  }

  const { properties, required } = node;
  if (properties !== undefined && !isObject(properties)) invalid(path, 'properties must be an object');
  if (required !== undefined) {
    if (!Array.isArray(required)) invalid(path, 'required must be an array');
    const keys = new Set(Object.keys(properties ?? {}));
    for (const r of required) {
      if (typeof r !== 'string') invalid(path, 'required entries must be strings');
      if (!keys.has(r)) invalid(path, `required "${r}" is not in properties`);
    }
  }
  if (isObject(properties)) {
    for (const [k, sub] of Object.entries(properties)) checkNode(sub, `${path}.properties.${k}`, ancestors);
  }

  const { items } = node;
  if (items !== undefined) {
    if (Array.isArray(items)) {
      for (const [i, sub] of items.entries()) checkNode(sub, `${path}.items[${i}]`, ancestors);
    } else checkNode(items, `${path}.items`, ancestors);
  }

  for (const kw of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = node[kw];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) invalid(path, `${kw} must be a non-empty array`);
    for (const [i, sub] of list.entries()) checkNode(sub, `${path}.${kw}[${i}]`, ancestors);
  }

  ancestors.delete(node);
}

/** Structural validation: type, properties, required, items, enum, const, additionalProperties, *Of. */
export function validateAgainstSchema(
  schema: JSONSchema,
  value: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  validate(schema, value, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isObject(v);
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validate(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${path}: no value allowed`);
    return;
  }
  if (!isObject(schema)) return;

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${describe(value)}`);
      return; // keyword checks below assume the type matched
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }

  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const r of schema.required) {
        if (typeof r === 'string' && !Object.hasOwn(value, r))
          errors.push(`${path}: missing required "${r}"`);
      }
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected property "${k}"`);
      else if (isObject(schema.additionalProperties)) {
        validate(schema.additionalProperties, v, `${path}.${k}`, errors);
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    const { items } = schema;
    value.forEach((v, i) => {
      const sub = Array.isArray(items) ? items[i] : items;
      if (sub !== undefined) validate(sub, v, `${path}[${i}]`, errors);
    });
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validate(sub, value, path, errors);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => subValid(sub, value, path))) {
    errors.push(`${path}: does not match any schema in anyOf`);
  }
  if (Array.isArray(schema.oneOf)) {
    const n = schema.oneOf.filter((sub) => subValid(sub, value, path)).length;
    if (n !== 1) errors.push(`${path}: matches ${n} schemas in oneOf, expected exactly 1`);
  }
}

function subValid(schema: unknown, value: unknown, path: string): boolean {
  const errs: string[] = [];
  validate(schema, value, path, errs);
  return errs.length === 0;
}
