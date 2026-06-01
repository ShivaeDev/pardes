# CLAUDE

**Pardes** — a calm-coding marketplace of Claude Code plugins and skills. One
repo, many plugins (see `README.md` and `.claude-plugin/marketplace.json`).

## Structure

- `.claude-plugin/marketplace.json` — the plugin registry (name, owner, plugins[]).
- `plugins/<name>/.claude-plugin/plugin.json` — per-plugin manifest.
- `plugins/<name>/{skills,agents,hooks,commands}/`, `.mcp.json` — auto-discovered
  by Claude Code; no extra registration beyond `plugin.json`.
- `changelog/<name>.md` — per-plugin changelog (Keep a Changelog), at the repo root.

## Conventions

- Owner/author in manifests is the org (`ShivaeDev`), never a personal name.
- No barrel files in Claude/Codex marketplace plugins; named exports; bun for everything.
- `plugins/pardes-pi/` is a self-contained Pi extension source tree with its own
  `AGENTS.md` and TypeScript config. It intentionally uses bounded-context
  `index.ts` public entrypoints.

## One skill per plugin

Each user-facing skill ships as its **own** plugin (`plugins/<skill>/skills/<skill>/SKILL.md`),
so people install only what they want rather than swallowing a grab-bag. A plugin
generally owns exactly one skill and is named after it. Skills may still depend on
one another across plugins — the install boundary is per-skill, not per-dependency.
`base` is the deliberate exception: it's the home for shared hooks/infrastructure,
not a skill bundle. Don't pile new skills into `base` or into an existing
single-skill plugin; add a new plugin.

## GitHub Actions

Two workflows ship and run, both with a security review applied — see their
inline `SECURITY POSTURE` / NOTE comment blocks before changing them:

- **`lint.yml`** — runs `biome ci` on PRs (and pushes to `main` as a backstop).
  Read-only token. To actually block merge it must be a required status check in
  the repo ruleset (a repo setting, not YAML).
- **`version-bump.yml`** — auto-bumps plugin versions on `push:main` only (no
  `pull_request` / `workflow_dispatch`, so nothing untrusted ever runs with the
  token). Opens a PR, merges it synchronously, then tags the merged commit;
  version tags are create-only via a `*--v*` ruleset.

Policy for any new or changed workflow: actions pinned to full commit SHAs,
least-privilege `permissions`, no untrusted-context triggers, and a security
review before it lands. Don't remove these workflows — extend them under the
same posture.
