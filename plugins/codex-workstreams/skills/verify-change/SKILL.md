---
name: verify-change
description: Use when implementation is complete or a PR branch changed after feedback and needs repo-native quality gates, diff review, and a clear readiness decision before publication or another review cycle.
---

# Verify Change

Verify every implementation through fresh read-only verifier agents. Keep the
manager on summaries, commit metadata, and diffstat.

## Workflow

1. Spawn at least one fresh read-only verifier with the approved PR goal,
   worktree path, branch-point SHA, target branch, commit SHAs, and worker
   validation report.
2. Spawn additional verifiers in parallel when distinct review angles are
   useful.
3. Require verifiers to inspect the full diff and report correctness issues,
   regressions, scope drift, missing validation, unrelated files, generated
   artifacts, and unnecessary complexity.
4. Route every finding back to the owner worker. The owner creates normal
   fix-forward commits and reruns validation.
5. Repeat verification until the verifiers accept the branch.
6. Use `run-pr-cycle`.

The manager does not read the full diff, edit code, or apply fixes.
