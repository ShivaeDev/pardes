import { describe, expect, it } from 'vitest';
import { clock, cost, duration, tokens, until } from '../src/lib/format';

describe('tokens', () => {
  it('formats small counts verbatim', () => {
    expect(tokens(0)).toBe('0');
    expect(tokens(940)).toBe('940');
  });
  it('uses k below a million', () => {
    expect(tokens(9000)).toBe('9.0k');
    expect(tokens(18230)).toBe('18k');
    expect(tokens(182431)).toBe('182k');
  });
  it('uses M at/above a million', () => {
    expect(tokens(1_250_000)).toBe('1.25M');
    expect(tokens(12_000_000)).toBe('12.0M');
  });
  it('guards against missing/negative', () => {
    expect(tokens(undefined)).toBe('0');
    expect(tokens(-5)).toBe('0');
  });
});

describe('cost', () => {
  it('defaults to $0.00', () => {
    expect(cost(undefined)).toBe('$0.00');
  });
  it('uses two decimals normally', () => {
    expect(cost(1.8423)).toBe('$1.84');
  });
  it('keeps three decimals for sub-cent spend', () => {
    expect(cost(0.004)).toBe('$0.004');
  });
});

describe('duration', () => {
  it('seconds', () => {
    expect(duration(45000)).toBe('45s');
  });
  it('minutes and seconds, zero-padded', () => {
    expect(duration(125000)).toBe('2m05s');
  });
  it('hours and minutes, zero-padded', () => {
    expect(duration(3725000)).toBe('1h02m');
  });
  it('defaults to 0s', () => {
    expect(duration(undefined)).toBe('0s');
  });
});

describe('until', () => {
  const now = 1_000_000;
  it('seconds', () => {
    expect(until(now + 50, now)).toBe('50s');
  });
  it('minutes', () => {
    expect(until(now + 600, now)).toBe('10m');
  });
  it('hours and minutes', () => {
    expect(until(now + 8100, now)).toBe('2h15m');
  });
  it('never goes negative', () => {
    expect(until(now - 100, now)).toBe('0s');
  });
});

describe('clock', () => {
  it('renders HH:MM for a same-day timestamp', () => {
    const now = Date.now() / 1000;
    expect(clock(now, now)).toMatch(/^\d{2}:\d{2}$/);
  });
  it('prefixes the weekday on a different day', () => {
    const now = Date.now() / 1000;
    const nextWeek = now + 7 * 24 * 3600;
    expect(clock(nextWeek, now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
  });
});
