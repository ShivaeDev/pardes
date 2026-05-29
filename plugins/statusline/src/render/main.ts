import { homedir } from 'node:os';
import { basename } from 'node:path';
import { C, dim, fg } from '../lib/ansi';
import { bar } from '../lib/bar';
import { effectiveWindow, pressureColor } from '../lib/context';
import * as fmt from '../lib/format';
import { gitInfo } from '../lib/git';
import { modelTag } from '../lib/model';
import type { StatusInput } from '../types';

const SEP = ` ${fg(C.sep, '·')} `;
const HOME = homedir();

/** Join the non-empty pieces of a line and prefix the pressure-tinted gutter. */
function line(gutterColor: number, parts: Array<string | undefined>): string {
  const body = parts.filter((p): p is string => !!p && p.length > 0).join(SEP);
  return `${fg(gutterColor, '▍')} ${body}`;
}

/** Collapse $HOME to ~ and keep only the trailing path components. */
function prettyPath(p: string | undefined, keep = 3): string {
  if (!p) return '?';
  let s = p;
  if (s === HOME) return '~';
  if (s.startsWith(`${HOME}/`)) s = `~/${s.slice(HOME.length + 1)}`;
  const segs = s.split('/').filter(Boolean);
  if (s.startsWith('~')) {
    // segs[0] === "~"
    if (segs.length <= keep) return segs.join('/');
    return `~/…/${segs.slice(-(keep - 1)).join('/')}`;
  }
  if (segs.length <= keep) return `/${segs.join('/')}`;
  return `…/${segs.slice(-keep).join('/')}`;
}

const EFFORT: Record<string, { label: string; color: number }> = {
  high: { color: 114, label: 'HIGH' },
  low: { color: 244, label: 'LOW' },
  max: { color: 204, label: 'MAX' },
  medium: { color: 80, label: 'MED' },
  ultra: { color: 201, label: 'ULTRA' },
  xhigh: { color: 215, label: 'XHIGH' },
};

function gitSegment(cwd: string): string | undefined {
  const g = gitInfo(cwd);
  if (!g?.branch) return undefined;
  const pieces: string[] = [fg(C.branch, `⎇ ${g.branch}`)];

  if (g.ahead > 0) pieces.push(fg(C.ahead, `↑${g.ahead}`));
  if (g.behind > 0) pieces.push(fg(C.behind, `↓${g.behind}`));

  const dirty: string[] = [];
  if (g.staged > 0) dirty.push(fg(C.clean, `+${g.staged}`));
  if (g.unstaged > 0) dirty.push(fg(C.dirty, `~${g.unstaged}`));
  if (g.untracked > 0) dirty.push(fg(C.muted, `?${g.untracked}`));
  pieces.push(dirty.length ? dirty.join(' ') : fg(C.clean, '✔'));

  return pieces.join(' ');
}

function prSegment(pr: StatusInput['pr']): string | undefined {
  if (!pr?.number) return undefined;
  const glyph =
    pr.review_state === 'approved'
      ? fg(C.prApproved, '✔')
      : pr.review_state === 'changes_requested'
        ? fg(C.prChanges, '✗')
        : pr.review_state === 'draft'
          ? fg(C.prDraft, '○')
          : pr.review_state === 'pending'
            ? fg(C.prPending, '●')
            : '';
  return `${fg(C.pr, `PR#${pr.number}`)}${glyph ? ` ${glyph}` : ''}`;
}

function limitSegment(
  label: string,
  win: { used_percentage?: number; resets_at?: number } | undefined,
  now: number,
): string | undefined {
  if (!win || typeof win.used_percentage !== 'number') return undefined;
  const pct = win.used_percentage;
  const color = pct < 60 ? C.limitOk : pct < 85 ? C.limitWarn : C.limitHot;
  const b = bar({ fillColor: color, fraction: pct / 100, trackColor: 237, width: 8 });
  let out = `${dim(label)} ${b} ${fg(color, `${Math.round(pct)}%`)}`;
  if (typeof win.resets_at === 'number') {
    out += ` ${dim(`⟳ ${fmt.clock(win.resets_at, now)} (${fmt.until(win.resets_at, now)})`)}`;
  }
  return out;
}

