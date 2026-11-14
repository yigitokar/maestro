// Formatting shared by the viz page and widget: the same functions run on the server and, as source
// text (FORMAT_JS), inside both browser scripts.

import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FORMAT_JS, fmtDur, fmtTok } from '../src/viz-format.js';
import { vizPage } from '../src/viz-page.js';

describe('viz formatting', () => {
  it('fmtDur never shows 60 seconds or 60 minutes and has an hours form', () => {
    expect(fmtDur(850)).toBe('850 ms');
    expect(fmtDur(4200)).toBe('4,2 sn');
    expect(fmtDur(59_600)).toBe('1 dk 00 sn');
    expect(fmtDur(187_000)).toBe('3 dk 07 sn');
    expect(fmtDur(3_599_700)).toBe('1 sa 00 dk');
    expect(fmtDur(7_500_000)).toBe('2 sa 05 dk');
    expect(fmtDur(Number.NaN)).toBe('–');
    expect(fmtDur(-5)).toBe('0 ms');
  });

  it('fmtTok never shows 1000k', () => {
    expect(fmtTok(950)).toBe('950');
    expect(fmtTok(9500)).toBe('9,5k');
    expect(fmtTok(9996)).toBe('10k');
    expect(fmtTok(250_000)).toBe('250k');
    expect(fmtTok(999_500)).toBe('1,00M');
    expect(fmtTok(2_500_000)).toBe('2,50M');
  });

  it('FORMAT_JS is the same pair as standalone script source, embedded in the page', () => {
    const ctx = vm.createContext({});
    vm.runInContext(FORMAT_JS, ctx);
    expect(vm.runInContext('fmtDur(59600) + "|" + fmtTok(999500)', ctx)).toBe('1 dk 00 sn|1,00M');
    expect(vizPage({ mode: 'live', runId: 'r' })).toContain('function fmtDur(');
  });
});
