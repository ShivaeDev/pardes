import { describe, expect, it } from 'vitest';
import { modelTag } from '../src/lib/model';

describe('modelTag', () => {
  it('derives O4.8 + 1M from an extended-context opus id', () => {
    expect(modelTag('claude-opus-4-8[1m]', 'Opus 4.8 (1M context)', 1_000_000)).toEqual({
      is1M: true,
      short: 'O4.8',
    });
  });
  it('derives S4.6 from a sonnet id without 1M', () => {
    expect(modelTag('claude-sonnet-4-6', 'Sonnet 4.6', 200000)).toEqual({
      is1M: false,
      short: 'S4.6',
    });
  });
  it('derives H4.5 from a dated haiku id', () => {
    expect(modelTag('claude-haiku-4-5-20251001', 'Haiku 4.5', 200000).short).toBe('H4.5');
  });
  it('treats a 1M window as extended even without the id tag', () => {
    expect(modelTag('claude-opus-4-8', 'Opus', 1_000_000).is1M).toBe(true);
  });
  it("falls back to the display name's first letter when family is unknown", () => {
    expect(modelTag(undefined, 'Custom Model', undefined).short).toBe('C');
  });
  it('pulls the version from the display name when the id lacks it', () => {
    expect(modelTag('some-model', 'Sonnet 4.6', 200000).short).toBe('S4.6');
  });
});
