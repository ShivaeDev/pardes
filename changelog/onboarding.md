# Changelog — onboarding

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-29
### Added
- Initial release: the `onboarding` skill — orients a user in the pardes marketplace (what each plugin does and how `base`, `orchestrate`, `shift-leader`, `shell-helpers`, `pr-description`, `statusline`, and `workflows` compose) and runs a config doctor.
- Dependency-free config doctor (`scripts/doctor.ts`): an advisory report comparing `~/.claude/settings.json` against a manifest of recommended settings (tool search, auto-compaction window, 1M-context Opus model, `auto` permission default, effort level, thinking summaries, latest auto-update channel, fullscreen TUI, skip-auto-permission-prompt), marking each key set / missing / differs.
- Opt-in `--apply` mode that merges only the missing recommended keys after writing a timestamped backup, never overwriting an existing value or unrelated key, and prints exactly what it changed. Supports `--settings <path>` / `DOCTOR_SETTINGS_PATH` for testing against a sample file.
