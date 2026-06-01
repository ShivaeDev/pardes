import { describe, expect, test } from 'vitest';
import {
  MANAGER_CONTEXT_INLINE_MAX_LENGTH,
  managerContextSummary,
  normalizeManagerContextUsage,
  renderManagerContextUsage,
} from './index.ts';

const emptyBar = '[░░░░░░░░░░]';

describe('manager context usage', () => {
  test('normalizes Pi context usage and renders the same compact bar style as worker context rows', () => {
    const snapshot = normalizeManagerContextUsage({
      contextWindow: 10_000,
      percent: 50,
      tokens: 5_000,
    });

    expect(snapshot).toEqual({
      contextWindow: 10_000,
      percent: 50,
      status: 'known',
      tokens: 5_000,
    });
    expect(renderManagerContextUsage(snapshot)).toBe('[█████░░░░░] ctx 50% 5K/10K');
    expect(managerContextSummary({ contextWindow: 10_000, percent: 12.5, tokens: 1_250 })).toBe(
      '[█░░░░░░░░░] ctx 13% 1.3K/10K',
    );
  });

  test('distinguishes unavailable usage from post-compaction recalibration', () => {
    expect(normalizeManagerContextUsage(undefined)).toEqual({
      contextWindow: null,
      percent: null,
      status: 'unknown',
      tokens: null,
    });
    expect(managerContextSummary(undefined)).toBe(`${emptyBar} ctx …`);

    const recalibrating = normalizeManagerContextUsage({
      contextWindow: 200_000,
      percent: null,
      tokens: null,
    });
    expect(recalibrating).toEqual({
      contextWindow: 200_000,
      percent: null,
      status: 'recalibrating',
      tokens: null,
    });
    expect(renderManagerContextUsage(recalibrating)).toBe(`${emptyBar} ctx … …/200K`);
  });

  test('falls back to a derived percentage while clamping display percentages into the bar range', () => {
    expect(
      normalizeManagerContextUsage({ contextWindow: 10_000.9, percent: null, tokens: 2_500.9 }),
    ).toEqual({
      contextWindow: 10_000,
      percent: 25,
      status: 'known',
      tokens: 2_500,
    });
    expect(managerContextSummary({ contextWindow: 10_000, percent: 150, tokens: 15_000 })).toBe(
      '[██████████] ctx 100% 15K/10K',
    );
    expect(managerContextSummary({ contextWindow: 10_000, percent: -20, tokens: 1 })).toBe(
      `${emptyBar} ctx 0% 1/10K`,
    );
  });

  test('treats invalid token windows and counts as unavailable', () => {
    expect(managerContextSummary({ contextWindow: 0, percent: 1, tokens: 1 })).toBe(
      `${emptyBar} ctx …`,
    );
    expect(managerContextSummary({ contextWindow: 10_000, percent: 1, tokens: Number.NaN })).toBe(
      `${emptyBar} ctx …`,
    );
    expect(managerContextSummary({ contextWindow: 10_000, percent: 1, tokens: -1 })).toBe(
      `${emptyBar} ctx …`,
    );
  });

  test('keeps even extreme values ANSI-neutral and hard-bounded', () => {
    const samples = [
      managerContextSummary(undefined),
      managerContextSummary({ contextWindow: Number.MAX_VALUE, percent: null, tokens: null }),
      managerContextSummary({
        contextWindow: Number.MAX_VALUE,
        percent: Number.MAX_VALUE,
        tokens: Number.MAX_VALUE,
      }),
      managerContextSummary({ contextWindow: 999_100_000, percent: 100, tokens: 999_100_000 }),
    ];

    expect(samples).toContain('[██████████] ctx 100% 1T+/1T+');
    expect(samples).toContain('[██████████] ctx 100% 999.1M/999.1M');
    for (const sample of samples) {
      expect(sample.length).toBeLessThanOrEqual(MANAGER_CONTEXT_INLINE_MAX_LENGTH);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: The test explicitly rejects terminal escapes.
      expect(sample).not.toMatch(/\x1b/);
    }
  });
});
