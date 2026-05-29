# statusline

A rich, multi-line status line for [Claude Code](https://code.claude.com) — for both the main session bar and the per-subagent rows in the agent panel.

## What it shows

**Main line** (two rows):

- **Row 1** — repo `owner/name`, current folder, git branch with ahead/behind and a dirty/clean summary, worktree marker, PR number + review state, the model tag (e.g. `O4.8`, with a `1M` badge for extended-context sessions), reasoning effort, thinking/vim/output-style flags, session cost, wall + API duration, and lines added/removed.
- **Row 2** — a sub-cell-accurate context-pressure bar scaled to the usable window (the auto-compact wall minus the compaction buffer), the token count and percentage, and your Claude.ai 5-hour / 7-day rate-limit gauges with reset clocks.

**Subagent rows** — each agent in the panel gets a token-growth sparkline, its own context-pressure bar, elapsed time, and a status glyph, with the name and a dimmed description trailing on the right. Gauges degrade gracefully as the row narrows.

The pressure bar shifts colour from calm → amber → orange → red as context fills, so you can see compaction coming.

It runs on `bun` directly against the bundled TypeScript source — no build step, no install, zero runtime dependencies (only `node:*` and Bun's stdin).

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install statusline@pardes
```

On install the plugin:

- **auto-wires the subagent line** — it ships in the plugin's bundled settings, so the agent panel uses it immediately;
- **offers to wire the main line** — a SessionStart hook checks your `statusLine` slot and, only if it is empty or already owned by this plugin, points it at a stable launcher and announces that it did so. **It never overwrites a custom status line you set yourself.**

If you already have your own `statusLine` and want to switch, remove the `"statusLine"` key from `~/.claude/settings.json` and run `/statusline-setup`. You can also run `/statusline-setup` any time to (re)install or refresh the main-line wiring explicitly.

### How the wiring survives updates

`${CLAUDE_PLUGIN_ROOT}` changes on every plugin update (the old install directory is cleaned up about a week later) and is not substituted inside `settings.json`. So the plugin does **not** write that path into your settings. Instead the SessionStart hook maintains a small **stable launcher** at `~/.claude/statusline-pardes.sh` that execs the current plugin source, and points `settings.json` at that fixed path. The launcher is refreshed every session start, so plugin updates are picked up automatically. The subagent line points at the same launcher with a `subagent` argument.

## Configure (optional)

Environment variables, read at render time:

- `CLAUDE_STATUSLINE_COMPACT_BUFFER` — tokens reserved for the auto-compact buffer (default `35000`); the bar reads 100% when compaction triggers, not at the raw ceiling.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` — the real compaction wall to scale the bar to, when you run with an auto-compact override.
- `CLAUDE_STATUSLINE_TOKENS_PER_CELL` — how many tokens one bar cell represents (default `10000`), which sets the bar width.

## Revert

Remove the `"statusLine"` key from `~/.claude/settings.json` to drop the main line. Uninstalling the plugin removes the subagent line. The launcher at `~/.claude/statusline-pardes.sh` is harmless to leave behind and safe to delete; it is only recreated while the plugin is active.
