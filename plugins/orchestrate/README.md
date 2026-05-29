# orchestrate

A single-skill plugin for shipping a big PR in one session without overflowing context.

Some changes are too large for one agent to hold but cleanly sequenceable into discrete commits — a migration, a multi-subsystem refactor, a feature that touches the data model, the API, and the UI in order. `orchestrate` is a two-phase workflow for exactly that shape:

1. **Plan** — a multi-round interview narrows scope and structure *before* any code, because a pivot during execution is far more expensive than one during planning.
2. **Dispatch** — sequential sub-agents, one chunk per agent and one commit per chunk. The orchestrator stays high-level and briefs each agent; the sub-agents do the coding.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install orchestrate@pardes
```

## Use

Invoke `/orchestrate` (or just describe a large, sequenceable PR and ask to drive it autonomously). The skill walks the interview, writes a visible plan, then dispatches chunk by chunk and opens the PR.

**Reach for it when:** the work spans more files than one agent can hold (roughly ≥30, multiple subsystems) and has real internal sequencing.

**Skip it for:** single-file changes, exploration questions, or anything that fits in one agent context.

See `skills/orchestrate/SKILL.md` for the full briefing templates, test-run protocol, and pause-and-ask triggers.
