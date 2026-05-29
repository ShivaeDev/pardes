# shell-helpers

Reusable, dependency-free shell helpers for the mechanical parts of orchestration: keeping a checkout fresh, pruning branches and worktrees you're done with, and shipping a routine PR without retyping the same git sequence. They depend only on POSIX `sh`, `git`, `awk`, `sed`, and `date` (`gh` is optional, used only to open PRs).

Each helper is shipped two ways:

- as a **`bin/` executable** — Claude Code adds a plugin's `bin/` to the Bash PATH, so an agent (or you) can call `freshen`, `prune-merged-branches`, `reap-stale-worktrees`, and `gpr` as bare commands.
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
| `gpr <subcommand> ...` | Thin branch / commit / push / PR DSL. | `gpr pr` needs `gh`; if absent, the push still happens and you get a clear "open it manually" message. |

`gpr` subcommands: `start`, `commit`, `commit-all`, `push`, `pr`, `ship`, `start-ship`. Run `gpr help` for the one-line reference.

## Configuration

Set these once for your repo. Defaults in parentheses:

| Variable | Purpose | Default |
| --- | --- | --- |
| `SH_DEFAULT_BRANCH` | Default branch name | auto-detected from `origin/HEAD`, else `main` |
| `SH_SETUP_CMD` | Post-update setup (install deps, codegen, migrate) | no-op |
| `SH_WORKTREE_DIR` | Managed worktree directory reaping is scoped to | unset → no reaping |
| `SH_WORKTREE_MAX_AGE_DAYS` | Stale-worktree age threshold (days) | `7` |
| `SH_BRANCH_PREFIX` | Namespace prepended to new branch names | none |

Example, in your shell profile:

```bash
export SH_SETUP_CMD="./script/setup"          # whatever your repo's onboarding runs
export SH_WORKTREE_DIR="$HOME/work/worktrees"  # where you keep agent worktrees
export SH_BRANCH_PREFIX="me"                    # branches become me/<name>
```

## Interactive use (source the functions)

To get the helpers as functions in your own shell, source the bundled file. The exact install path depends on where your Claude Code plugins live; once you know it, add to your `~/.bashrc` / `~/.zshrc`:

```bash
source "/path/to/plugins/shell-helpers/shell/helpers.sh"
```

Sourcing gives you the same four helpers as `sh_freshen`, `sh_prune_merged_branches`, `sh_reap_stale_worktrees`, and the `sh_start` / `sh_commit` / `sh_commit_all` / `sh_push` / `sh_pr` / `sh_ship` / `sh_start_ship` DSL functions — plus primitives like `sh_default_branch`, `sh_repo_root`, `sh_in_linked_worktree`, and `sh_is_dirty` you can compose into your own helpers.

## Agent use

The agent-facing operating notes live in `skills/shell-helpers/SKILL.md` — when to reach for each helper during an orchestration, and how they pair with a multi-PR orchestration skill if you have one.

## License

MIT
