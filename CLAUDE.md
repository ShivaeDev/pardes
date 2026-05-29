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
- No barrel files; named exports; bun for everything.

## One skill per plugin

Each user-facing skill ships as its **own** plugin (`plugins/<skill>/skills/<skill>/SKILL.md`),
so people install only what they want rather than swallowing a grab-bag. A plugin
generally owns exactly one skill and is named after it. Skills may still depend on
one another across plugins — the install boundary is per-skill, not per-dependency.
`base` is the deliberate exception: it's the home for shared hooks/infrastructure,
not a skill bundle. Don't pile new skills into `base` or into an existing
single-skill plugin; add a new plugin.

## Not here yet (deliberately)

- **No GitHub Actions.** CI, the auto-version-bump workflow, and any release
  automation are deferred until a dedicated security review (zero-vuln bar).
  Don't add `.github/workflows/` without that pass.
