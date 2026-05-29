# Changelog — pardes-all

All notable changes to this plugin are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-05-29
### Added
- Initial release: a meta plugin with no skills of its own that depends on every other pardes plugin (`base`, `onboarding`, `orchestrate`, `pr-description`, `shell-helpers`, `shift-leader`, `statusline`), so `/plugin install pardes-all@pardes` installs the whole marketplace in one step (auto-install + auto-enable of dependencies requires Claude Code v2.1.143+).
