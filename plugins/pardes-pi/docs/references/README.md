# Local source references

This directory holds ignored local source checkouts used while implementing the
extension. They are deliberately not vendored into Pardes Pi history.

## Effect v4

The control plane uses the experimental Effect v4 line. Recreate or align the
local source checkout with the exact `effect` dependency pinned in the
repository-root [`package.json`](../../../../package.json):

```bash
bun run references:effect
```

The checkout lands at:

```text
plugins/pardes-pi/docs/references/effect-smol/
```

Useful entry points:

- `MIGRATION.md` — v4 overview and import organization
- `.patterns/effect.md` — implementation patterns
- `ai-docs/` — runnable documentation examples
- `packages/effect/src/` — actual source
- `packages/effect/src/Schema.ts` — schema APIs
- `packages/effect/src/unstable/rpc/` — Effect's unstable RPC implementation
- `packages/effect/src/unstable/process/` — process integration APIs

Always target the pinned dependency version rather than assuming APIs from a
newer beta are available.
