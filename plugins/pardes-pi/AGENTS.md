# Pardes for Pi

Build this project with Bun and TypeScript only.

## Effect v4

Use Effect v4 for schemas, typed errors, services, resource lifecycles, and
concurrency. Do not hand-roll Promise orchestration, mutexes, lifecycle cleanup,
or validation when Effect provides the abstraction.

The pinned Effect source and docs are cloned locally under
`docs/references/effect-smol/`. Before assuming an Effect API, inspect the
version-aligned source checkout. Useful starting points are listed in
`docs/references/README.md`.

Follow the Effect repository's own patterns where applicable, especially:

- prefer Effect error channels over `try` / `catch` inside `Effect.gen`;
- use `return yield*` for terminal effects;
- prefer `Effect.fnUntraced` over functions that only wrap `Effect.gen`;
- prefer class syntax for `Context.Service`.

## Scope discipline

Read `docs/NORTH_STAR.md` before changing architecture. Follow
`docs/ARCHITECTURE.md` for bounded-context refactors and import-direction rules.
Implement one reviewed vertical slice at a time. Do not add daemon behavior,
cross-manager scheduling, or speculative recovery machinery.

## Architecture documentation gate

Treat `docs/ARCHITECTURE.md` as closed by default. Feature, bugfix, UX, test,
and maintenance slices must not edit it. Do not append prose because a change
seems reusable, because a new file exists, or because a worker wants to justify
its design.

A bounded-context migration may update `docs/ARCHITECTURE.md` only when its task
explicitly authorizes the edit, and then only to correct the factual capability
inventory or replace an existing convention. Adding a new convention requires
explicit user or coordinating-manager approval before editing. When uncertain,
leave the file unchanged and report the proposed documentation change for
review.
