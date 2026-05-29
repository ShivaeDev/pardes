import { C } from './ansi';

/** Tokens reserved for Claude Code's auto-compact buffer. Context never fills
 * past (window − buffer): compaction fires first. We subtract it so the bar
 * reads 100% exactly when compaction triggers, not at the raw ceiling. 35k is a
 * deliberate round figure; override with CLAUDE_STATUSLINE_COMPACT_BUFFER. */
const DEFAULT_COMPACT_BUFFER = 35000;

/**
 * The usable token budget the context bar scales to. Start from the real
 * compaction wall — CLAUDE_CODE_AUTO_COMPACT_WINDOW when set, else the model's
 * full window — then subtract the auto-compact buffer. A window at or below the
 * buffer is returned raw (never a non-positive budget).
 */
export function effectiveWindow(fullWindow: number | undefined): number {
  const full = fullWindow ?? 200000;
  const env = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  const ceiling = Number.isFinite(env) && env > 0 ? env : full;
  const envBuf = Number(process.env.CLAUDE_STATUSLINE_COMPACT_BUFFER);
  const buffer = Number.isFinite(envBuf) && envBuf >= 0 ? envBuf : DEFAULT_COMPACT_BUFFER;
  return ceiling > buffer ? ceiling - buffer : ceiling;
}

/** Context pressure → palette color, shared by gutters and bar fills. */
export function pressureColor(pct: number): number {
  if (pct < 50) return C.gutterCalm;
  if (pct < 75) return C.gutterWarm;
  if (pct < 90) return C.gutterHot;
  return C.gutterCrit;
}
