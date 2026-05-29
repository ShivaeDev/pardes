import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../src/lib/ansi';
import { bar, sparkline } from '../src/lib/bar';

const opts = (fraction: number, width = 10) => ({
  fillColor: 71,
  fraction,
  trackColor: 237,
  width,
});

describe('bar', () => {
  it('always renders exactly `width` visible cells', () => {
    for (const f of [0, 0.13, 0.5, 0.87, 1]) {
      expect(visibleWidth(bar(opts(f)))).toBe(10);
    }
  });
  it('is all track at 0 and all full at 1', () => {
    expect(bar(opts(0))).toContain('░');
    expect(bar(opts(0))).not.toContain('█');
    expect(bar(opts(1))).toContain('█');
    expect(bar(opts(1))).not.toContain('░');
  });
  it('clamps out-of-range fractions', () => {
    expect(visibleWidth(bar(opts(2)))).toBe(10);
    expect(visibleWidth(bar(opts(-1)))).toBe(10);
    expect(bar(opts(2))).not.toContain('░');
  });
  it('renders roughly half full at 0.5', () => {
    const full = [...bar(opts(0.5))].filter((c) => c === '█').length;
    expect(full).toBe(5);
  });
});

describe('sparkline', () => {
  it('returns empty for fewer than two points', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([5])).toBe('');
    expect(sparkline(undefined)).toBe('');
  });
  it('emits one glyph per sample', () => {
    expect([...sparkline([1, 2, 3, 4])].length).toBe(4);
  });
  it('caps the number of samples shown', () => {
    const many = Array.from({ length: 50 }, (_, i) => i);
    expect([...sparkline(many, 12)].length).toBe(12);
  });
  it('maps the min to the lowest block and max to the highest', () => {
    const s = sparkline([0, 100]);
    expect(s.startsWith('▁')).toBe(true);
    expect(s.endsWith('█')).toBe(true);
  });

  describe('pad', () => {
    it('left-pads to the full width when fewer samples than width', () => {
      const s = sparkline([10, 90], 8, { pad: true });
      expect([...s].length).toBe(8);
      // 6 baseline pad cells on the left, the 2 real samples on the right.
      expect(s).toBe('▁▁▁▁▁▁▁█');
    });
    it('renders a full-width baseline bar from a single sample', () => {
      const s = sparkline([42], 6, { pad: true });
      expect([...s].length).toBe(6);
      expect(s).toBe('▁▁▁▁▁▁');
    });
    it('renders a full-width baseline bar with no samples', () => {
      expect(sparkline([], 5, { pad: true })).toBe('▁▁▁▁▁');
      expect(sparkline(undefined, 5, { pad: true })).toBe('▁▁▁▁▁');
    });
    it('does not pad once samples reach the width (newest stays rightmost)', () => {
      const s = sparkline([0, 25, 50, 75, 100], 5, { pad: true });
      expect([...s].length).toBe(5);
      expect(s.startsWith('▁')).toBe(true);
      expect(s.endsWith('█')).toBe(true);
    });
    it('keeps the right-aligned window when samples exceed the width', () => {
      const padded = sparkline([1, 1, 1, 0, 100], 2, { pad: true });
      expect([...padded].length).toBe(2);
      // Only the last two samples (0,100) survive the slice.
      expect(padded).toBe('▁█');
    });
  });
});
