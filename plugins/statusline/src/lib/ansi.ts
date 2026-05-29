// Minimal ANSI helpers. 256-color palette so it reads well in a dimmed status bar
// across iTerm2 / Kitty / WezTerm / Terminal.app without relying on truecolor.

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';

/** Wrap text in a 256-color foreground, always resetting after. */
export function fg(code: number, text: string): string {
  return `\x1b[38;5;${code}m${text}${RESET}`;
}

/** Dim-wrap (used for separators, tracks, secondary labels). */
export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

/** Bold-wrap. */
export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

// Shared palette. Names describe intent, not hue, so the theme stays cohesive.
export const C = {
  added: 71, // +lines
  ahead: 80, // commits ahead
  behind: 211, // commits behind
  branch: 180, // git branch name
  clean: 71, // clean working tree

  cost: 222, // $ spent
  ctx1m: 147, // 1M-context badge
  dirty: 179, // uncommitted changes
  folder: 252, // current folder
  gutterCalm: 71, // green-ish, low context pressure
  gutterCrit: 203, // red, near compaction
  gutterHot: 215, // orange, high pressure
  gutterWarm: 179, // amber, mid pressure
  label: 244, // tiny labels
  limitHot: 203,

  limitOk: 71,
  limitWarn: 179,

  model: 213, // model short name
  muted: 245, // secondary text

  pr: 75,
  prApproved: 71,
  prChanges: 203,
  prDraft: 245,
  prPending: 179,
  removed: 203, // -lines

  repo: 75, // owner/name
  reset: 109,

  sep: 240, // separators / faint structure
  style: 109,

  thinking: 147,
  time: 109, // durations

  tokens: 110, // token counts
  vim: 215,
  worktree: 141, // worktree marker
} as const;

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(s: string): number {
  // Strip CSI (colors) and OSC 8 hyperlink sequences before measuring.
  const stripped = s
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes
    .replace(/\x1b\[[0-9;]*m/g, '');
  return [...stripped].length;
}
