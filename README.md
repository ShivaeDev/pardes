# Pardes

A calm-coding marketplace of [Claude Code](https://code.claude.com) plugins and skills.

*Pardes* (פרדס) means "orchard" or "walled garden" — the ancient root the word
*paradise* itself grows from. The idea: a tended garden of small, sharp tools
that make coding calmer and more deliberate.

## Using the marketplace

```bash
# add this marketplace
/plugin marketplace add ShivaeDev/pardes

# browse and install plugins
/plugin
```

## Plugins

| Plugin | What it does |
| --- | --- |
| `base` | Foundational plugin — shared hooks and core skills. |
| `onboarding` | Get oriented in the marketplace and tune your setup — explains what each plugin does and how they compose, then runs an advisory config doctor that reports recommended settings and applies them only with your explicit confirmation. |
| `orchestrate` | Plan a large multi-chunk PR through a user interview, then ship it by dispatching focused sub-agents one chunk at a time. |
| `pr-description` | Write a clear, useful PR description — a tight Why / How / Decisions / Callouts structure with no filler. |
| `shell-helpers` | Reusable orchestration shell helpers — freshen a checkout to a clean baseline, prune merged branches, and reap stale worktrees. |
| `shift-leader` | Run as the autonomous shift leader of a multi-PR / multi-agent effort — maximize progress, reach the away user only via AskUserQuestion, gate phases on PR merges (never merge yourself), and dispatch file-disjoint parallel worktree agents at high velocity. |
| `statusline` | A rich, multi-line status line for Claude Code — model, context-pressure bar, cost, git, PR, and rate limits on the main line, plus per-subagent gauges in the agent panel. |

## Install everything

Add the marketplace, then install each plugin:

```bash
/plugin marketplace add ShivaeDev/pardes

/plugin install base@pardes
/plugin install onboarding@pardes
/plugin install orchestrate@pardes
/plugin install pr-description@pardes
/plugin install shell-helpers@pardes
/plugin install shift-leader@pardes
/plugin install statusline@pardes
```

Or run `/plugin` to browse and install them interactively.

## Layout

```
.
├── .claude-plugin/
│   └── marketplace.json      # registers every plugin in this repo
├── changelog/
│   └── <plugin>.md           # per-plugin changelog (Keep a Changelog)
└── plugins/
    └── <plugin>/
        └── .claude-plugin/
            └── plugin.json   # name, version, description
```

## License

MIT