export function renderMain(s: StatusInput): string {
  const cwd = s.workspace?.current_dir ?? s.cwd ?? process.cwd();
  const ctx = s.context_window ?? {};

  // Effective window for the bar = the auto-compact override if set, else the
  // model's full window, minus the auto-compact buffer. This is the whole
  // point: bar to the usable budget the session can actually reach.
  const effWindow = effectiveWindow(ctx.context_window_size);

  // Current occupancy (input side, includes cache). Fall back to current_usage.
  let used = ctx.total_input_tokens ?? 0;
  if (!used && ctx.current_usage) {
    const u = ctx.current_usage;
    used =
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
  }
  const fraction = effWindow > 0 ? used / effWindow : 0;
  const pct = Math.min(100, fraction * 100);
  const fillColor = pressureColor(pct);

  // ~1 cell per 10k tokens (configurable), clamped to a sane width.
  const perCell = Number(process.env.CLAUDE_STATUSLINE_TOKENS_PER_CELL) || 10000;
  const width = Math.max(10, Math.min(80, Math.round(effWindow / perCell)));

  // ---- Line 1: location + VCS ---------------------------------------------
  const repo = s.workspace?.repo;
  const repoLabel =
    repo?.owner && repo?.name
      ? fg(C.repo, `${repo.owner}/${repo.name}`)
      : fg(C.repo, basename(s.workspace?.project_dir ?? cwd) || '—');
  const folderLabel = fg(C.folder, prettyPath(cwd));
  const wtName = s.worktree?.name ?? s.workspace?.git_worktree;
  const wtSeg = wtName ? fg(C.worktree, `⑂ ${wtName}`) : undefined;

  // ---- Model + effort + session economics ---------------------------------
  const tag = modelTag(s.model?.id, s.model?.display_name, ctx.context_window_size);
  const modelSeg = `${fg(C.model, tag.short)}${tag.is1M ? ` ${fg(C.ctx1m, '1M')}` : ''}`;

  const eff = s.effort?.level ? EFFORT[s.effort.level] : undefined;
  const effortSeg = eff ? fg(eff.color, `✦ ${eff.label}`) : undefined;

  const flags: string[] = [];
  if (s.thinking?.enabled) flags.push(fg(C.thinking, '✲'));
  if (s.vim?.mode) flags.push(fg(C.vim, s.vim.mode));
  if (s.output_style?.name && s.output_style.name !== 'default') {
    flags.push(fg(C.style, s.output_style.name));
  }
  const flagSeg = flags.length ? flags.join(' ') : undefined;

  const cost = s.cost ?? {};
  const costSeg = fg(C.cost, fmt.cost(cost.total_cost_usd));
  const durSeg = `${fg(C.time, `⏱ ${fmt.duration(cost.total_duration_ms)}`)} ${dim(
    `(api ${fmt.duration(cost.total_api_duration_ms)})`,
  )}`;
  const adds = cost.total_lines_added ?? 0;
  const dels = cost.total_lines_removed ?? 0;
  const linesSeg =
    adds || dels ? `${fg(C.added, `+${adds}`)} ${fg(C.removed, `-${dels}`)}` : undefined;

  // ---- Context bar + rate limit pieces ------------------------------------
  const barStr = `${dim('▕')}${bar({ fillColor, fraction, trackColor: 237, width })}${dim('▏')}`;
  const numbers = fg(C.tokens, `${fmt.tokens(used)}/${fmt.tokens(effWindow)}`);
  const pctStr = fg(fillColor, `${pct.toFixed(0)}%`);
  const now = Date.now() / 1000;
  const five = limitSegment('5h', s.rate_limits?.five_hour, now);
  const seven = limitSegment('7d', s.rate_limits?.seven_day, now);

  // Two lines: identity + model + economics, then the context bar + limits.
  const line1 = line(fillColor, [
    repoLabel,
    folderLabel,
    gitSegment(cwd),
    wtSeg,
    prSegment(s.pr),
    modelSeg,
    effortSeg,
    flagSeg,
    costSeg,
    durSeg,
    linesSeg,
  ]);
  const line2 = line(fillColor, [`${barStr} ${numbers} ${pctStr}`, five, seven]);
  return [line1, line2].join('\n');
}
