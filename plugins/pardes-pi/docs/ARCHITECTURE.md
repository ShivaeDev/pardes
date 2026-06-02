# Pardes Pi Architecture Conventions

## Purpose

This document records durable implementation conventions for evolving Pardes Pi
one reviewed vertical slice at a time. Read it with [NORTH_STAR.md](./NORTH_STAR.md).
The North Star defines product boundaries; this file records source boundaries
and integrated capability ownership.

Migrate coherent capabilities end to end: identify the port, adapters, lifecycle
owner, schemas, errors, and public entrypoint; preserve import direction; and
document only conventions that generalize. Do not split by line count, extract
tiny wrappers, move code merely to create files, or add prose to justify a new
file.

## Capability boundaries and public entrypoints

Prefer a domain folder under `extensions/pardes/` when a capability owns a
coherent external boundary, service lifecycle, aggregate, or non-trivial policy.
Each bounded-context folder has one public `index.ts`; outside callers import
only that entrypoint. Current boundaries are intentionally asymmetric:

```text
extensions/pardes/
├── manager/                      # manager aggregate and control plane
│   ├── index.ts                  # only manager import path for outside callers
│   ├── controller.ts             # extension-scoped lifecycle owner
│   ├── domain.ts                 # durable schema-v1 aggregate projection
│   ├── inputs.ts                 # model/tool input decoding
│   ├── namespace.ts              # durable namespace and retained-path validation
│   ├── activation-safety.ts      # pinned child-runtime snapshot and guard
│   ├── agent-attachment-lifecycle.ts # spawn, revive, stop, and rollback lifecycle
│   ├── inbox.ts                  # tokenized durable wake and attention-handoff policy
│   ├── attention.ts              # pure attention classification
│   ├── idle-disposition.ts       # pure idle-worker projection
│   ├── worker-events.ts          # pure bounded worker-event handoff policy
│   ├── worker-event-coordinator.ts # serialized incoming worker-event handoff
│   ├── guidance.ts               # compact manager lifecycle guidance
│   ├── compaction.ts             # bounded manager-compaction projection
│   ├── publication-coordinator.ts # serialized exact-SHA publication and auto-sync
│   ├── review-gate-lifecycle.ts  # serialized watcher and merged-retirement lifecycle
│   ├── verification.ts           # retained advisory-verifier lifecycle
│   └── lease-cleanup.ts          # explicit retained-lease cleanup policy
├── tools/                        # model-visible Pi adapters and bounded projections
│   ├── index.ts                  # registration composition
│   ├── agents.ts                 # worker lifecycle registrations
│   ├── control-plane.ts          # status and inbox registrations
│   ├── workstreams.ts            # workstream registrations
│   ├── pull-requests.ts          # publication registration
│   ├── reports.ts                # opt-in bounded report retrieval
│   ├── verifications.ts          # advisory verification registrations
│   ├── attention-handoff.ts      # await_user_feedback registration
│   ├── question.ts               # interactive decision question
│   ├── registration.ts           # shared adapter helpers
│   ├── projections.ts            # shared bounded-rendering core
│   └── *-projections.ts          # capability-owned model-facing projections
├── github/                       # GitHub publication and watcher integration
├── git/                          # discovery, baselines, writing leases, detached review checkouts
├── reporting/                    # durable report semantics and bounded retrieval
├── storage/                      # manager-scoped durable filesystem adapter
├── worker-runtime/               # retained child RPC, worker/verifier profiles, verifier evidence
└── presentation/                 # Pi and terminal presentation adapters
    └── attention-dialog.ts       # bounded await_user_feedback input
```

Do not create folders merely to mirror file types. Keep small pure helpers near
the owning domain. A bounded context does not absorb adjacent capabilities: the
manager owns aggregate workflow; GitHub owns remote publication and watcher
transport; Git owns baselines and worktree mechanics; storage owns serialized
filesystem persistence; worker runtime owns retained child processes; and
presentation owns Pi UI calls and terminal rendering.

When the manager aggregate embeds a value owned elsewhere, define its schema in
the owning context and compose it through the public entrypoint. Keep semantic
validation that depends on namespaces, filesystem state, or external inspection
beside the owning service rather than in wire-schema validation.

## Integrated lifecycle ownership

One extension-scoped manager controller owns activation, restoration, shutdown,
inbox release, and composition of active-manager services. Each active manager
allocates narrow lifecycle coordinators:

- activation safety captures the loaded child-runtime inputs once, materializes
  a manager-scoped immutable snapshot on activate or restore, and requires that
  pinned snapshot for worker spawn, revive, reload, and verifier launch;
- attachment lifecycle owns worker spawn, revive, stop, and persistence-failure
  rollback while preserving dirty or unverifiable worktrees;
- the publication coordinator serializes explicit exact-SHA publication and
  completed-report auto-sync;
- review-gate lifecycle serializes watcher observations, durable review
  attention, conservative merged-review retirement, safe idle-owner stop, and
  mechanical workstream completion;
- worker-event coordination serializes retained-child telemetry, status, report,
  and exit handoff; persists report artifacts; audits completion; reconciles
  verifier staleness; triggers publication auto-sync; and retries safe merged
  retirement after idle;
- verification lifecycle owns advisory request, status, refresh, attempt lineage,
  and stale-evidence reconciliation.

