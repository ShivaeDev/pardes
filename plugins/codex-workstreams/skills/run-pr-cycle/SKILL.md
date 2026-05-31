---
name: run-pr-cycle
description: Use when a verified owner-worker branch is ready to publish, or when an open pull request needs blocking lifecycle management through CI failures, review feedback, conflicts, and merge.
---

# Run PR Cycle

Publish a verified owner-worker branch, hand the pull request to the user, and
block until GitHub reports activity that needs attention.

## Publish

1. Check accepted commits, diffstat, verifier conclusions, and worker validation
   without reading the full diff.
2. Use `write-pr-description`.
3. Push the owner-worker branch and create or update the pull request with the
   correct base branch and issue links.
   - When using `gh`, write the PR body to
     `${CODEX_ARTIFACTS_DIR:-$HOME/codex-artifacts}/pr-bodies/codex-pr-body-<branch-slug>.md`,
     pass it with `--body-file <path>`, and delete it immediately after GitHub
     accepts the pull request. Do not use a system temporary directory or the
     ignored `.worktrees/` directory.
   - Keep the host-executed `gh pr create` command simple so persisted prefix
     approval can match it. Do not embed a multiline body with `$'...'`, a
     heredoc, redirection, command substitution, or a pipeline.
4. Open the pull request in the user's browser with `gh pr view --web <pr-url>`.
   Run this outside the sandbox because it launches a host GUI.
5. Record the PR URL and waiting state in the workstream note.

The manager publishes. Workers commit but do not push. Never amend,
force-push, or merge.

## Wait

Run the monitor outside the sandbox from the outset because `gh` needs local
authentication and GitHub access:

```bash
uv run "<run-pr-cycle-skill>/scripts/watch_pr.py" <pr-url>
```

The helper always blocks until attention is required. Give the shell command a
wait of at least 30 minutes when the tool supports a timeout. If the shell
yields a running session, block on that process with long waits. Do not create a
model-side polling loop.

When the helper returns, treat its JSON as an immediate notification. Read
`attention`, `action_types`, and `observation` before deciding what to do next.
`observation: initial_snapshot` means an actionable state was already present
when monitoring began; it does not mean the helper is still waiting.

The helper stores machine state at:

```text
${CODEX_HOME:-$HOME/.codex}/state/pr-monitor/github.com/<org>/<repo>/<number>/state.json
```

## Handle Events

- `ci_failed`: route the failing logs to the owner worker.
- submitted review feedback: route the complete batch to the owner worker.
- `conflict`: route conflict resolution to the owner worker.
- `merged`: delete the completed PR's workstream note, sync the primary
  checkout with the repository's normal workflow, and continue the next
  approved PR automatically. Do not rebase active independent worker branches.
  Create a fresh minimal note only if another approved PR remains.
- `closed_unmerged`: stop and ask the user how to proceed.

After worker fixes, use `verify-change`, push the new commits, and start one
fresh blocking monitor.

The helper ignores unsubmitted draft reviews, green CI, pending CI transitions,
routine head updates, bare approvals, deployment-bot conversation comments, and
pre-existing discussion when it creates a new state file. It batches review
bursts before returning.
