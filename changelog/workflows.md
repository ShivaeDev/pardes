# Changelog — workflows

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-29
### Added
- Initial release: a starter library of reusable Workflow-tool orchestration scripts, auto-discovered and registered as `workflows:<name>`.
- `writer-reviewer` — implement a change in a worktree-isolated agent, then run an adversarial reviewer over the diff (bounded fix⟲re-review loop, continuity carried by git branch refs). Never merges or opens a PR; returns the final branch and a structured verdict.
- `investigate` — read-only investigation: fan out reader agents over several angles, synthesize, then run a completeness critic that flags fabricated citations and unread surfaces (bounded re-fan). Writes a full report to a file and returns a tight briefing plus the path.
- `parallel-verify` — fan out one worktree-isolated writer per disjoint, caller-supplied partition, then integrate the partition branches and run a single serialized heavy verification on the combined result (parallel heavy runs exhaust memory). Never merges to base or opens PRs; returns per-partition results plus the verification outcome.
- Every script is parameterized via `args` with safe defaults — no hardcoded repo paths, branch names, bootstrap commands, or home directories.
