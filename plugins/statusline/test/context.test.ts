import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { C } from '../src/lib/ansi';
import { effectiveWindow, pressureColor } from '../src/lib/context';

describe('effectiveWindow', () => {
  const WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
  const BUFFER = 'CLAUDE_STATUSLINE_COMPACT_BUFFER';
  let savedWindow: string | undefined;
  let savedBuffer: string | undefined;
  beforeEach(() => {
    savedWindow = process.env[WINDOW];
    savedBuffer = process.env[BUFFER];
    delete process.env[WINDOW];
    delete process.env[BUFFER];
  });
  afterEach(() => {
    if (savedWindow === undefined) delete process.env[WINDOW];
    else process.env[WINDOW] = savedWindow;
    if (savedBuffer === undefined) delete process.env[BUFFER];
    else process.env[BUFFER] = savedBuffer;
  });

  it('subtracts the auto-compact buffer from the full window when no override is set', () => {
    expect(effectiveWindow(1_000_000)).toBe(965000);
  });
  it('subtracts the buffer from the auto-compact override when set', () => {
    process.env[WINDOW] = '400000';
    expect(effectiveWindow(1_000_000)).toBe(365000);
  });
  it('ignores a non-positive / non-numeric override and buffers the full window', () => {
    process.env[WINDOW] = '0';
    expect(effectiveWindow(200000)).toBe(165000);
    process.env[WINDOW] = 'nonsense';
    expect(effectiveWindow(200000)).toBe(165000);
  });
  it('defaults the full window to 200k when unknown, then subtracts the buffer', () => {
    expect(effectiveWindow(undefined)).toBe(165000);
  });
  it('honors a zero buffer override and returns the raw window', () => {
    process.env[BUFFER] = '0';
    expect(effectiveWindow(200000)).toBe(200000);
  });
  it('returns the window raw when it is at or below the buffer', () => {
    expect(effectiveWindow(30000)).toBe(30000);
  });
});

describe('pressureColor', () => {
  it('steps calm -> warm -> hot -> crit', () => {
    expect(pressureColor(10)).toBe(C.gutterCalm);
    expect(pressureColor(60)).toBe(C.gutterWarm);
    expect(pressureColor(80)).toBe(C.gutterHot);
    expect(pressureColor(95)).toBe(C.gutterCrit);
  });
  it('uses the calm color right up to 50 and warm at the boundary', () => {
    expect(pressureColor(49.9)).toBe(C.gutterCalm);
    expect(pressureColor(50)).toBe(C.gutterWarm);
  });
});
