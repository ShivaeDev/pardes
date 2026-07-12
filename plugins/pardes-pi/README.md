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
question · feedback
pardes_status · inbox_get · inbox_acknowledge
workstream_create · workstream_list · workstream_get · workstream_complete
report_get
pull_request_create
verification_request · verification_refresh · verification_status
agent_spawn · agent_status · agent_send · agent_send_report
agent_compact · agent_reload · agent_revive · agent_stop · agent_lease_cleanup
```

`question` is the single user-judgment surface. Its options array may be empty
for pure free-form input, and custom input is always available up to 4,000
characters. If attention was
delivered when the question opened, only that exact cursor is consumed after a
submitted non-blank answer; cancellation, failure, blank input, and queued or
later attention remain pending.

Writing-worker spawns require a reachable `origin` with a configured default
branch. Pardes resolves an immutable baseline and creates a managed worktree.
Before launching a writer—or a verifier in its fresh detached checkout—it runs
that checkout's executable `script/update` directly from the checkout root when
present; absence is a no-op. The hook inherits the manager environment, and its
shebang selects its interpreter. Pardes does not copy `.env` files or other
secrets; repository-owned hooks may implement their own worktree-aware setup.
A nonzero exit, signal, launch error, or timeout initiated at 15 minutes fails
provisioning before Pi is launched. The manager stops waiting after a bounded
final drain/exit-confirmation window; a nominally successful hook whose
inherited pipes do not settle also fails closed. This bounds orchestration, not
the lifetime of an escaped OS descendant. Status and output counts are durable,
while bounded output tails are terminal-only. A verifier checkout must also still be clean at
the captured head after the hook and before launch. Runtime launch or
launched-state persistence failure also classifies cleanup before removing provisional writer
ownership: dirty or unverifiable leases remain attached to a durable crashed
agent. A retained crashed agent never keeps a `running` bootstrap marker; an
unrecorded terminal outcome is normalized to interrupted with unknown
completion and termination. External cancellation during bootstrap runs an
uninterruptible manager settlement: writer leases and verifier scratch become
crashed, interrupted, and immediately available to conservative cleanup without
waiting for manager restoration. Retained revive does not rerun the hook, and
restoration never automatically reruns a hook whose completion was not observed.

Managed worktrees and verifier tool restrictions are workflow guardrails, not a
security sandbox: repository hooks, child Bash, and other same-user processes
can access resources available to that OS user. Pardes signals the directly
spawned process group on POSIX (the direct child elsewhere) on timeout or
interruption, but cannot observe or prove termination of a descendant that creates a new session. Timeout-uncertain,
lifecycle-unsettled, and restart-interrupted checkout ownership is therefore
retained for later inspection rather than declared safe. Use baseline branch
overrides only intentionally. Worker reports are stored under the owning
manager's `reports/` directory; concise summaries wake the manager. Retrieve a
known report with `report_get({ reportId })`: Pardes selects `details` when
present, otherwise `summary`, and automatically delivers the complete canonical
body in bounded ordered settlement runs without field or pagination parameters.
Separate runs permit compaction, retire prior raw parts from later model requests,
and replace persisted report bodies with bounded identity metadata in compaction
preparation without rewriting durable session history. A failed manager compaction
is canceled so delivery can resume. Pardes defers its own durable inbox wake while
report delivery owns the conversation, then retries the still-pending cursor after
report completion or cancellation. The hold begins before `report_get` awaits
artifact I/O, and read failure or cancellation releases it for durable wake
retry. A wake release that already crossed storage rechecks the lease and rolls
back its unsent cursor. Rollback completion refreshes durable state and
re-evaluates wake scheduling, so an earlier failure/abort retry that observed the
reservation cannot consume the only retry edge. At the final cursor-injection
boundary, one exact rendered wake identity is registered synchronously with
send. It blocks report acquisition only until its exact `message_start`; the
manager may then retrieve one report in that wake turn. Successful delivery
attaches to the interlude and dispatches part one only after the wake's
`message_end` and `agent_end`. Unregistered, malformed, mismatched, or replayed
custom messages still cancel and leave one bounded resumable
cancellation record rather than silently truncating the sequence. `/pardes stop`
is also a synchronous cancellation boundary: it retires every
scheduled, in-flight, or compaction-held report identity and invalidates permits
held by asynchronous artifact reads before deactivation. Restart issues a fresh
monotonic delivery epoch, so late pre-stop reads cannot create delivery.

Clean completion audits lead with bounded worker-branch non-merge change
candidates from cooperative first-parent evidence; topology does not prove
authorship or feature semantics. They label merge first-parent diffs separately
as integration context, retain the total branch-point delta, first-parent commit
count, and latest-commit evidence, and do not infer exact conflict-resolution
ownership from parent diffs. The routine-compatible total safety diff is also
subject to explicit Git timeout/output bounds (the provenance defaults, with
independent service overrides); if it cannot complete within them, Pardes
reports the total as unavailable and retains only explicitly known live paths.
Dirty, unsupported, or over-bound histories likewise degrade explicitly instead
of claiming attribution.

`pull_request_create` publishes a clean committed worker state as a
user-controlled review gate. After the exact pushed SHA is verified as the
hosted head, Pardes makes the retained local worker branch track the managed
`origin` review branch, including when their names differ. This local-only step
never pushes again; a bounded tracking failure is reported separately without
turning verified remote publication into failure. Browser handoff is explicit:
`browserMode: 'none'`
(the default), `'background'` (macOS `open -g`, with a portable ordinary-opener
fallback elsewhere), or `'foreground'`. The legacy `openInBrowser` boolean
remains a compatibility alias. Browser launch runs only after durable review-gate
association and lifecycle settlement; opener failure is non-fatal to successful
publication. Pardes never merges autonomously.

Structured state is written beneath `~/.pi/agent/pardes/`. Override that root
for development or tests with `PARDES_PI_STATE_DIR`.

## Frustration feedback

The model-facing `feedback({ text })` tool is available to managers, writing
workers, and advisory verifiers. It is deliberately general: if anything is
frustrating, confusing, broken, annoying, or wasteful, write it here. The tool
accepts only free-form text. Pardes adds bounded
provenance (time, id, role and available session/manager/agent/workstream,
repository, verifier, and version identities); it never automatically captures
logs, files, environment values, or secrets.

Each submission is an immutable atomic JSON record in the owner-only global
registry; existing registry directories and artifacts are tightened when read.
Addressed state is stored separately so triage never rewrites the submission.
The installed package exposes a human CLI:

```bash
pardes-feedback help
pardes-feedback list --addressed no
pardes-feedback show <feedback-id>
pardes-feedback watch --cursor triage
pardes-feedback address <feedback-id>
```

From a source checkout, use `bun run feedback -- <command>`. Watch cursors use
one durable initialization boundary, a recoverable cross-process scan lock, and
atomic per-entry receipts written only after output succeeds. Concurrent scans
do not duplicate output; a crash between output and receipt deliberately replays
the entry after restart for at-least-once delivery. A cursor consumes every
observed entry, including filter nonmatches, so use a distinct cursor name when
changing filters or triage purpose. CLI rendering treats feedback text as
untrusted and escapes terminal controls.

## Development validation

Hosted GitHub Actions is the normal integration authority. Run relevant
targeted checks for a bounded slice, publish its exact clean committed SHA, and
leave merges to the user. Full local readiness checks are appropriate for CI,
package integration, formatting policy, and other cross-cutting release
surfaces. See the
[package development validation policy](docs/NORTH_STAR.md#package-development-validation-policy)
for the exceptional uses of `bun run review:summary -- --base <sha>`.
