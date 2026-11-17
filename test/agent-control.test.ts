import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentControl, STATUS_THROTTLE_MS } from '../src/agent-control.js';
import type { LiveAgentStatus } from '../src/types.js';
import { MAESTRO_VERSION } from '../src/version.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function control() {
  const statuses: LiveAgentStatus[] = [];
  const c = new AgentControl(
    { id: 0 },
    new AbortController().signal,
    (agent) => statuses.push(agent),
    () => {},
  );
  return { c, statuses };
}

describe('AgentControl status throttle', () => {
  it('a burst of progress and usage becomes one leading and one trailing status', () => {
    const { c, statuses } = control();
    c.running();
    vi.advanceTimersByTime(STATUS_THROTTLE_MS);
    const before = statuses.length;
    for (let i = 0; i < 500; i++) {
      c.progress({ activity: 'message', summary: `fragment ${i}` });
      c.usage({ input_tokens: 0, output_tokens: 1 });
    }
    expect(statuses.length).toBe(before + 1);
    vi.advanceTimersByTime(STATUS_THROTTLE_MS);
    expect(statuses.length).toBe(before + 2);
    expect(statuses.at(-1)).toMatchObject({
      progress: { summary: 'fragment 499' },
      usage: { output_tokens: 500 },
    });
    expect(c.snapshot().usage.output_tokens).toBe(500);
  });

  it('state changes are not delayed, and nothing is emitted after the agent closes', () => {
    const { c, statuses } = control();
    c.running();
    c.progress({ activity: 'model', summary: 'a' });
    c.progress({ activity: 'model', summary: 'b' });
    const unregister = c.register(async () => {});
    expect(statuses.at(-1)).toMatchObject({ canMessage: true, progress: { summary: 'b' } });
    unregister();
    c.progress({ activity: 'model', summary: 'c' });
    c.close();
    const closedAt = statuses.length;
    expect(statuses.at(-1)).toMatchObject({ canMessage: false, progress: { summary: 'c' } });
    vi.advanceTimersByTime(STATUS_THROTTLE_MS * 4);
    c.progress({ activity: 'model', summary: 'late' });
    expect(statuses.length).toBe(closedAt);
  });
});

describe('MAESTRO_VERSION', () => {
  it('equals the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(MAESTRO_VERSION).toBe(pkg.version);
  });
});
