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
| `orchestrate` | Plan a large multi-chunk PR through a user interview, then ship it by dispatching focused sub-agents one chunk at a time. |
| `pr-description` | Write a clear, useful PR description — a tight Why / How / Decisions / Callouts structure with no filler. |

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
