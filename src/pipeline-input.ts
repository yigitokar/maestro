// Diagnostics observe workflow data without invoking workflow getters, proxy traps, or toJSON hooks.
// Running author code while capturing an input could change the result of a later node or resume.
import { isProxy } from 'node:util/types';
import type { PipelineInput } from './types.js';

export function snapshotJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value))
    throw new TypeError('not plain JSON data');
  const array = Array.isArray(value);
  const proto: object | null = Object.getPrototypeOf(value);
  if (!array && proto !== null && (isProxy(proto) || Object.getPrototypeOf(proto) !== null))
    throw new TypeError('not a plain JSON object');

  ancestors.add(value);
  try {
    const copy: Record<string, unknown> = array ? new Array(value.length) : Object.create(null);
    for (const key of Object.keys(value)) {
      if (array && !/^(?:0|[1-9]\d*)$/.test(key)) continue;
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(property, 'value')) throw new TypeError('accessor in JSON data');
      copy[key] = snapshotJson(property.value, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

export function capturePipelineInput(
  index: number,
  stage: number,
  previous: unknown,
  item: unknown,
): PipelineInput {
  try {
    return {
      index,
      stage,
      previous: snapshotJson(previous),
      ...(item === previous ? {} : { item: snapshotJson(item) }),
    };
  } catch {
    return { index, stage, unavailable: 'stage input is not plain JSON data' };
  }
}
