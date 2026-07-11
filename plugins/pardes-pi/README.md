# Pardes for Pi

A local-first multi-agent orchestration control plane for [Pi](https://pi.dev).
It provides durable workstreams, isolated managed worktrees, retained child Pi
sessions, advisory verifiers, bounded manager attention, and explicit PR review
gates.

## Start here

Read [`docs/NORTH_STAR.md`](docs/NORTH_STAR.md) before implementation work.
Coordinating managers should also maintain and follow the living
[`docs/MANAGER.md`](docs/MANAGER.md) operating SOP.

## Toolchain

- Bun for package management and scripts
- Effect v4 beta for typed errors, schemas, concurrency, resources, and services
- Pi extensions for tools, events, session integration, and TUI components

Dependencies have a seven-day release-age cooldown in the repository-root
[`bunfig.toml`](../../bunfig.toml).

## Local Effect source reference

From the Pardes repository root:

```bash
bun run references:effect
```

This creates an ignored, version-aligned checkout at
`plugins/pardes-pi/docs/references/effect-smol/` for source and documentation
lookup.

## Install and update

Install the latest `main` branch directly from GitHub:

```bash
pi install git:github.com/ShivaeDev/pardes
```

This install intentionally tracks `main`. Pull later updates with:

```bash
pi update --extensions
```

From the root of a local Pardes checkout, use:

```bash
pi install .
```

The package also loads the reviewer-first `pardes-pr-description` skill. Invoke
`/skill:pardes-pr-description` when publishing or rewriting a PR.

For development inside this directory, load the extension directly:

```bash
pi -e ./extensions/pardes/index.ts
```

## Manager mode

Manager mode is opt-in. In an interactive Pi session:

```text
/pardes start    activate a manager scoped to this Pi session
/pardes          open the dashboard overlay
/pardes monitor  toggle the attached-worker bridge monitor
/pardes config   configure Pardes-owned tool-row presentation
/pardes stop     deactivate the manager
```

`Ctrl+Alt+D` opens the dashboard overlay. The compact widget and optional bridge
monitor show manager and attached-worker status without writing sampled
telemetry into durable state.

One loaded controller uses one fixed GitHub.com repository and caller-held
credential context. After hosted GitHub work starts, repository changes are
detected and fail safe. Ambient `gh` credential changes cannot be proved by the
adapter: do not switch credentials in place. Reload the manager extension first
to create a fresh controller before adopting another repository or credential
context.

GitHub budget tokens are transient last-render samples. Tier and outage changes
refresh manager surfaces; Pardes does not run a background UI timer solely to
refresh same-tier numeric counts.

The manager-visible tools are grouped by purpose:

```text
question
pardes_status · inbox_get · inbox_acknowledge · await_user_feedback
workstream_create · workstream_list · workstream_get · workstream_complete
report_get
pull_request_create
verification_request · verification_refresh · verification_status
agent_spawn · agent_status · agent_send · agent_send_report
agent_compact · agent_reload · agent_revive · agent_stop · agent_lease_cleanup
```

Writing-worker spawns require a reachable `origin` with a configured default
branch. Pardes resolves an immutable baseline, creates an isolated managed
worktree, and retains the child Pi conversation for follow-up. Use baseline
branch overrides only intentionally. Worker reports are stored under the owning
manager's `reports/` directory; concise summaries wake the manager. Retrieve a
known report with `report_get({ reportId })`: Pardes selects `details` when
present, otherwise `summary`, and automatically delivers the complete canonical
body in bounded ordered settlement runs without field or pagination parameters.
Separate runs permit compaction, retire prior raw parts from later model requests,
and replace persisted report bodies with bounded identity metadata in compaction
preparation without rewriting durable session history. A failed manager compaction
is canceled so delivery can resume; unrelated input cancels rather than interleaves.

`pull_request_create` publishes a clean committed worker state as a
user-controlled review gate. Browser handoff is explicit: `browserMode: 'none'`
(the default), `'background'` (macOS `open -g`, with a portable ordinary-opener
fallback elsewhere), or `'foreground'`. The legacy `openInBrowser` boolean
remains a compatibility alias. Browser launch runs only after durable review-gate
association and lifecycle settlement; opener failure is non-fatal to successful
publication. Pardes never merges autonomously.

Structured state is written beneath `~/.pi/agent/pardes/`. Override that root
for development or tests with `PARDES_PI_STATE_DIR`.

## Development validation

Hosted GitHub Actions is the normal integration authority. Run relevant
targeted checks for a bounded slice, publish its exact clean committed SHA, and
leave merges to the user. Full local readiness checks are appropriate for CI,
package integration, formatting policy, and other cross-cutting release
surfaces. See the
[package development validation policy](docs/NORTH_STAR.md#package-development-validation-policy)
for the exceptional uses of `bun run review:summary -- --base <sha>`.
