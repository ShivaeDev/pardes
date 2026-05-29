# shell-helpers

Reusable, dependency-free shell helpers for the mechanical parts of orchestration: keeping a checkout fresh and pruning branches and worktrees you're done with. They depend only on POSIX `sh`, `git`, `awk`, `sed`, and `date`.

Each helper is shipped two ways:

- as a **`bin/` executable** — Claude Code adds a plugin's `bin/` to the Bash PATH, so an agent (or you) can call `freshen`, `prune-merged-branches`, and `reap-stale-worktrees` as bare commands.
- as a **sourceable shell function** — source one file into your interactive shell and get the same helpers (plus a few lower-level `sh_*` primitives) as functions.

Everything project-specific is an environment variable with a safe default. Nothing is hardcoded, and an unset variable degrades to a no-op rather than a destructive guess.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install shell-helpers@pardes
```

After installing, the `bin/` commands are on your PATH inside Claude Code sessions.

## The helpers

| Command | What it does | Safety contract |
| --- | --- | --- |
| `freshen` | Bring the current checkout to a clean, current baseline (fast-forward only), run setup, prune merged branches, reap stale worktrees. | Never resets a dirty tree or a diverged worktree — aborts and reports instead. |
| `prune-merged-branches` | Delete local branches whose upstream remote ref is gone (merged + cleaned PRs). | Only `[gone]`-upstream branches; never a no-upstream branch, the current branch, or one checked out in a worktree. |
| `reap-stale-worktrees [dir] [age_days]` | Remove worktrees older than a threshold under a managed directory. | Only inside the managed dir; never the current worktree; refuses any worktree with uncommitted changes. |

## Configuration

Set these once for your repo. Defaults in parentheses:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SH_DEFAULT_BRANCH` | Default branch name | auto-detected from `origin/HEAD`, else `main` |
| `SH_SETUP_CMD` | Post-update setup (install deps, codegen, migrate) | no-op |
| `SH_WORKTREE_DIR` | Managed worktree directory reaping is scoped to | unset → no reaping |
| `SH_WORKTREE_MAX_AGE_DAYS` | Stale-worktree age threshold (days) | `7` |

`SH_SETUP_CMD` is `eval`'d as-is during `freshen`, so only set it to a command you trust.

Example, in your shell profile:

```bash
export SH_SETUP_CMD="./script/setup"          # whatever your repo's onboarding runs
export SH_WORKTREE_DIR="$HOME/work/worktrees"  # where you keep agent worktrees
```

## Interactive use (source the functions)

To get the helpers as functions in your own shell, source the bundled file. The exact install path depends on where your Claude Code plugins live; once you know it, add to your `~/.bashrc` / `~/.zshrc`:

```bash
source "/path/to/plugins/shell-helpers/shell/helpers.sh"
```

Sourcing gives you the same three helpers as `sh_freshen`, `sh_prune_merged_branches`, and `sh_reap_stale_worktrees` — plus primitives like `sh_default_branch`, `sh_repo_root`, `sh_in_linked_worktree`, and `sh_is_dirty` you can compose into your own helpers.

## Agent use

The agent-facing operating notes live in `skills/shell-helpers/SKILL.md` — when to reach for each helper during an orchestration, and how they pair with a multi-PR orchestration skill if you have one.

## License

MIT
