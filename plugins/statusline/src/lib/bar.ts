import { fg } from './ansi';

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const FULL = '█';
const TRACK = '░';

export interface BarOptions {
  /** Total cells (visible characters) in the bar. */
  width: number;
  /** Fraction filled, 0..1 (clamped). */
  fraction: number;
  /** 256-color code for the filled portion. */
  fillColor: number;
  /** 256-color code for the empty track. */
  trackColor: number;
}

/**
 * Sub-cell-accurate horizontal bar using eighth-block glyphs for the leading
 * edge, e.g. ████████▌░░░░░░░░. Filled and track are colored separately.
 */
export function bar(opts: BarOptions): string {
  const { width } = opts;
  const frac = Math.max(0, Math.min(1, opts.fraction));
  const exact = frac * width;
  let full = Math.floor(exact);
  const remainder = exact - full;
  let partial = EIGHTHS[Math.round(remainder * 8)] ?? '';
  // Round-up case: the eighths table rounded up to a full block.
  if (Math.round(remainder * 8) === 8) {
    full += 1;
    partial = '';
  }
  full = Math.min(full, width);

  const filled = FULL.repeat(full);
  const partialCount = partial ? 1 : 0;
  const empty = TRACK.repeat(Math.max(0, width - full - partialCount));

  const left = fg(opts.fillColor, filled + partial);
  const right = empty ? fg(opts.trackColor, empty) : '';
  return left + right;
}

const SPARK_BASE = '▁';
const SPARK = [SPARK_BASE, '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export interface SparkOptions {
  /**
   * Left-pad with baseline (▁) cells so the result is always exactly `width`
   * visible cells, even before `width` samples have accrued. Keeps the newest
   * data right-aligned so neighbouring columns don't shift as samples arrive.
   */
  pad?: boolean;
}

/**
 * Tiny inline sparkline from a numeric series. The newest sample is rightmost.
 * Without `pad`, returns "" for fewer than two points and never exceeds the
 * number of samples; with `pad`, always returns exactly `width` cells (renders
 * from the first sample, left-padding the rest with the baseline block).
 */
export function sparkline(
  values: number[] | undefined,
  width = 12,
  opts: SparkOptions = {},
): string {
  const samples = values ?? [];
  if (!opts.pad && samples.length < 2) return '';
  if (samples.length === 0) return opts.pad ? SPARK_BASE.repeat(width) : '';
  const series = samples.slice(-width);
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo;
  const cells = series.map((v) => {
    const t = span === 0 ? 0 : (v - lo) / span;
    return SPARK[Math.min(SPARK.length - 1, Math.round(t * (SPARK.length - 1)))];
  });
  if (opts.pad && cells.length < width) {
    return SPARK_BASE.repeat(width - cells.length) + cells.join('');
  }
  return cells.join('');
}
