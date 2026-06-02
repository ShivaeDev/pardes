# Pardes Pi Code Quality

## Purpose

This document is the maintainability rubric for Pardes Pi source organization.
Read it with [ARCHITECTURE.md](./ARCHITECTURE.md), which owns bounded-context
responsibilities and integrated lifecycle conventions, and
[NORTH_STAR.md](./NORTH_STAR.md), which owns product boundaries.

Apply the rubric while implementing one reviewed vertical slice at a time. It
intentionally avoids a source-file inventory: internal layouts should evolve as
coherent responsibilities become clearer without making documentation stale.

## Organize by capability

Prefer capability-based subfolders when a group of code owns a coherent policy,
lifecycle, external boundary, or independently understandable subsystem. Keep
small pure helpers beside their owning capability until a stronger boundary
exists.

Do not split code merely because a file is long. Do not create folders that
mirror file types such as `services/`, `schemas/`, or `helpers/`. Avoid generic
`utils/` bags, tiny pass-through wrappers, and moves whose main result is more
files. A folder should make ownership and change scope clearer.

Internal layouts are intentionally asymmetric. A capability may remain one
file, become a set of flat siblings, or earn a nested folder. Choose the
smallest shape that makes the real boundary legible.

## Keep facades stable and imports directional

Every bounded context exposes one public `index.ts`. Code outside that context
imports only its public entrypoint. Internal modules import one another's leaves
directly rather than routing through their own public facade.

A nested internal capability may add its own facade when several consumers need
a stable sub-capability API. Do not add nested barrels ceremonially. Export a
selective surface, hide implementation details, and avoid export-all barrels.

When extracting code, preserve inward dependency direction:

1. adapters and codecs do not import controllers or presentation code;
2. controllers depend on ports rather than concrete transports;
3. pure schemas stay isolated from services and process APIs;
4. externally owned aggregate values compose through their owning context's
   public entrypoint;
5. domain errors stay with their domain unless a shared formatter consumes them.

## Separate pure decisions from Effect services

Keep schemas, codecs, projections, and transition policies pure whenever they
do not acquire resources or perform effects. Pure functions are easier to
compose, review, and test directly.

Use Effect services for meaningful effectful ports. Add `Context.Service` and a
`Layer` when a capability has a production implementation or composes real
dependencies. Use scopes and finalizers for resource lifecycles and Effect
semaphores for shared ordering. Do not add service ceremony to pure helpers.

## Keep lifecycle ownership singular

One owner should remain visibly responsible for each lifecycle: allocation,
ordering, shutdown, rollback, and compensation. Extract policy, state
transitions, protocol interpretation, and narrow operations behind explicit
contracts without distributing ownership across helpers.

Before extracting lifecycle code, identify the owner and the operations it
delegates. After extracting, verify that cleanup, failure compensation, and
serialization still converge through that owner.

## Extract God files by responsibility

File length is a signal to inspect, not an extraction rule. Treat any source
file over roughly 200 lines as a red flag that deserves active review because
responsibilities often accumulate there. Extract only when that review finds a
cohesive responsibility, invariant seam, or distinct change reason. The
heuristic is not a mechanical pass/fail threshold and does not justify tiny
wrappers solely to reduce line count.

Good extraction candidates include pure policy, state projection, protocol
interpretation, adapter mechanics, and lifecycle compensation that can be named
and tested independently.

Avoid extractions that introduce circular imports, duplicate lifecycle
coordination, widen a public facade, or leave behind one-line wrappers with no
boundary value. Prefer one representative extraction per reviewed slice over a
broad reshuffle.

## Colocate invariant-focused tests

Colocate tests with the capability they verify. Tests outside a bounded context
consume its public entrypoint; internal policy and adapter tests may import
internal leaves directly.

Prefer invariant-focused tests over implementation-shape assertions. Add a
dependency-direction test when a boundary is safety-critical and regression
would otherwise be easy. Do not pin incidental folder shape unless that shape
is itself the contract.

## Documentation discipline

Keep architecture inventories boundary-level. Internal files and nested folders
are discoverable from the source tree and should not be enumerated in durable
documentation.

Treat this document and [ARCHITECTURE.md](./ARCHITECTURE.md) as closed by
default. Do not edit either document merely because a refactor added files or a
worker wants to justify its design. Correct a factual boundary-level inventory
only when the task explicitly authorizes the documentation update. Adding or
replacing a convention requires explicit user or coordinating-manager approval.
When uncertain, leave the docs unchanged and report the proposed update for
review.

## Focused review checklist

For a source-organization or maintainability refactor, verify:

- the extracted unit names a real capability or responsibility;
- public bounded-context entrypoints remain stable and selective;
- outside imports use public entrypoints while internal imports use direct
  leaves;
- pure projections and policies remain free of unnecessary Effect service
  ceremony;
- lifecycle ownership, serialization, cleanup, and compensation remain clear;
- source files over roughly 200 lines received active review without
  threshold-driven extraction;
- the change avoids file-type folders, generic utility bags, and tiny wrappers;
- tests remain colocated and cover preserved invariants;
- documentation remains boundary-level and any convention change had explicit
  approval;
- the slice contains no opportunistic feature work.
