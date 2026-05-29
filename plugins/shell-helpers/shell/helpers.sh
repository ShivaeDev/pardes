# shell-helpers — reusable orchestration shell helpers.
#
# Source this from your interactive shell to get the helpers as functions:
#
#     source /path/to/shell-helpers/shell/helpers.sh
#
# All project-specifics are environment variables with safe defaults — nothing
# private is hardcoded. Configure them once (see the README) and the helpers
# adapt to your repo.
#
# Environment variables:
#   SH_DEFAULT_BRANCH   default branch name; auto-detected from origin/HEAD if unset
#   SH_SETUP_CMD        post-update setup command (install/codegen/migrate); default no-op
#   SH_WORKTREE_DIR     managed worktree directory reaping is scoped to; default no reaping
#   SH_WORKTREE_MAX_AGE_DAYS  stale-worktree threshold in days; default 7
#   SH_BRANCH_PREFIX    namespace prepended to new branch names; default none
#
# These helpers depend only on POSIX sh, git, awk, sed, and date. `gh` is
# optional and used solely by the PR step, which degrades with a clear message.

# ----------------------------------------------------------------------------
# Primitives
# ----------------------------------------------------------------------------

# Resolve the repository's default branch.
# Prefers an explicit SH_DEFAULT_BRANCH, then origin/HEAD, then a "main"/"master"
# guess, falling back to "main".
sh_default_branch() {
  if [ -n "${SH_DEFAULT_BRANCH:-}" ]; then
    printf '%s\n' "$SH_DEFAULT_BRANCH"
    return 0
  fi
  local ref
  ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
  if [ -n "$ref" ]; then
    printf '%s\n' "${ref#origin/}"
    return 0
  fi
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    printf 'main\n'
  elif git show-ref --verify --quiet refs/remotes/origin/master; then
    printf 'master\n'
  else
    printf 'main\n'
  fi
}

# Absolute path of the current checkout's top level.
sh_repo_root() { git rev-parse --show-toplevel; }

# True if standing in a linked worktree rather than the primary checkout.
# In a linked worktree, the top-level ".git" is a file; in the primary it's a dir.
sh_in_linked_worktree() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  [ -f "$root/.git" ]
}

# True if the working tree has uncommitted changes (staged, unstaged, or untracked).
sh_is_dirty() {
  [ -n "$(git status --porcelain 2>/dev/null)" ]
}

