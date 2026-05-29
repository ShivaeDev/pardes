---
name: statusline-setup
description: Wire (or re-wire) Claude Code's main status line to the statusline@pardes plugin. Refreshes the stable launcher and points settings.json at it, without ever clobbering a custom statusLine you set yourself.
user-invocable: true
---

# statusline-setup

Explicitly install or refresh the **main** status line for the `statusline` plugin.

The subagent status line is wired automatically (it ships in the plugin's bundled `settings.json`). The main line cannot be set declaratively by a plugin, so it is wired by a SessionStart hook — and by this command, for an on-demand (re)install.

## What to do

Run the plugin's setup in force mode. This refreshes the stable launcher at `~/.claude/statusline-pardes.sh` so it points at the current plugin source, then points `~/.claude/settings.json`'s `statusLine` at that launcher:

```bash
STATUSLINE_PARDES_FORCE=1 "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"
```

Then report the outcome to the user based on what the script printed:

- **Wired / refreshed** — the main status line now renders via this plugin. Tell the user it is active. It takes effect on the next status-line refresh; a new session guarantees it.
- **Custom status line left untouched** — the user already has their own `statusLine` command in `settings.json`. The plugin will NOT overwrite it. To switch, tell the user to remove the existing `statusLine` key from `~/.claude/settings.json`, then run `/statusline-setup` again.

## How to revert

Tell the user they can remove the wiring at any time by deleting the `"statusLine"` key from `~/.claude/settings.json`. The launcher file `~/.claude/statusline-pardes.sh` is harmless to leave or delete; it is recreated whenever the plugin is active and a session starts.
