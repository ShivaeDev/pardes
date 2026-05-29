# Changelog — statusline

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-29
### Added
- Multi-line main status line: repo/folder, git branch with ahead/behind and dirty state, worktree, PR state, model tag with a 1M-context badge, reasoning effort, session cost, durations, lines changed, and a context-pressure bar scaled to the usable window plus 5h/7d rate-limit gauges.
- Per-subagent agent-panel rows with a token-growth sparkline, context-pressure bar, elapsed time, and status glyph, degrading gracefully with row width.
- Declarative subagent status line via the plugin's bundled settings.
- SessionStart hook + `/statusline-setup` command that wire the main status line through a stable launcher, refreshed each session so plugin updates are picked up, and never clobber a user's own custom status line.
