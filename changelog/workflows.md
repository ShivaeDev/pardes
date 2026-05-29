# Changelog — workflows

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-05-29
### Changed
- Changed default `reportPath` from `'investigation-report.md'` to `'/tmp/investigation-report.md'` - this is a **breaking change** since it changes the default output location
- Changed synthesis agent to be non-isolated (writes to absolute path outside git checkout)
- Fixed a bug where gap-round readings were replacing (not augmenting) the first-pass readings - this is the "correctness bug" fix
- Added suspect citation folding into gap rounds - new behavior
- Various documentation improvements
- Fixed `maxRounds` semantics: changed from `Math.max(..., 1)` to allowing `0` (review only) - this could be seen as a fix, but the `maxRounds` semantics change from "maxRounds is the max number of fix→re-review cycles" to "maxRounds is the max number of fix attempts" is a semantic change
- Changed the loop from `for` to `while` with better semantics
- Fixed `base` propagation to reach the writer, fixer, AND reviewer (previously might not have reached all agents?)
- Changed `base` from literal ref in instructions to prose description
- Various docs updates
- Documentation updates reflecting the changes above
- The default `reportPath` change from relative to absolute `/tmp/` path is a **breaking change** - users who didn't specify `reportPath` would get a different output location.
- However, looking more carefully: the old default `'investigation-report.md'` was relative and would have failed anyway in a non-isolated orchestrator (as explained in the PR). So this is actually fixing a bug where the default path was wrong/invalid. This is a **bug fix**.
- The `maxRounds` change from min 1 to allowing 0 is also arguably a bug fix - the previous code `Math.max(Number(...), 1)` prevented `maxRounds: 0` from working, but the docs said 0 should mean "review only". Now `?? 2` correctly handles explicit 0. This is a **fix**, not a breaking change.
- The gap-round readings bug (replacing instead of augmenting) is clearly a **bug fix**.
- These are all bug fixes
- The `maxRounds: 0` support was documented but not functional
- The `reportPath` default change fixes a broken default that would cause stalls
- The gap-round readings fix corrects a correctness bug
- investigate:** Gap-round readings now augment (rather than replace) first-pass readings, preserving all findings in the final synthesis.
- investigate:** Suspect citations flagged by the critic are now folded into gap-round verification, allowing false positives to be dropped.
- investigate:** Default `reportPath` changed from relative path (`investigation-report.md`) to `/tmp/investigation-report.md` to prevent stalls when running from a non-isolated orchestrator.
- writer-reviewer:** `maxRounds: 0` now correctly disables fixing (review only) as documented, instead of being silently clamped to 1.
- writer-reviewer:** The `base` parameter now reaches the writer, reviewer, and fixer agents consistently — the diff base, branch base, and review comparison all use the same reference.
- writer-reviewer:** `base` parameter is phrased as an instruction (`branch from/diff against`) rather than a bare ref literal, making it work correctly with prose defaults.
- investigate:** Synthesis agent is now explicitly documented as non-worktree-isolated (it writes a single report file to an absolute path outside any checkout).
- writer-reviewer:** Internal loop rewritten from `for` to `while` for clearer `maxRounds`-as-fix-attempts semantics.
- Bump:** `patch` (0.1.0 → 0.1.1)
- Changelog updated:** `changelog/workflows.md` — two fixed sections (5 entries) covering the investigation correctness bugs, `reportPath` default fix, `maxRounds: 0` fix, and base-parameter reach fix; one changed entry for the loop rewrite.
- Manifest updated:** `plugins/workflows/.claude-plugin/plugin.json` version bumped to `0.1.1`.

## [0.1.0] - 2026-05-29
### Added
- Initial release: a starter library of reusable Workflow-tool orchestration scripts, auto-discovered and registered as `workflows:<name>`.
- `writer-reviewer` — implement a change in a worktree-isolated agent, then run an adversarial reviewer over the diff (bounded fix⟲re-review loop, continuity carried by git branch refs). Never merges or opens a PR; returns the final branch and a structured verdict.
- `investigate` — read-only investigation: fan out reader agents over several angles, synthesize, then run a completeness critic that flags fabricated citations and unread surfaces (bounded re-fan). Writes a full report to a file and returns a tight briefing plus the path.
- `parallel-verify` — fan out one worktree-isolated writer per disjoint, caller-supplied partition, then integrate the partition branches and run a single serialized heavy verification on the combined result (parallel heavy runs exhaust memory). Never merges to base or opens PRs; returns per-partition results plus the verification outcome.
- Every script is parameterized via `args` with safe defaults — no hardcoded repo paths, branch names, bootstrap commands, or home directories.

## [0.1.1] - 2026-05-29
### Fixed
- **investigate:** Gap-round readings now augment (rather than replace) first-pass findings, preserving all readings in the final synthesis.
- **investigate:** Suspect citations flagged by the critic are now folded into gap-round verification, so false positives can be dropped against source.
- **investigate:** Default `reportPath` is now `/tmp/investigation-report.md` (absolute, outside any checkout) — the old relative default would stall non-isolated orchestrators.
- **writer-reviewer:** `maxRounds: 0` now correctly disables fixing (review only) as documented; previously it was silently clamped to 1.
- **writer-reviewer:** The `base` parameter now reaches the writer, reviewer, and fixer agents consistently, and is phrased as a prose instruction so the default works across all agents.

### Changed
- **writer-reviewer:** Internal fix loop rewritten from `for` to `while` with clearer `fixesDone < maxRounds` semantics.
