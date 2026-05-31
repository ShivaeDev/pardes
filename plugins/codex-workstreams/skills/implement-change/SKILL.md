---
name: implement-change
description: Use when an approved PR-sized coding goal needs execution through an owner worker and optional supporting workers in manually managed Git worktrees.
---

# Implement Change

Execute an approved PR goal while keeping the primary session responsible for
coordination. The manager never edits code. Every PR has one owner worker in a
managed worktree.

## Entry Gate

Confirm that the PR is inside the user-approved scope and sequence. For a
standalone implementation request, the explicit request is the approved scope.

Read [references/worktree-workers.md](references/worktree-workers.md) before
dispatching a writing worker.

## Dispatch

1. Create a linked worktree for the owner worker with
   `scripts/manage_worker_worktree.py`. Run the helper outside the sandbox from
   the outset. Use an explicit branch-point SHA.
2. Give the owner the approved PR goal and boundaries. The owner inspects the
   code, forms the implementation plan, edits, runs repo-supported validation,
   creates normal commits, and reports commit SHAs, changed paths, validation,
   and surprises.
3. Spawn supporting workers in separate managed worktrees when independent
   chunks can proceed in parallel. Supporting workers commit their chunks; the
   owner worker integrates accepted support commits.
4. Keep the owner available for verifier, CI, and review feedback.

Keep each active worker branch on its assigned branch-point SHA. Do not rebase
or recreate it merely because the target branch advanced. Refresh only for a
real dependency, conflict, or identified semantic overlap.

Do not manually delete branches or worktrees after a PR. Worktree creation
quietly reaps clean managed worktrees whose tip commit is older than seven days.

## Wait for Workers

- Continue useful non-overlapping manager work after dispatch.
- Once worker output is the actual blocker, call `wait_agent` with all unresolved
  worker IDs and a `900000` ms timeout. Use a longer timeout, up to the API
  maximum, when the assigned task reasonably needs it.
- Treat an ordinary timeout as "still working", not as a progress event. Do not
  narrate or create short-poll loops. Wait again with a long timeout unless
  there is evidence the worker is stuck or the user asks for status.

## Handoff

After the owner returns, check status, diffstat, and commit metadata without
reading the full diff. Confirm the primary checkout stayed untouched, then use
`verify-change`.