# Canonicalize a directory to its physical path (resolving symlinks such as
# macOS's /var -> /private/var), so prefix comparisons against git's worktree
# paths are reliable. Prints the input unchanged if it isn't an existing dir.
sh_canonical_dir() {
  if [ -d "$1" ]; then
    ( cd "$1" 2>/dev/null && pwd -P ) || printf '%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# Run the configured post-update setup command, if any. No-op when unset/empty.
sh_run_setup() {
  if [ -n "${SH_SETUP_CMD:-}" ]; then
    printf 'shell-helpers: running setup: %s\n' "$SH_SETUP_CMD" >&2
    eval "$SH_SETUP_CMD"
  fi
}

# ----------------------------------------------------------------------------
# prune-merged-branches
# ----------------------------------------------------------------------------

# Delete local branches whose upstream remote ref is gone — i.e. branches whose
# PR merged and whose remote branch was deleted.
#
# Safety contract:
#   - Touches ONLY branches whose upstream tracking ref reports "[gone]".
#   - NEVER touches a branch with no upstream (nothing to compare against).
#   - NEVER touches the current branch.
#   - NEVER touches a branch checked out in another worktree (git refuses, and
#     we additionally skip it explicitly).
sh_prune_merged_branches() {
  git fetch --prune --quiet || return 1

  local current worktree_branches
  current="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  # Branches checked out in any worktree (including this one), one per line.
  worktree_branches="$(git worktree list --porcelain 2>/dev/null \
    | awk '/^branch /{sub("^refs/heads/", "", $2); print $2}')"

  git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads \
    | awk '$2 == "[gone]" { print $1 }' \
    | while IFS= read -r branch; do
        [ -z "$branch" ] && continue
        [ "$branch" = "$current" ] && continue
        if printf '%s\n' "$worktree_branches" | grep -qxF "$branch"; then
          continue
        fi
        if git branch -D "$branch" >/dev/null 2>&1; then
          printf 'shell-helpers: pruned merged branch %s\n' "$branch" >&2
        fi
      done
}

# ----------------------------------------------------------------------------
# reap-stale-worktrees
# ----------------------------------------------------------------------------

# Remove worktrees whose tip commit is older than a threshold, scoped strictly
# to a managed directory.
#
# Usage: sh_reap_stale_worktrees [managed_dir] [age_days]
#   managed_dir defaults to $SH_WORKTREE_DIR (no reaping if unset).
#   age_days    defaults to $SH_WORKTREE_MAX_AGE_DAYS, else 7.
#
# Safety contract:
#   - Considers ONLY worktrees under the managed directory; anything elsewhere
#     is left strictly alone.
#   - NEVER removes the worktree you are standing in.
#   - REFUSES to remove a worktree that has uncommitted changes — it is reported
#     and skipped, never force-removed.
sh_reap_stale_worktrees() {
  local managed_dir age_days here cutoff now
  managed_dir="${1:-${SH_WORKTREE_DIR:-}}"
  age_days="${2:-${SH_WORKTREE_MAX_AGE_DAYS:-7}}"

  if [ -z "$managed_dir" ]; then
    printf 'shell-helpers: no managed worktree directory set (SH_WORKTREE_DIR); skipping reap\n' >&2
    return 0
  fi

  # Resolve symlinks so the prefix match lines up with git's physical paths.
  managed_dir="$(sh_canonical_dir "$managed_dir")"
  here="$(git rev-parse --show-toplevel 2>/dev/null)"
  now="$(date +%s)"
  cutoff=$(( now - age_days * 86400 ))

  git worktree list --porcelain 2>/dev/null \
    | awk '/^worktree /{ print $2 }' \
    | while IFS= read -r wt; do
        [ -z "$wt" ] && continue
        # Only worktrees inside the managed directory.
        case "$wt" in
          "$managed_dir"/*) ;;
          *) continue ;;
        esac
        # Never the current worktree.
        [ "$wt" = "$here" ] && continue

        # Refuse to reap a worktree with uncommitted changes.
        if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
          printf 'shell-helpers: keeping %s — has uncommitted changes\n' "$wt" >&2
          continue
        fi

        local tip
        tip="$(git -C "$wt" log -1 --format=%ct 2>/dev/null)" || continue
        [ -z "$tip" ] && continue
        if [ "$tip" -lt "$cutoff" ]; then
          if git worktree remove "$wt" >/dev/null 2>&1; then
            printf 'shell-helpers: reaped stale worktree %s\n' "$wt" >&2
          fi
        fi
      done

  git worktree prune >/dev/null 2>&1 || true
}

# ----------------------------------------------------------------------------
# freshen
# ----------------------------------------------------------------------------

# Bring the current checkout to a clean, current baseline, then tidy up.
#
# Primary checkout: switch to the default branch and fast-forward it to origin.
# Linked worktree:  fetch + prune, then fast-forward the worktree's branch to the
#                   default branch. NEVER a destructive reset — if the worktree is
#                   dirty or cannot fast-forward, freshen refuses and reports.
#
# After updating, runs the configured setup command, prunes merged branches, and
# (if a managed worktree directory is set) reaps stale worktrees.
#
# Safety contract:
#   - NEVER resets or discards uncommitted work. A dirty tree aborts the update.
#   - The worktree path only ever fast-forwards; it never rewrites history.
#   - Pruning and reaping carry their own contracts (see above).
sh_freshen() {
  local def
  def="$(sh_default_branch)"

  if sh_is_dirty; then
    printf 'shell-helpers: working tree is dirty — refusing to update. Commit or stash first.\n' >&2
    return 1
  fi

  git fetch --prune origin || return 1

  if sh_in_linked_worktree; then
    # Fast-forward this worktree's branch to the default branch. Non-destructive:
    # if it can't fast-forward, report and stop rather than reset.
    if ! git merge --ff-only "origin/$def"; then
      printf 'shell-helpers: cannot fast-forward this worktree to origin/%s (diverged). Refusing to reset.\n' "$def" >&2
      return 1
    fi
  else
    git switch "$def" || return 1
    git merge --ff-only "origin/$def" || git pull --ff-only origin "$def" || return 1
  fi

  sh_run_setup
  sh_prune_merged_branches
  if [ -n "${SH_WORKTREE_DIR:-}" ]; then
    sh_reap_stale_worktrees
  fi
}

# Fast-forward pull the current branch, then re-run the configured setup command.
sh_pull_and_setup() {
  git pull --ff-only || return 1
  sh_run_setup
}

# ----------------------------------------------------------------------------
# branch -> commit -> push -> PR DSL  (namespaced sh_*; gh optional)
# ----------------------------------------------------------------------------

# Start a new branch, namespaced under SH_BRANCH_PREFIX if set.
#   sh_start <branch-name>
sh_start() {
  if [ -z "${1:-}" ]; then
    printf 'usage: sh_start <branch-name>\n' >&2
    return 2
  fi
  git switch -c "${SH_BRANCH_PREFIX:+$SH_BRANCH_PREFIX/}$1"
}

# Commit staged changes.
#   sh_commit <subject> [body]
sh_commit() {
  if [ -z "${1:-}" ]; then
    printf 'usage: sh_commit <subject> [body]\n' >&2
    return 2
  fi
  if [ -n "${2:-}" ]; then
    git commit -m "$1" -m "$2"
  else
    git commit -m "$1"
  fi
}

# Stage everything, then commit.
#   sh_commit_all <subject> [body]
sh_commit_all() {
  git add -A || return 1
  sh_commit "$@"
}

# Push the current branch and set upstream.
sh_push() { git push -u origin HEAD; }

# Open a PR for the current branch. Requires `gh`; degrades with a clear message.
#   sh_pr [extra gh pr create args...]
sh_pr() {
  if ! command -v gh >/dev/null 2>&1; then
    printf 'shell-helpers: gh not found — push is done; open the PR manually in your browser.\n' >&2
    return 127
  fi
  gh pr create --fill "$@"
}

# Commit-all + push + open PR in one step.
#   sh_ship <subject> [body]
sh_ship() {
  sh_commit_all "$@" && sh_push && sh_pr
}

# Branch + commit-all + push + open PR in one step.
#   sh_start_ship <branch-name> <subject> [body]
sh_start_ship() {
  local name="${1:-}"
  if [ -z "$name" ]; then
    printf 'usage: sh_start_ship <branch-name> <subject> [body]\n' >&2
    return 2
  fi
  shift
  sh_start "$name" && sh_ship "$@"
}