GitHub remains responsible for remote publication and watcher mechanics. Git
remains responsible for namespace validation, worktree classification, and
shell-free argv mutation.

## Advisory verification boundary

Advisory verification is software-owned and separate from publication. The
manager-side tools are `verification_request`, `verification_status`, and
`verification_refresh`; `pardes_status(view="verifications")` exposes the compact
overview. A request accepts one clean writing-worker head, records its immutable
SHA, creates a manager-namespaced detached scratch checkout, and launches a
retained verifier profile. Refresh preserves the verifier conversation, discards
only disposable verifier-checkout mutations, records prior evidence as stale,
and relaunches against the latest clean source head.

The verifier profile has Bash and path-rooted read tools but no `edit` or `write`
UI affordances. Bash mutation and same-user filesystem access are not isolation.
Verifier commits are disposable and never publication sources. Its
`verification_evidence` tool executes fixed Git inspection argv and returns
bounded captured-head, checkout-cleanliness, and changed-path evidence.

## Ports, adapters, and bounded output

Keep orchestration pointed inward and external mechanics behind adapters:

- caller-facing services are ports;
- `gh`, `git`, filesystem, process invocation, and Pi UI integration are
  adapters;
- external JSON is decoded at adapter boundaries with Effect `Schema` codecs;
- transport retains structured raw diagnostics for auditability;
- model-facing renderers expose bounded, redacted summaries only.

Construct presentation adapters per loaded extension when transient UI state has
a lifecycle. Inject narrow update ports into controllers; keep Pi `ctx.ui` calls
and TUI mechanics in adapters. Keep filesystem inspection observe-only and
bounded: return aggregate metadata rather than paths, listings, or artifact
content, and degrade leaf observation failure to explicit unavailable metadata
when the parent projection remains useful.

## Durable state, reports, and wakes

The schema-v1 filesystem projection is authoritative. Every active manager has
an independent namespace. Storage serializes mutation, append-only audit
history, report artifacts, and bounded inspection. The manager validates its
activation namespace and repository identity before trusting restored state.
Owning services validate worktree leases, detached review checkouts, and
retained session paths before lifecycle operations.

Reporting owns report schemas, path-free IDs, creation semantics, structural
manager-event references, and bounded excerpts. Storage writes lossless
artifacts and reads one known direct manager-scoped leaf without following
redirects. Report retrieval remains opt-in by ID, trust-labelled, JSON-escaped,
and separate from runtime diagnostics.

Keep wake handling as three layers:

```text
durable inbox state
append-only audit history
Pi presentation delivery scheduled for the manager conversation
```

Actionable events enter the inbox before presentation. Tokenized wake records are
presentation cursors, not workflow state. At most one compact wake is released
for an outstanding batch while idle. Terminal merge attention remains visible
until acknowledged even when conservative retirement can stop an idle owner and
complete a workstream mechanically.

## Compaction and retained-worker RPC

Manager compaction reuses Pi compaction with the selected manager model, strips
prior cumulative Pardes and Pi file-operation suffixes, and appends one bounded
deterministic coordination projection. If the custom override cannot complete
safely, it emits a bounded redacted diagnostic and leaves Pi's built-in fallback
in control. While manager compaction is unsettled, Pardes holds owned wake
injection and resumes it through generation-checked bounded recovery. Worker
automatic compaction completion remains ephemeral monitor telemetry.

Keep three retained-worker payload limits distinct:

```text
transport framing circuit breaker
  last-resort bound against runaway records

durable report artifact
  lossless worker-authored content

model-visible summary or excerpt
  bounded for context and UI usability
```

Pi RPC emits LF-delimited JSON records that may include whole tool results or
messages. Discard an oversized or malformed record through its next LF delimiter
so later records continue. Persist accepted report artifacts without automatic
bulk ingestion; expose bounded summaries or references.

## Effect services and import direction

Use `Context.Service` class syntax for effectful capabilities with meaningful
ports. Add a `Layer` when it provides a production implementation or composes
dependencies. Use scopes and finalizers for watcher fibers and subprocesses, and
Effect semaphores for shared ordering. Do not add service ceremony to pure
schemas, codecs, projections, or transition policies.

Import rules:

1. Code outside a bounded context imports only its public `index.ts`.
2. Internal modules import each other directly, not through their barrel.
3. Adapters and codecs do not import controllers or UI code.
4. Controllers depend on ports, not concrete argv transports.
5. Pure schemas remain isolated from services and process APIs.
6. Domain errors live with their domain; shared formatting may consume them.
7. Aggregate schemas compose externally owned values through public entrypoints.

## Tests and migration

Colocate tests with the capability they verify. Tests outside a bounded context
consume its public entrypoint; colocated adapter and policy tests may import
internal modules directly. Prefer invariant-focused tests over implementation
shape. Important invariants include namespace isolation, reload compatibility,
explicit immutable baselines, retained-path validation, pinned child-runtime
guards, rollback-safe attachment, durable wake cursors, safe retirement,
exact-SHA no-force publication, bounded watcher metadata, report-artifact
separation, compaction safe fallback, serialized lifecycle handoff, verifier
captured-head staleness, verifier non-publication, and fixed-argv verifier
evidence.

Migrate one representative capability per review gate: audit callers and
ownership, move coherent internals behind the public entrypoint, update adjacent
imports only where required, preserve invariants, and avoid opportunistic
feature work.
