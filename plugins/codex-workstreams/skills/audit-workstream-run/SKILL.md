---
name: audit-workstream-run
description: Use when a completed or active Codex coding session should be evaluated as a workflow run, especially to identify where orchestration skills, sub-agent delegation, worktree routing, verification handoffs, PR monitoring, or compaction recovery worked well or caused friction.
---

# Audit Workstream Run

Evaluate another Codex session without loading its full transcript into the
manager context. Use the result to improve reusable workflow skills.

## Workflow

1. Read only lightweight metadata first:
   - `${CODEX_HOME:-$HOME/.codex}/session_index.jsonl`
   - rollout filenames under `${CODEX_HOME:-$HOME/.codex}/sessions/`
   - the first `session_meta` line when needed
2. Identify the relevant user-started parent rollout and direct descendants by
   session ID and `forked_from_id`.
3. Spawn a fresh read-only explorer to inspect the parent transcript and the
   minimum descendant transcript needed for a workflow audit.
4. Ask the explorer to omit implementation detail unless it explains a process
   failure. Require verified evidence and a separate inference section.
5. When the audit becomes the blocker, wait on the explorer with a `900000` ms
   timeout. Treat an ordinary timeout as still working and wait again without
   short polling.
6. Present a compact audit and proposed skill improvements. Do not edit skills
   until the user approves the revision batch.

## Explorer Brief

Request:

- chronological workflow timeline
- pipeline transitions and unnecessary branching
- explorer, worker, and verifier delegation behavior
- worker wait duration and repeated polling
- worktree helper use and sandbox routing
- PR-cycle publication, browser handoff, and monitor behavior
- compaction or interrupted-wait recovery
- actionable skill improvements ordered by impact
- source pointers using session IDs and timestamps

## Rules

- Keep raw rollout JSONL out of the manager context.
- Prefer one focused audit explorer over manager-side transcript reading.
- Read descendant metadata and final reports first; expand only when needed.
- Separate observed facts from hypotheses.
- Evaluate the workflow, not the implementation.
