# Changelog — statusline

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.2] - 2026-06-02
### Fixed
- Removed redundant explicit registration of conventional `hooks/hooks.json`, which Claude Code auto-loads, avoiding duplicate-hook load failure while preserving the SessionStart hook.

## [0.1.1] - 2026-05-29
### Fixed
- Ownership check tightened from substring matching to anchored equality, so a similarly-named command is no longer mistaken for ours and silently overwritten.
- Subagent context bar no longer shows nonsensical overflow (e.g. `500k/165k`); the numerator is clamped to the window (configurable via `CLAUDE_STATUSLINE_SUBAGENT_WINDOW`).
- Model tag no longer renders a bare `?` when no model info is available.
- Session-start launcher exits cleanly instead of crashing when Bun is not installed.
- Unparseable settings files are now preserved byte-for-byte during reconciliation instead of being silently overwritten.

### Changed
- Extracted a pure, exported, unit-tested `reconcile()` function (with tests covering the foreign-command ownership-clobber case).

## [0.1.0] - 2026-05-29
### Added
- Multi-line main status line: repo/folder, git branch with ahead/behind and dirty state, worktree, PR state, model tag with a 1M-context badge, reasoning effort, session cost, durations, lines changed, and a context-pressure bar scaled to the usable window plus 5h/7d rate-limit gauges.
- Per-subagent agent-panel rows with a token-growth sparkline, context-pressure bar, elapsed time, and status glyph, degrading gracefully with row width.
- Declarative subagent status line via the plugin's bundled settings.
- SessionStart hook + `/statusline-setup` command that wire the main status line through a stable launcher, refreshed each session so plugin updates are picked up, and never clobber a user's own custom status line.
