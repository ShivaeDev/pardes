---
name: shell-helpers
description: Reusable orchestration shell helpers for keeping a checkout fresh — freshen to a clean baseline, prune merged branches, and reap stale worktrees. Use when advancing local main after a merge or cleaning up after a parallel-worktree wave.
user-invocable: true
---

# shell-helpers

A small set of portable git/shell helpers for the mechanical parts of orchestration. They install as `bin/` executables, so each is a bare command on your PATH — call them directly. Every project-specific is an environment variable with a safe default; nothing is hardcoded.

Reach for these instead of hand-typing the equivalent git incantations: they carry the safety contracts (never reset a dirty tree, never reap a worktree with work in it) that make them safe to lean on unattended.

## When to use which

- **`freshen`** — after a PR merges, or when an agent worktree has drifted, to bring the current checkout to a clean, current baseline and tidy up. Prefer it over a hand-rolled `git fetch && switch && merge` when you also want setup re-run and merged branches pruned.
- **`prune-merged-branches`** — to clear out local branches whose PRs already merged.
- **`reap-stale-worktrees`** — after a parallel-worktree wave, to clean up worktrees you no longer need.

## freshen

`freshen` brings the current checkout to a clean, current baseline, then tidies up:

- **Primary checkout:** switches to the default branch and fast-forwards it to origin.
- **Linked worktree:** fetches with prune, then fast-forwards the worktree's branch to the default branch.
- Then: runs the configured setup command (`SH_SETUP_CMD`), prunes merged branches, and — if a managed worktree directory is set — reaps stale worktrees.

**Safety contract:** `freshen` NEVER does a destructive reset. If the working tree is dirty, or a worktree cannot fast-forward (it has diverged), it aborts and reports rather than discarding work. So advancing local main after a merge is just:

```bash
freshen
```

If the merge touched the dependency manifest or lockfile, `freshen` already re-runs `SH_SETUP_CMD` for you, so regenerated clients and freshly applied migrations stay current — provided that env var points at the repo's setup step.

## prune-merged-branches

Deletes local branches whose upstream remote ref is gone (the remote branch was deleted after the PR merged).

**Safety contract:** touches ONLY branches whose upstream tracking ref reports `[gone]`. It NEVER deletes a branch with no upstream, the current branch, or a branch checked out in any worktree — so in-flight work is always safe.

## reap-stale-worktrees

Removes worktrees whose tip commit is older than a threshold, scoped strictly to a managed directory:

```bash
reap-stale-worktrees                 # uses $SH_WORKTREE_DIR and $SH_WORKTREE_MAX_AGE_DAYS (default 7)
reap-stale-worktrees /path/to/wt 3   # explicit directory + age in days
```

**Safety contract:** considers ONLY worktrees under the managed directory — anything elsewhere is untouched. It NEVER removes the worktree you are standing in, and it REFUSES to remove a worktree that has uncommitted changes (reports and skips it). If no managed directory is configured it is a no-op, so it can't run away on an unset variable.

## Configuration

These read from environment variables; set them once for your repo (see the plugin README for shell setup). Sane defaults mean an unset variable degrades to a no-op, never to a destructive guess:

- `SH_DEFAULT_BRANCH` — default branch; auto-detected from `origin/HEAD` if unset.
- `SH_SETUP_CMD` — the repo's post-update setup (install deps, run codegen, apply migrations); default no-op.
- `SH_WORKTREE_DIR` — the managed worktree directory reaping is scoped to; unset means no reaping.
- `SH_WORKTREE_MAX_AGE_DAYS` — stale-worktree age threshold; default 7.

## Relationship to orchestration

If you are running a multi-PR orchestration and a shell-helpers command like `freshen` is available, use it to advance local main and clean up after a wave — it carries the safety contracts so you don't have to reconstruct them by hand. If it is NOT available, fall back to the manual git sequence (`git fetch origin <branch> && git switch <branch> && git merge --ff-only origin/<branch>`) and prune/reap by hand, in the primary checkout only, never touching a worktree that holds uncommitted work.
