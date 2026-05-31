# Workstream Note

Use a Markdown note as the durable handoff across compaction. It is a disposable
checkpoint for the active PR, not a transcript. Rewrite it in place whenever
the active phase, PR state, or next action changes. Never append history.

```md
# Objective

<goal and success criteria>

# Approved Scope

<approved architecture and boundaries>

# Remaining Approved PRs
- Current:
- Next:

# Current PR
- Phase:
- Branch:
- Target branch:
- Branch-point SHA:
- Depends on:
- Worktree:
- Owner worker:
- Supporting workers:
- Verifiers:
- Commits:
- URL:
- Waiting for:

# Candidate Follow-Ups
- <discovered work outside the approved scope>

# Relevant Decisions
- <only decisions still needed for the active or remaining PRs>

# Next Action

<single concrete next step>
```

Record dependencies directly in the remaining PR sequence. Keep only information
needed to resume current or future approved work. Delete the checkpoint as soon
as the current PR merges. If another approved PR remains, create a fresh minimal
checkpoint for that PR before starting it. Anything outside the approved scope
becomes a candidate follow-up and requires discussion.
