# codex-workstreams

<p align="center">
  <img src="assets/pardes-card.png" alt="Pardes - a calm-coding marketplace of plugins and skills for coding agents" width="820">
</p>

Coordinate long-running Codex coding objectives through delegated
investigation, implementation, verification, and pull-request lifecycle
management.

## Install

First, register the Codex marketplace once. The app install link below needs
this marketplace to exist locally:

```bash
codex plugin marketplace add ShivaeDev/pardes --ref main
```

Then [install Codex Workstreams in the Codex app](codex://plugins/install/codex-workstreams?marketplace=pardes-codex),
or install it from the CLI:

```bash
codex plugin add codex-workstreams@pardes-codex
```

After installation, [start a Codex configuration session](codex://new?prompt=Use%20%24configure-workstream%20to%20set%20up%20the%20shared%20artifact%20directory.)
once to set up the narrow writable artifact directory used for checkpoints,
reports, and temporary pull-request bodies.

## Included Skills

- `configure-workstream`
- `drive-workstream`
- `investigate-codebase`
- `implement-change`
- `verify-change`
- `run-pr-cycle`
- `write-pr-description`
- `audit-workstream-run`
