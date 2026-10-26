// Usage arithmetic shared by the runner, the run loop and the progress tree. The cache fields are optional:
// they appear only once some turn reported them, so runners that never do keep the two-field shape.

import type { Usage } from './types.js';

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Adds `u` into `into` in place; cache fields are created on first report. */
export function addUsage(
  into: Usage,
  u: Partial<Record<keyof Usage, number | null | undefined>> | null | undefined,
): void {
  into.input_tokens += finite(u?.input_tokens);
  into.output_tokens += finite(u?.output_tokens);
  if (typeof u?.cache_read_input_tokens === 'number') {
    into.cache_read_input_tokens = (into.cache_read_input_tokens ?? 0) + finite(u.cache_read_input_tokens);
  }
  if (typeof u?.cache_creation_input_tokens === 'number') {
    into.cache_creation_input_tokens =
      (into.cache_creation_input_tokens ?? 0) + finite(u.cache_creation_input_tokens);
  }
}

/** True when the usage carries prompt-cache figures. */
export function hasCacheInfo(u: Usage): boolean {
  return u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined;
}

/** Every input token the model saw: uncached + cache writes + cache reads. */
export function totalInput(u: Usage): number {
  return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Share of the input served from the prompt cache, 0..1; null without cache figures or input. */
export function cacheReadRatio(u: Usage): number | null {
  const total = totalInput(u);
  if (!hasCacheInfo(u) || total === 0) return null;
  return (u.cache_read_input_tokens ?? 0) / total;
}
