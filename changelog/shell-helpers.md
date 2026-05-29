# Changelog — shell-helpers

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-29
### Added
- Initial release: portable, dependency-free orchestration shell helpers, shipped as both `bin/` PATH commands and sourceable shell functions.
- `freshen` — bring the current checkout to a clean, current baseline (fast-forward only, never a destructive reset), run a configurable post-update setup command, prune merged branches, and reap stale worktrees.
- `prune-merged-branches` — delete local branches whose upstream remote ref is gone, never touching no-upstream branches, the current branch, or branches checked out in a worktree.
- `reap-stale-worktrees` — remove worktrees older than a configurable age threshold under a managed directory, refusing any worktree with uncommitted changes and never the current one.
- `gpr` — a thin, namespaced branch / commit / push / PR DSL (`start`, `commit`, `commit-all`, `push`, `pr`, `ship`, `start-ship`), with `gh` optional and a clear message when it is absent.
- All project-specifics (default branch, setup command, managed worktree directory, age threshold, branch prefix) configurable via environment variables with safe defaults.
