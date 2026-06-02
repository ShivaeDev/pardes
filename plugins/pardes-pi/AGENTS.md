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
Read `docs/CODE_QUALITY.md` before source-organization or maintainability
refactors. Implement one reviewed vertical slice at a time. Do not add daemon
behavior, cross-manager scheduling, or speculative recovery machinery.

## Local maintainer documentation

Before modifying a service or capability folder, read its local `AGENTS.md` and
referenced `ARCHITECTURE.md` when present. A capability may include a very short
`AGENTS.md`, automatically loaded for agents, containing only non-obvious
invariants and a pointer to its local `ARCHITECTURE.md`. Keep verbose
capability-specific design detail in that local architecture document. Do not
create local maintainer docs speculatively. Keep any `CLAUDE.md` extremely short
and noise-free: include only high-value instructions not already discoverable
elsewhere.

## Architecture and code-quality documentation gate

Treat `docs/ARCHITECTURE.md` and `docs/CODE_QUALITY.md` as closed by default.
Feature, bugfix, UX, test, and maintenance slices must not edit them. Do not
append prose because a change seems reusable, because a new file exists, or
because a worker wants to justify its design.

An explicitly authorized documentation slice may correct factual boundary-level
inventory. Adding or replacing a convention in either document requires
explicit user or coordinating-manager approval before editing. When uncertain,
leave the files unchanged and report the proposed documentation change for
review.
