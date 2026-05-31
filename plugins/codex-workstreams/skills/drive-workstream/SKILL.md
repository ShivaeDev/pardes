---
name: drive-workstream
description: Use when a coding objective spans multiple workflow phases or pull requests and needs a persistent manager to coordinate investigation, architecture, planning, implementation, verification, PR creation, review feedback, and merge gates across a long-running session.
---

# Drive Workstream

Manage a substantial coding objective from initial understanding through a
sequence of reviewed pull requests. Keep the main session focused on decisions,
durable state, delegation, and user communication. The manager coordinates the
work but does not implement or review code itself.

## Pipeline

1. Clarify the objective and constraints.
2. Use `investigate-codebase` to gather evidence with read-only explorers.
3. Discuss the evidence, architecture, scope, and PR sequence with the user.
   Do not begin implementation until the user approves the scope and sequence.
4. Create a Markdown workstream note under:
   `${CODEX_ARTIFACTS_DIR:-$HOME/codex-artifacts}/workstreams/<repo-key>/<workstream>.md`
5. For each approved PR:
   - use `implement-change`
   - use `verify-change`
   - use `run-pr-cycle`
6. After merge, sync the primary checkout with the repository's normal
   workflow, delete the completed PR's note, and continue the next approved PR
   automatically. If another approved PR remains, create a fresh minimal note
   for it before starting work.

Use [references/workstream-note.md](references/workstream-note.md) when creating
or recovering a note.

## Manager Rules

- Delegate code inspection to explorers, code changes to writing workers, and
  full diff review to fresh read-only verifiers.
- Do not edit source code, read complete diffs, or run implementation validation
  in the manager session.
- Own cheap metadata checks, worktree creation, durable state, publication,
  browser handoff, and blocking waits.
- Treat the workstream note as a disposable checkpoint, not a journal. Rewrite
  it in place with current state only. Do not append progress history.
- Use one owner worker per PR. Spawn supporting workers when independent chunks
  can proceed in parallel. The owner worker integrates accepted support commits.
- Keep the owner worker available for verifier, CI, and review feedback.
- Keep active worker branches on their assigned branch-point SHA. Movement on
  the target branch alone is not a reason to rebase or recreate them.
- Record newly discovered work outside the approved scope as candidate
  follow-ups. Do not ship it inline.
- Never merge unless explicitly asked.

## Compaction Recovery

When a workstream note exists, read it before continuing. Check for outstanding
descendants, ingest any final worker or verifier reports, reconcile the current
PR state with GitHub, then resume from `Next action`. Keep detailed reports in
`${CODEX_ARTIFACTS_DIR:-$HOME/codex-artifacts}/reports/<repo-key>/<workstream>/`
and retain only concise summaries in the main session. A merged PR must not
leave a checkpoint behind. Before dispatching another worker, reread
`implement-change` and use its managed worktree helper.

## Escalate

Ask the user when investigation reveals a real product or architectural fork,
the requested scope conflicts with code evidence, work falls outside the
approved sequence, a worker reports a brief/code contradiction, or a PR is
closed without merging. Continue routine transitions inside the approved
sequence automatically.
