---
name: configure-workstream
description: Use when a user installs the Codex workstreams plugin, asks to set it up, or sees permission prompts for workstream checkpoints, reports, or temporary pull-request body files.
---

# Configure Workstream

Set up one visible artifact directory for manager-owned files. Keep the change
narrow and explicit: inspect first, explain the proposed personal-config edit,
and write only after the user approves it.

## Diagnose

Run the read-only doctor:

```bash
uv run python -B "<configure-workstream-skill>/scripts/check_setup.py"
```

Read its JSON report. The recommended artifact directory is:

```text
${CODEX_ARTIFACTS_DIR:-$HOME/codex-artifacts}
```

It contains `workstreams/`, `pr-bodies/`, and `reports/`.

## Configure

1. Explain the exact proposed filesystem and `~/.codex/config.toml` changes.
2. Ask for explicit approval before editing personal config or creating
   directories.
3. Preserve unrelated configuration and existing writable roots.
4. If the user already uses permission profiles, add the artifact directory to
   the selected profile's `workspace_roots`.
5. Otherwise, add it to `sandbox_workspace_write.writable_roots`.
6. Validate the resulting config with:

```bash
codex --strict-config --version
```

7. Tell the user to start a new Codex session so the writable root takes
   effect.

For a stable legacy configuration, add the absolute artifact path:

```toml
[sandbox_workspace_write]
writable_roots = ["/absolute/path/to/codex-artifacts"]
```

For an existing permission profile, extend that profile:

```toml
[permissions.<profile>.workspace_roots]
"~/codex-artifacts" = true
```

## Rules

- Never change personal config without explicit approval.
- Never migrate between legacy settings and permission profiles as part of
  onboarding.
- Never replace existing writable roots when adding the artifact directory.
- Never grant write access to the entire home directory.
- Keep source worktrees under `<primary-checkout>/.worktrees/`.
- Keep PR-monitor cursor state under
  `${CODEX_HOME:-$HOME/.codex}/state/pr-monitor/`.
