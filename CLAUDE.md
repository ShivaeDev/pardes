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

## Not here yet (deliberately)

- **No GitHub Actions.** CI, the auto-version-bump workflow, and any release
  automation are deferred until a dedicated security review (zero-vuln bar).
  Don't add `.github/workflows/` without that pass.
