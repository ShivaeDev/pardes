# pardes-all

A meta plugin for the [pardes](../../README.md) marketplace. It ships **no skills,
hooks, or commands of its own** — its only job is to depend on every other pardes
plugin, so installing it pulls the whole marketplace in at once.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install pardes-all@pardes
```

Installing `pardes-all` auto-installs and enables every other pardes plugin
(`base`, `onboarding`, `orchestrate`, `pr-description`, `shell-helpers`,
`shift-leader`, `statusline`, `workflows`) as dependencies.

> **Requires Claude Code v2.1.143+** for plugin dependencies to auto-install and
> auto-enable. On older versions, install the plugins individually (see the root
> README's "Install everything" section).

To pick and choose instead, skip this plugin and install only the ones you want
with `/plugin`.
