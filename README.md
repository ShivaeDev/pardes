<p align="center">
  <img src="assets/pardes-card.png" alt="Pardes — a calm-coding collection of plugins and skills for coding agents" width="820">
</p>

*Pardes* (פרדס) means "orchard" or "walled garden" — the ancient root the word
*paradise* itself grows from. It's a tended garden of small, sharp tools that
make coding calmer and more deliberate.

Pardes supports three coding-agent harnesses. Choose the one you use:

| Harness | What Pardes provides |
| --- | --- |
| [Pi](https://pi.dev) | A local-first multi-agent orchestration control plane |
| Claude Code | A marketplace of focused, composable plugins and skills |
| Codex | Long-running delegated workstream skills |

## Pardes for Pi

Pardes for Pi is a local-first multi-agent orchestration control plane. It
provides durable workstreams, isolated managed worktrees, retained child Pi
sessions, advisory verifiers, bounded manager attention, and user-controlled PR
review gates.

### Install

Install the latest `main` branch directly from GitHub:

```bash
pi install git:github.com/ShivaeDev/pardes
```

This intentionally tracks `main`. Pull later updates with:

```bash
pi update --extensions
```

From a local checkout, use:

```bash
pi install .
```

### Get started

Start an interactive Pi session and activate manager mode:

```text
/pardes start
```

Use `/pardes` to open the dashboard overlay.

### Learn more

See the [Pardes for Pi README](plugins/pardes-pi/README.md) for manager commands,
tools, and development guidance.

## Pardes for Claude Code

Pardes for Claude Code is a marketplace of composable plugins: orchestration
skills, reusable workflows, worktree helpers, PR writing, onboarding, and a
status line.

### Install

Install everything with the `pardes-all` meta plugin:

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install pardes-all@pardes
```

> Auto-installing and auto-enabling dependencies requires **Claude Code
> v2.1.143+**. On older versions, install plugins individually.

To pick and choose instead:

```bash
/plugin marketplace add ShivaeDev/pardes

/plugin install base@pardes
/plugin install onboarding@pardes
/plugin install orchestrate@pardes
/plugin install pr-description@pardes
/plugin install shell-helpers@pardes
/plugin install shift-leader@pardes
/plugin install statusline@pardes
/plugin install workflows@pardes
```

Or run `/plugin` to browse and install interactively.

### Get started

New to Pardes? Install `onboarding` and run its skill. It gives you a guided
tour of the Claude Code plugins and how they compose, then offers an advisory
settings check. It never changes settings without your explicit confirmation.

### Learn more

| Plugin | What it does |
| --- | --- |
| `base` | Foundational scaffold — shared hooks and core skills land here as the marketplace grows. |
| `onboarding` | Explain the marketplace and tune your setup through an advisory config doctor. |
| `orchestrate` | Plan a large multi-chunk PR through a user interview, then ship it through focused sub-agents. |
| `pardes-all` | Install every Claude Code plugin in the marketplace at once. |
| `pr-description` | Write a clear Why / How / Decisions / Callouts PR description without filler. |
| `shell-helpers` | Freshen checkouts, prune merged branches, and reap stale worktrees. |
| `shift-leader` | Run a multi-PR, multi-agent effort while leaving merges under user control. |
| `statusline` | Show model, context pressure, cost, Git, PR, rate-limit, and sub-agent status. |
| `workflows` | Reuse writer→reviewer, investigation, and parallel-edit-then-verify orchestration scripts. |

## Pardes for Codex

Pardes for Codex ships `codex-workstreams`, a marketplace plugin for delegated
investigation, implementation, verification, and pull-request lifecycle
management.

### Install

Register the Codex marketplace once:

```bash
codex plugin marketplace add ShivaeDev/pardes --ref main
```

Then [install Codex Workstreams in the Codex app](codex://plugins/install/codex-workstreams?marketplace=pardes-codex),
or install it from the CLI:

```bash
codex plugin add codex-workstreams@pardes-codex
```

### Get started

After installation, [start a Codex configuration session](codex://new?prompt=Use%20%24configure-workstream%20to%20set%20up%20the%20shared%20artifact%20directory.)
once to set up the narrow writable artifact directory used for checkpoints,
reports, and temporary pull-request bodies.

### Learn more

See the [Codex Workstreams README](plugins/codex-workstreams/README.md) for the
included skills.

## Repository layout

```text
.
├── .agents/
│   └── plugins/
│       └── marketplace.json  # registers Codex plugins
├── .claude-plugin/
│   └── marketplace.json      # registers Claude Code plugins
├── changelog/
│   └── <plugin>.md           # per-plugin changelog (Keep a Changelog)
├── package.json              # Pi package manifest and repository scripts
└── plugins/
    ├── <claude-plugin>/
    │   └── .claude-plugin/
    │       └── plugin.json   # Claude Code plugin manifest
    ├── codex-workstreams/
    │   └── .codex-plugin/
    │       └── plugin.json   # Codex plugin manifest
    └── pardes-pi/            # Pi extension source tree
```

## License

MIT
