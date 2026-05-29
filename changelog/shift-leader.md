# Changelog — shift-leader

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-05-29
### Changed
- New `GOTCHAS.md` with 13 durable orchestration lessons (plus a workflow-ideas list) covering false green builds, writer isolation, disjoint partitioning, brief-vs-code conflicts, worktree hygiene, and more.
- Enriched `SKILL.md` with dependency-based dispatch mode selection, no-shortcuts discipline, brief-vs-code stop-on-conflict rule, a `freshen` verb workflow with safety contract, expanded dispatch safety rules, two-tier learnings store, and stricter worktree-hygiene and verification guidance.

## [0.1.0] - 2026-05-29
### Added
- Initial release: the `shift-leader` skill — run as the autonomous orchestrator of a multi-PR / multi-agent effort, dispatching file-disjoint parallel worktree agents, opening and monitoring each PR, gating dependent work on merges (never merging itself), and surviving compaction via a durable state file.
