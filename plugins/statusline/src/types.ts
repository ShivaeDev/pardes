// Shape of the JSON Claude Code sends on stdin to the `statusLine` command.
// Mirrors the v2.1.x schema documented at https://code.claude.com/docs/en/statusline
// Everything here is treated as optional/defensive at runtime — fields come and go
// across versions, models, and session phases (null before the first API call, etc.).

export interface StatusInput {
  cwd?: string;
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  version?: string;

  model?: {
    id?: string;
    display_name?: string;
  };

  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    // Present whenever cwd is inside a linked git worktree (any `git worktree add`).
    git_worktree?: string;
    // Parsed from the `origin` remote. Absent outside a repo / without origin.
    repo?: { host?: string; owner?: string; name?: string };
  };

  output_style?: { name?: string };

  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };

  context_window?: {
    // NOTE: as of 2.1.132 these are *current context occupancy*, not session
    // cumulative. total_input_tokens already includes cache reads + writes.
    total_input_tokens?: number;
    total_output_tokens?: number;
    // The model's full window (200000, or 1000000 for extended-context models).
    context_window_size?: number;
    // Pre-calculated against context_window_size (NOT against any auto-compact
    // override), input-only. We recompute our own % against the compact window.
    used_percentage?: number | null;
    remaining_percentage?: number | null;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };

  exceeds_200k_tokens?: boolean;

  // Absent when the model has no reasoning-effort parameter.
  effort?: { level?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' };

  thinking?: { enabled?: boolean };

  // Only for Claude.ai subscribers, after the first API response. Each window
  // may be independently absent.
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };

  vim?: { mode?: 'NORMAL' | 'INSERT' | 'VISUAL' | 'VISUAL LINE' };

  agent?: { name?: string; type?: string };

  pr?: {
    number?: number;
    url?: string;
    review_state?: 'approved' | 'pending' | 'changes_requested' | 'draft';
  };

  // Only during `--worktree` sessions.
  worktree?: {
    name?: string;
    path?: string;
    branch?: string;
    original_cwd?: string;
    original_branch?: string;
  };
}

// Shape sent to the `subagentStatusLine` command: a different contract entirely.
// One invocation per refresh tick, carrying every visible agent-panel row at once.
export interface SubagentInput {
  cwd?: string;
  session_id?: string;
  // Usable row width in columns, for truncation.
  columns?: number;
  tasks?: SubagentTask[];
}

export interface SubagentTask {
  id?: string;
  name?: string;
  type?: string;
  status?: string; // e.g. "running" | "completed" | "failed" | "pending" | ...
  description?: string;
  label?: string;
  startTime?: number; // epoch (ms or s — normalized at read time)
  tokenCount?: number;
  tokenSamples?: number[]; // recent samples, for a sparkline
  cwd?: string;
}

// We emit one of these (as a JSON line) per row we want to override.
export interface SubagentRowOverride {
  id: string;
  content: string; // rendered as-is, ANSI + OSC 8 allowed
}
