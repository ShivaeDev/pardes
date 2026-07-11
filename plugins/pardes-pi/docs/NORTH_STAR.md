# Pardes Pi: North Star

## Purpose

Pardes Pi is a local-first multi-agent orchestration control plane for
[Pi](https://pi.dev). This document defines the product boundary: the behavior
that should remain true as the implementation evolves and the decisions that
remain intentionally deferred.

For source boundaries and capability ownership, read
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Coordinating managers should follow the
living operating SOP in [`MANAGER.md`](./MANAGER.md).

## Problem

Long-running coding-agent workflows ask language models to perform too much
operational bookkeeping. Managers repeatedly spend context on worktree
creation, Git commands, checkpoint notes, process polling, pull-request
publication, watcher scripts, and feedback routing. That work is verbose,
error-prone, and mostly deterministic.

Pardes Pi moves deterministic orchestration into software so agents can focus on
engineering judgment:

- understand a problem;
- split work safely;
- implement bounded changes;
- review committed diffs adversarially;
- surface genuine decisions;
- route actionable feedback.

## Design principles

1. **Software owns mechanics; agents own judgment.** Worktrees, child processes,
   state transitions, publication, watcher attachment, and cleanup are services,
   not repeated prompt instructions.
2. **One active Pi session is one manager.** No daemon and no global singleton.
3. **Multiple managers are normal.** Independent manager sessions may operate in
   the same repository concurrently without sharing mutable manager state.
4. **Lifecycle is process-scoped.** When a manager exits, its attached children
   and watchers stop. Cross-manager recovery is deliberately out of scope.
5. **State is structured.** Typed JSON replaces Markdown checkpoint notes as the
   authoritative state. Agents use domain tools rather than editing state files.
6. **Isolation is mechanical where practical.** Writing workers receive managed
   Git worktrees. Verifiers receive disposable scratch checkouts with no
   `edit` or `write` affordances. Bash and same-user filesystem access are not a
   sandbox, so handoff and publication still require mechanical audits.
7. **Child agents are conversations, not one-shot calls.** A retained child Pi
   RPC session can receive additional prompts, steering messages, or queued
   follow-ups.
8. **No model-side polling.** Watchers and child-process events wake the manager
   only when something actionable changes.
9. **PRs are review gates.** The system may publish and monitor pull requests.
   It never merges autonomously.
10. **Manager context is scarce.** Durable reports stay outside the manager
    conversation until explicitly retrieved. One retrieval selects the canonical
    body and delivers it completely through bounded ordered settlement runs so
    compaction can occur between parts; prior raw parts leave subsequent model
    request context and become bounded identity-only placeholders in compaction
    input while durable session entries remain unchanged. Status, inbox rows,
    diagnostics, and each transport part
    remain bounded and explicit.
11. **Validation is repository-aware.** Managers follow target-repository
    instructions, prefer configured hosted checks when present, and leave merges
    to the user.

## Explicit non-goals

- no background daemon;
- no active computation surviving manager termination;
- no global scheduler across managers;
- no cross-manager work adoption or recovery;
- no SQLite database while one manager process remains the only state writer;
- no autonomous merge operation;
- no trusted execution of arbitrary pull-request comments, CI logs, or child
  report content;
- no claim that Bash is sandboxed;
- no speculative workflow library ahead of concrete reviewed slices.

## Runtime topology

```text
Pi manager session
└── Pardes extension instance
    ├── manager-scoped typed state store and append-only audit trail
    ├── manager-scoped durable inbox and bounded report artifacts
    ├── repository, worktree, and detached-review-checkout services
    ├── compact widget, optional bridge monitor, and dashboard overlay
    ├── GitHub publication service and PR watchers
    ├── pinned manager-scoped child-runtime snapshot
    └── retained child Pi RPC processes
        ├── writing worker in a managed worktree
        └── advisory verifier in a disposable scratch checkout
```

Manager mode is opt-in. An ordinary Pi session remains ordinary until the user
activates a manager. Activation generates a unique `managerId`, records it in
Pi extension state, and materializes the pinned child-runtime snapshot used for
subsequent launches.

## Multiple managers

There is no process-global manager singleton. Every activated Pi session owns a
unique manager namespace. Two managers in one repository may coordinate
unrelated efforts concurrently.

Durable manager state lives beneath:

```text
~/.pi/agent/pardes/
└── projects/
    └── <repo-key>/
        └── managers/
            └── <manager-id>/
                ├── state.json
                ├── events.jsonl
                ├── reports/
                ├── runtime/
                └── sessions/
```

Managed writing worktrees live beneath:

```text
<primary-checkout>/.worktrees/pardes/<manager-id>/<agent-id>
```

Git worktree mutations touch shared repository metadata, so managers use a
repository-scoped filesystem lock around critical mutations such as
`git worktree add`, `git worktree remove`, and `git worktree prune`. This lock is
not a global controller and is held only for the mutation itself.

## Repository and worktree model

The repository service discovers the primary checkout through Git's common
directory. It does not assume the manager started in the primary checkout.

Writing workers branch from an explicit immutable commit SHA, normally resolved
from the configured `origin` default branch. They never branch implicitly from
whichever local checkout happens to be open. The primary checkout is a Git
anchor, not a shared staging area.

A writing-worker spawn:

1. resolves repository metadata;
2. fetches the configured `origin` default branch, or one validated intentional
   branch override, and resolves it to one exact immutable commit SHA;
3. acquires the repository worktree lock;
4. creates a namespaced worktree and branch from that SHA;
5. records the managed lease and a durable worktree-bootstrap state;
6. if the fresh checkout has `script/update`, executes it directly from the
   checkout root (honoring its executable bit and shebang); absence is a no-op;
7. for a verifier, re-inspects that the detached checkout is still clean at the
   captured immutable head after bootstrap;
8. launches a retained child Pi RPC process only after preparation succeeds;
9. tracks lifecycle state and bounded activity telemetry;
10. audits actual Git state at handoff and publication;
11. preserves dirty or unverifiable worktrees;
12. removes retained artifacts only through explicit conservative cleanup.

Detached verifier checkout creation and refresh use the same pre-launch
bootstrap convention. The hook inherits the manager process environment; Pardes
does not inspect or copy repository secret files, though repository-owned hooks
may deliberately symlink or generate local configuration. Hook output is
bounded in memory, only body-free counts are durable, and terminal-only tails
support local diagnosis. Failure or timeout initiation at 15 minutes prevents
child launch and enters conservative compensation. Writer failures—including
runtime launch or launched-state persistence after successful bootstrap—classify
cleanup before removing provisional ownership. They retain a durable agent/lease
whenever the checkout is dirty, cleanup is unverifiable, or process
lifecycle/timeout leaves termination uncertain. Verifier uncertainty keeps
retryable scratch ownership rather than immediately declaring disposal safe. A
crashed retained agent cannot remain durably marked as running bootstrap; a
missing terminal record is normalized to interrupted with completion and
termination unknown. External cancellation during bootstrap performs an
uninterruptible durable settlement at the manager boundary: writer leases and
verifier scratch remain crashed, interrupted, and immediately eligible for
conservative inspection or cleanup without a restart. Retained revive does not
rerun bootstrap. After restoration, an observed in-flight bootstrap is marked
interrupted and repository code is never rerun automatically.

The process adapter signals its directly spawned process group on POSIX (the
direct child elsewhere) on timeout and Effect interruption, observes
direct-child exit, and stops waiting after a bounded final drain or
exit-confirmation window. This bounds manager
orchestration only. A zero-exit hook whose inherited output pipes remain open
past the final drain fails closed as lifecycle-unsettled. Pardes still cannot
observe or prove termination of a descendant that creates a new session and
closes those pipes, and abrupt manager death cannot perform reconciliation.
A later explicit cleanup is therefore an operator-controlled retry edge, not
proof that an escaped process previously stopped.

This execution is not security isolation. Repository hooks and child Bash run as
the same OS user as the manager and can access that user's files, credentials,
processes, and network capabilities. Worktrees, tool profiles, bounded output,
and cleanup policy are correctness guardrails rather than a sandbox.

Parallel writing workers may overlap source paths because each writes in an
isolated worktree. Actual changed paths are audited at handoff and publication so
reviewers can inspect the bounded diff before any user-controlled merge.

Managers remain control-plane sessions and do not edit source directly.

## TypeScript and Effect v4

The implementation is TypeScript-only and uses Bun for package management and
scripts.

Use Effect v4 as the application architecture rather than hand-rolling async
control flow. In particular, prefer Effect for:

- schemas and decoding at storage, process, and GitHub boundaries;
- typed domain errors;
- services and layers;
- scoped resource acquisition and cleanup;
- child-process and watcher lifecycles;
- fibers and interruption;
- queues, pub-sub, semaphores, and serialized mutations;
- retries and schedules where appropriate;
- deterministic testing.

Effect v4 is beta. Keep the dependency pinned and consult the version-aligned
source reference described in [`references/README.md`](./references/README.md)
before assuming an API.

## Durable state, reports, and attention

The typed filesystem store is the authoritative current projection. Every state
mutation is serialized by the manager process, increments a revision, writes a
temporary file, and atomically renames it into place. Child agents and PR
watchers report events to the owning extension instance; they do not write
manager state themselves.

```text
<manager-id>/
├── state.json      # authoritative current projection
├── events.jsonl    # append-only audit trail
└── reports/        # bounded-write child and verifier artifacts
```

The durable schema includes workstreams, agents, pull-request review gates,
advisory verifications, inbox rows, and optional delivered-cursor and user-
handoff markers. Storage and lifecycle services validate namespace ownership,
repository identity, retained session paths, worktree leases, and detached
review checkouts before trusting restored artifacts.

Long child reports remain outside manager context until explicitly retrieved.
Manager-visible retrieval is opt-in by path-free report ID, automatically selects
`details` when present and otherwise `summary`, and delivers that canonical body
through trust-labelled, JSON-escaped, bounded ordered settlement runs without
model-managed pagination. A delivery never uses Pi's shared follow-up queue for
report parts. Pardes holds its own durable inbox wake injection until that
delivery completes or cancels. The hold starts with a transient acquisition
lease before report artifact I/O and converts atomically into active delivery;
read failure or cancellation releases it for durable retry. Wake release
rechecks after cursor persistence and rolls back an unsent reservation when the
lease wins. Rollback completion refreshes state and independently re-evaluates
wake scheduling, closing any retry edge consumed while the reservation was still
visible. If wake injection wins, exact identity registration and send share
one synchronous final boundary. The queued wake blocks acquisition only until
its exact `message_start`; one retrieval may then lease the wake turn, attach
successful delivery to that interlude, and wait for `message_end` plus
`agent_end` before dispatching part one. Unregistered, malformed, mismatched, or
replayed custom messages remain foreign. Unrelated user or custom input still
cancels the exact in-memory identity rather than interleaving and emits one
bounded resumable cancellation
record. Reload or
shutdown cancels every not-yet-dispatched part and releases the transient hold;
restored durable inbox state remains the wake retry authority. Explicit manager
stop synchronously retires the whole delivery identity—including scheduled, in-flight,
and compaction-held phases—and invalidates permits captured before asynchronous
artifact reads. Restart advances a monotonic epoch, preventing late pre-stop reads
from creating delivery after deactivation or competing with fresh retrieval.

Wake handling has three distinct layers:

```text
durable inbox state
append-only audit history
Pi presentation delivery scheduled for the manager conversation
```

Actionable events enter the durable inbox before presentation. Causally
derivative software context may be coalesced onto its triggering row: a terminal
worker report that invalidates advisory verification evidence carries that stale
context without a second attention row, while both facts remain externally
visible. Durable exact-event intents idempotently repair either audit append
across failure or manager restart before presentation refinement is released.
Malformed event-log bytes are preserved in a manager-scoped corruption artifact;
all parseable records are retained in a repaired active stream, and bounded
storage status distinguishes trailing fragments from interior corruption. Thus
both facts remain append-only audited. Tokenized wake records are presentation cursors,
not workflow state. Only one delivered cursor is active at a time; later durable
rows remain queued as a suffix. User-judgment handoffs are explicit and
cursor-scoped.

## Retained child model

Writing workers run as persistent `pi --mode rpc` subprocesses with explicit:

- role profile;
- managed cwd;
- retained session path;
- model and thinking level;
- tool allowlist;
- workstream association;
- task briefing.

A completed child becomes idle rather than disappearing. The manager can send a
new prompt, steer an active child, queue a follow-up, request manual compaction,
reload the child extension from its pinned snapshot, stop the child, or revive a
stopped retained conversation.

When the manager shuts down gracefully, it interrupts attached children and
watchers. Dirty worktrees and unmerged branch history are preserved by default.
Stopped leases can be inspected and cleaned explicitly; destructive discard or
unmerged-history deletion requires separate force intent.

## Role-specific capabilities

### Manager

The manager coordinates work rather than editing source. Its model-visible tools
are grouped by purpose:

```text
question
pardes_status · inbox_get · inbox_acknowledge
workstream_create · workstream_list · workstream_get · workstream_complete
report_get
pull_request_create
verification_request · verification_refresh · verification_status
agent_spawn · agent_status · agent_send · agent_send_report
agent_compact · agent_reload · agent_revive · agent_stop · agent_lease_cleanup
```

Status projections remain compact by default. Deeper storage, cleanup,
composition, GitHub-health, verification, review, worker, and inbox inspection
is opt-in.

### Writing worker

A writing worker receives ordinary coding tools rooted in one managed worktree.
The extension rejects file-tool paths outside the assigned worktree. Bash is not
a complete security boundary, so completion, publication, and cleanup paths
also audit changed files and Git state.

### Advisory verifier

An advisory verifier runs in a fresh detached scratch checkout pinned to the
reviewed worker SHA. It has path-rooted read tools, Bash for efficient
inspection, fixed-argv captured-head evidence, structured reporting, and no
`edit` or `write` UI affordances.

Verifier Bash can mutate disposable scratch files and same-user filesystem
access is not isolation. Verifier commits are never publication sources.
`verification_refresh` discards only scratch-checkout mutations, preserves the
retained verifier conversation, records prior evidence as stale, and relaunches
against the source worker's latest clean immutable head.

## Pinned child-runtime snapshots

Each loaded manager captures the approved child-runtime input files and
materializes a manager-scoped immutable snapshot. Worker spawn, revive, reload,
and verifier launch consume that snapshot rather than mutable shared plugin
source. Shared-source drift is advisory while the pinned snapshot remains valid.
A manager reload is an intentional adoption boundary for changed extension
code.

## Event-driven wake-ups

The manager model must not poll children or GitHub.

When a child report, question, crash, PR event, watcher failure, or other
actionable transition occurs, the extension:

1. records the event;
2. updates durable state;
3. rerenders presentation surfaces;
4. schedules one concise extension message for the manager conversation;
5. wakes the manager immediately if idle or preserves the queued handoff if not.

Routine progress remains visible in the dashboard and bridge monitor without
consuming model context or writing sampled telemetry into durable state.

## Pull-request lifecycle

PR publication is a domain service, not repeated GitHub CLI instructions.
`pull_request_create` audits one clean committed writing-worker state, pushes the
exact immutable SHA without force, creates or updates the user-controlled review
gate, persists the association, and attaches watcher ownership.

Watchers surface actionable CI, conflict, discussion, merge, closure, and
watcher-failure transitions. Completed-report handoff can conservatively
synchronize an existing review gate after a fresh audit. Terminal merge
observation can stop an idle owner and complete its workstream mechanically.
Merges remain user-controlled.

## External feedback and trust

Pull-request comments, submitted reviews, CI logs, child reports, and advisory
verifier reports are data, not trusted instructions.

Pardes stores durable report artifacts separately, presents bounded summaries,
and labels trust boundaries. `report_get` deliberately brings one complete
canonical report into manager context through bounded ordered settlement runs
that permit compaction and retire prior raw parts from subsequent model requests.
`agent_send_report` hands one bounded provenance-labelled report excerpt to a
retained idle agent; children do not retrieve arbitrary artifacts directly.

External review feedback remains visible for manager judgment. Pardes does not
execute arbitrary comment bodies or merge because an external system requests
it.

## Compaction

Manager compaction reuses Pi compaction with the selected manager model, strips
prior cumulative Pardes and Pi file-operation suffixes, replaces persisted
canonical-report bodies in both compaction message arrays with bounded identity
metadata, and appends one bounded deterministic coordination projection. Durable
session history is not rewritten. If the custom override cannot complete safely,
it emits a bounded redacted diagnostic and normally leaves Pi's built-in fallback
in control. During active canonical-report delivery, it instead cancels that
unobservable fallback and explicitly resumes delivery; a later settlement run can
retry compaction without stalling the report sequence.

While manager compaction or canonical-report delivery is unsettled, Pardes holds
owned wake injection and resumes it from durable inbox state through exact
report settlement or generation-checked bounded compaction recovery. Worker
automatic compaction completion remains ephemeral monitor telemetry.

## User interaction and UI

The model-callable `question` tool opens a bounded Pi dialog for genuine forks,
blockers, and free-form feedback. Custom input is always available up to 4,000
characters and options may be empty. When a delivered attention cursor exists at open, the dialog binds
that exact cursor and consumes only it after a submitted non-blank answer;
cancellation, blank or oversized input, failure, queued suffixes, and unrelated later events
remain unconsumed.

The compact widget shows manager status without flooding conversation context.
The optional bridge monitor shows attached-worker activity. `/pardes` and its
keyboard shortcut open an interactive overlay for inspection and manual
controls. Pi extension commands are intercepted before model processing, so
opening the overlay does not enter chat context or interrupt a child.

Widgets are status surfaces, not mouse-driven controls. The overlay owns
keyboard interaction.

## Package development validation policy

This section applies only to contributors developing Pardes Pi. It is not
runtime guidance for Pardes managers coordinating arbitrary target repositories.

Hosted GitHub Actions is the normal integration authority. Contributors should
run relevant targeted checks for a bounded slice, publish exact clean audited
SHAs, and let the user control review and merge. Full local readiness checks are
appropriate when changing CI, package integration, formatting policy, or other
cross-cutting release surfaces, and when explicitly requested by the user.

## Safety invariants

The implementation should preserve these mechanically where practical:

- every manager has an independent namespace;
- worktree mutations are repository-lock protected;
- writing workers branch from explicit immutable SHAs;
- cleanup never deletes dirty worktrees or unmerged history without explicit
  destructive intent;
- worker file tools reject paths outside their managed worktree;
- actual changed paths and Git cleanliness are audited at handoff and
  publication;
- verifier scratch is disposable, verifier evidence is advisory, and verifier
  commits are never published;
- exact-SHA publication fails closed and never force-pushes to conceal an
  unexpected remote state;
- no autonomous merge tool exists;
- external feedback, canonical report deliveries, and report handoff excerpts are
  labelled and routed deliberately;
- durable reports, watcher metadata, diagnostics, and model-facing projections
  remain bounded;
- durable inbox truth is distinct from tokenized presentation cursors;
- pinned child-runtime snapshots prevent shared-source drift from silently
  changing attached child behavior.

## Deferred decisions

Revisit these only when a concrete reviewed slice needs them:

- whether manager sessions should receive dedicated worktrees;
- whether to add a read-only explorer launch profile;
- whether GitHub integration should move beyond the current `gh` boundary;
- how much Bash policy to enforce before introducing an OS sandbox;
- whether higher-level workflow tools should hide more low-level primitives;
- whether process-scoped lifecycle pressure justifies a daemon;
- whether multiple writers or query pressure justify SQLite;
- whether configured-author feedback routing is useful without weakening the
  external-input trust boundary.
