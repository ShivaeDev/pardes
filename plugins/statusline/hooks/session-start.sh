#!/usr/bin/env bash
# SessionStart hook for the statusline plugin.
#
# Two jobs, both idempotent and safe to run on every session start:
#
#   1. Refresh a STABLE launcher script at a fixed path (default
#      ~/.claude/statusline-pardes.sh) that execs THIS plugin's current source
#      with `bun`. ${CLAUDE_PLUGIN_ROOT} rots on every plugin update (the old
#      install dir is GC'd ~7 days later) and is NOT substituted inside the
#      user's settings.json, so settings.json must point at the stable path and
#      we refresh that path's contents here, where the live root is known.
#
#   2. Wire the user's MAIN statusLine to the launcher — but ONLY if the
#      statusLine slot is empty or already owned by this plugin. A user's own
#      custom statusLine is never clobbered. When we do change it, the helper
#      emits a systemMessage so the change is announced, never silent.
#
# A plugin's bundled settings.json can declare the SUBAGENT line but not the
# main one, which is why the main line needs this hook + the /statusline-setup
# command. The subagent line points at the same launcher (with a `subagent` arg).

set -euo pipefail

# ${CLAUDE_PLUGIN_ROOT} is exported into the hook process by Claude Code.
plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$plugin_root" ]; then
  # Fall back to this script's own location (…/hooks/session-start.sh -> plugin root).
  plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

cli="$plugin_root/src/cli.ts"
if [ ! -f "$cli" ]; then
  # Source missing — do nothing rather than wire a broken launcher.
  exit 0
fi

claude_home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
launcher="${STATUSLINE_PARDES_LAUNCHER:-$claude_home/statusline-pardes.sh}"
settings="$claude_home/settings.json"

mkdir -p "$claude_home"

# --- 1. Write/refresh the stable launcher -----------------------------------
# It execs the CURRENT plugin source. Forwarding "$@" passes the mode argument
# ("subagent" for the agent panel; nothing for the main line). A leading marker
# comment lets the reconciler recognise OUR launcher when deciding to rewire.
launcher_body="#!/usr/bin/env bash
# statusline@pardes launcher — managed by the statusline plugin's SessionStart
# hook. Safe to delete; it is recreated on the next session start. Do not edit:
# changes are overwritten. The plugin path below is refreshed on every update.
# If bun is unavailable, exit cleanly with an empty line rather than letting the
# status line crash to a 127 blank.
command -v bun >/dev/null 2>&1 || { echo ''; exit 0; }
exec bun \"$cli\" \"\$@\"
"
# Only rewrite when the contents actually changed, to avoid needless disk churn.
if [ ! -f "$launcher" ] || [ "$(cat "$launcher" 2>/dev/null)" != "$launcher_body" ]; then
  printf '%s' "$launcher_body" > "$launcher"
fi
chmod +x "$launcher" 2>/dev/null || true

# --- 2. Reconcile the main statusLine in settings.json ----------------------
# All JSON read/modify + the hook's stdout JSON are produced by the bun helper
# (bun is guaranteed — it's how the status line runs). The helper:
#   - installs the statusLine when the slot is empty or already ours,
#   - never touches a user's own custom statusLine,
#   - prints the SessionStart hook JSON (with a systemMessage) only when it
#     actually changed something, and nothing otherwise (no per-session noise).
# STATUSLINE_PARDES_FORCE=1 (set by /statusline-setup) makes it report status
# even in the steady state and on a foreign custom statusLine.
STATUSLINE_PARDES_LAUNCHER="$launcher" \
  STATUSLINE_PARDES_FORCE="${STATUSLINE_PARDES_FORCE:-}" \
  bun "$plugin_root/hooks/reconcile-settings.ts" "$settings" || true

exit 0
