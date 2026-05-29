import { C, dim, fg, visibleWidth } from '../lib/ansi';
import { bar, sparkline } from '../lib/bar';
import { effectiveWindow, pressureColor } from '../lib/context';
import * as fmt from '../lib/format';
import type { SubagentInput, SubagentRowOverride, SubagentTask } from '../types';

interface StatusStyle {
  glyph: string;
  color: number;
}

function statusStyle(status: string | undefined): StatusStyle {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
    case 'active':
    case 'in_progress':
      return { color: 80, glyph: '◐' };
    case 'completed':
    case 'done':
    case 'success':
      return { color: C.clean, glyph: '✔' };
    case 'failed':
    case 'error':
      return { color: 203, glyph: '✗' };
    case 'pending':
    case 'queued':
    case 'waiting':
      return { color: 244, glyph: '○' };
    case 'cancelled':
    case 'canceled':
    case 'stopped':
      return { color: 245, glyph: '⊘' };
    default:
      return { color: 245, glyph: '●' };
  }
}

/** epoch ms or s -> "0:42" / "1:05:09". */
function elapsed(startTime: number | undefined, now: number): string | undefined {
  if (!startTime || startTime <= 0) return undefined;
  const startMs = startTime > 1e12 ? startTime : startTime * 1000;
  const total = Math.max(0, Math.round((now - startMs) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Gauge widths by available row width. Degrades long -> short -> minimal
// (bar + sparkline together; minimal keeps only the tokens/window + percent).
function gaugeTier(columns: number): { spark: number; barW: number } {
  if (columns >= 90) return { barW: 18, spark: 24 };
  if (columns >= 55) return { barW: 10, spark: 12 };
  return { barW: 0, spark: 0 };
}

/**
 * The usable token budget the subagent context bar scales to. The subagent
 * contract carries no per-task window, so we derive one from the env:
 *   - CLAUDE_STATUSLINE_SUBAGENT_WINDOW: the parent session's full window, when
 *     a wrapper threads it through (lets a 1M parent scale its agents' bars to
 *     1M instead of the 200k default). Passed as the model's full window, so the
 *     auto-compact buffer is still subtracted.
 *   - else: effectiveWindow's default (200k − buffer = 165k), as before.
 * Either way the numerator is clamped to this budget at the call site, so the
 * label can never read numerator > denominator (e.g. "500k/165k").
 */
function subagentWindow(): number {
  const env = Number(process.env.CLAUDE_STATUSLINE_SUBAGENT_WINDOW);
  return effectiveWindow(Number.isFinite(env) && env > 0 ? env : undefined);
}

/**
 * One agent-panel row. Fixed-width gauges live on the LEFT in the order
 * sparkline → context bar → elapsed; the variable-width name (then a dimmed,
 * truncated description) trails on the RIGHT so columns line up across rows.
 */
function renderRow(task: SubagentTask, columns: number, now: number): string {
  const st = statusStyle(task.status);
  const name = task.name || task.type || 'agent';
  const cols = columns > 0 ? columns : 80;
  const tier = gaugeTier(cols);

  const left: string[] = [fg(st.color, st.glyph)];

  const count = task.tokenCount;
  const hasTokens = typeof count === 'number' && count > 0;

  // Sparkline (token growth trend) — left of the context bar. Padded to the
  // tier's full width so the columns to its right never shift as samples
  // accrue; the newest data stays right-aligned, the left fills with baseline.
  if (hasTokens && tier.spark > 0) {
    const spark = sparkline(task.tokenSamples, tier.spark, { pad: true });
    if (spark) left.push(fg(C.tokens, spark));
  }

  // Context bar (fill vs the compaction wall) + numbers + percent.
  if (hasTokens) {
    const eff = subagentWindow();
    // Clamp the displayed numerator to the window: a subagent in a 1M parent can
    // legitimately exceed the 200k default, and an unclamped label would read a
    // nonsensical numerator > denominator (e.g. "500k/165k", "300%").
    const shownCount = eff > 0 ? Math.min(count, eff) : count;
    const fraction = eff > 0 ? shownCount / eff : 0;
    const pct = Math.min(100, fraction * 100);
    const color = pressureColor(pct);
    const nums = fg(color, `${fmt.tokens(shownCount)}/${fmt.tokens(eff)}`);
    const pctStr = fg(color, `${pct.toFixed(0)}%`);
    left.push(
      tier.barW > 0
        ? `${bar({ fillColor: color, fraction, trackColor: 237, width: tier.barW })} ${nums} ${pctStr}`
        : `${nums} ${pctStr}`,
    );
  }

  const el = elapsed(task.startTime, now);
  if (el) left.push(fg(C.time, `⏱ ${el}`));

  const leftStr = left.join('  ');

  // Variable-width identity on the right: name, then dimmed description filling
  // whatever horizontal room is left.
  const nameStr = fg(st.color, name);
  let rightStr = nameStr;
  const desc = task.description || task.label || '';
  const room = cols - visibleWidth(leftStr) - visibleWidth(nameStr) - 6;
  if (desc && room > 6) {
    const trimmed = [...desc].length > room ? `${[...desc].slice(0, room - 1).join('')}…` : desc;
    rightStr = `${nameStr} ${dim(trimmed)}`;
  }

  return `${leftStr}  ${fg(C.sep, '·')}  ${rightStr}`;
}

export function renderSubagent(input: SubagentInput): string {
  const tasks = input.tasks ?? [];
  const columns = input.columns ?? 80;
  const now = Date.now();

  const out: string[] = [];
  for (const task of tasks) {
    if (!task.id) continue; // no id -> keep Claude Code's default row
    const override: SubagentRowOverride = {
      content: renderRow(task, columns, now),
      id: task.id,
    };
    out.push(JSON.stringify(override));
  }
  return out.join('\n');
}
