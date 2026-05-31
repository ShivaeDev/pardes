# Worktree Workers

Writing workers are not automatically isolated. Route each one into a manually
created linked Git worktree. Every PR has one owner worker. Supporting workers
are optional and contribute normal commits for the owner to integrate.

## Managed Path

The helper defaults to:

```text
<primary-checkout>/.worktrees/<workstream>/<worker>
```

This keeps worker edits inside the repository tree Codex started in, avoiding
repeated path-traversal approvals. On creation, the helper adds
`/.worktrees/` to the repository-local `.git/info/exclude` file. This
hides managed worktrees from `git status` without modifying the tracked
`.gitignore`. Each `create` also removes clean managed worktrees whose tip
commit is older than seven days. It skips dirty worktrees and never deletes
branches.

## Execution Routing

Run every `manage_worker_worktree.py` command outside the sandbox from the
outset. Do not attempt it inside the sandbox first. Linked-worktree management
requires access to shared Git metadata, so a sandbox failure is expected and
adds no diagnostic value.

Create a worktree:

```bash
uv run "<implement-change-skill>/scripts/manage_worker_worktree.py" create \
  --repo <primary-checkout> \
  --workstream <slug> \
  --worker <slug> \
  --branch <branch> \
  --base <branch-point-sha>
```

Use the approved full branch-point SHA for a new branch. Omit `--base` only
when reattaching an existing local branch. Keep an existing worker branch
unchanged when the target branch advances. Rebase only when a real dependency,
conflict, or identified semantic overlap requires it.

Inspect it:

```bash
uv run "<implement-change-skill>/scripts/manage_worker_worktree.py" status --path <worktree>
```

## Worker Brief

Every worker brief includes:

1. Assigned worktree absolute path.
2. Overall PR goal and this chunk's bounded deliverable.
3. Assigned branch-point SHA and any required predecessor.
4. Owned files or modules and explicit out-of-scope surfaces.
5. Required repository setup and narrow validation commands.
6. Instruction to stop if `git rev-parse --show-toplevel` does not equal the
   assigned path.
7. Instruction to use the assigned path as shell `workdir` and absolute paths
   under that root for edits.
8. Instruction to run narrow repo-supported validation, create normal commits,
   and never amend or force-push.
9. Instruction not to push, switch branches, rebase, reset, or clean unless the
   manager identifies a concrete refresh reason, and never to delete branches
   or remove worktrees manually.
10. Report format: commit SHAs, changed paths, validation run, surprises, and any
   brief/code disagreement.

The owner-worker brief also says:

- form the implementation plan inside the approved PR scope
- integrate accepted supporting-worker commits
- remain available for verifier, CI, and review feedback
- create fix-forward commits for every requested change

Spawn writing workers with an explicit role and a self-contained brief. Do not
combine an explicit role with `fork_context`.

## Waiting

After dispatch, use remaining manager time for non-overlapping work. When worker
completion becomes the blocker, wait on all unresolved worker IDs together:

```text
wait_agent(targets=[...], timeout_ms=900000)
```

The default wait is 15 minutes. Increase it for tasks expected to take longer,
up to the API maximum. If the wait times out without a completed worker, wait
again with a long timeout. Do not fill the manager context with short polls or
routine "still working" updates.

## Manager Checks

Before accepting a worker result:

- inspect `git status --short`, diffstat, and commit metadata in the worker
  worktree
- inspect `git status --short` in the primary checkout
- reject edits outside the owned scope
- delegate full diff review to fresh read-only verifiers
- route every finding back to the owner worker for fix-forward commits
- never edit code, read the full diff, or run implementation validation in the
  manager session
