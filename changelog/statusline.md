# Changelog — statusline

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-05-29
### Changed
- Extracted a pure `reconcile()` function that's exported and unit-tested (new test file)
- Changed `isOurs()` to take `launcher` and `home` as parameters (API change)
- Tightened ownership matching from substring to anchored equality
- Added `ReconcileInput`, `ReconcileDecision` types
- Split the script into a pure `reconcile()` function and a `run()` wrapper
- Added handling for unparseable settings files (preserved byte-for-byte)
- New `subagentWindow()` function with `CLAUDE_STATUSLINE_SUBAGENT_WINDOW` env support
- Clamped numerator to window to prevent "500k/165k" nonsensical display
- Exported `WINDOW_KEY` for testability
- The exports of `reconcile`, `ReconcileInput`, `ReconcileDecision` are new API surface
- New `CLAUDE_STATUSLINE_SUBAGENT_WINDOW` env var is a new feature
- `isOurs` signature changed (breaking for internal consumers, but it's internal)
- Most changes are backward-compatible from a user perspective
- New subagent window env var (feature)
- Exported reconcile function and types (feature/new API)
- Tightened ownership matching from substring to anchored equality (behavior change that could be breaking for edge cases, though it's a bugfix)
- It classified the reconcile refactoring under "changed" (extracted pure function for testability)
- It classified the subagent bar fix, model tag fix, launcher crash fix, ownership check fix, and unparseable settings fix all under "fixed"
- Nothing under "added" or "removed"
- Extracted pure `reconcile()` function with typed input/output for testability.
- Subagent context bar no longer shows nonsensical overflow (e.g. "500k/165k") when exceeding the compaction wall; the numerator is clamped to a configurable `CLAUDE_STATUSLINE_SUBAGENT_WINDOW` window.
- Model tag no longer renders a bare "?" when no model info is available.
- Session-start launcher exits cleanly instead of crashing when Bun is not installed.
- Ownership check in settings reconciliation tightened from substring matching to anchored equality, preventing false positives on similarly-named paths.
- Unparseable settings files are now preserved byte-for-byte during reconciliation instead of being silently overwritten.

## [0.1.0] - 2026-05-29
### Added
- Multi-line main status line: repo/folder, git branch with ahead/behind and dirty state, worktree, PR state, model tag with a 1M-context badge, reasoning effort, session cost, durations, lines changed, and a context-pressure bar scaled to the usable window plus 5h/7d rate-limit gauges.
- Per-subagent agent-panel rows with a token-growth sparkline, context-pressure bar, elapsed time, and status glyph, degrading gracefully with row width.
- Declarative subagent status line via the plugin's bundled settings.
- SessionStart hook + `/statusline-setup` command that wire the main status line through a stable launcher, refreshed each session so plugin updates are picked up, and never clobber a user's own custom status line.
