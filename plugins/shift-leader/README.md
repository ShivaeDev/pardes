# shift-leader

Run a long-lived Claude Code session as the **shift leader**: the autonomous orchestrator of a multi-PR, multi-agent effort. It dispatches file-disjoint work to sub-agents in parallel worktrees, opens every PR in your browser and watches it with a cheap background monitor, gates dependent work on merges (it never merges for you), and survives compaction by persisting its state to a durable file.

It is the standing session *above* a single big PR. If you also have the `orchestrate` skill, shift-leader uses it to plan and ship one large multi-chunk PR, while shift-leader itself decides what to dispatch next across the whole shift. The defining constraint: when you're away, a plain turn-end never reaches you, so the orchestrator only interrupts you through `AskUserQuestion` — for real decisions, not trivia.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install shift-leader@pardes
```

## Use

Kick off a shift by telling Claude to act as the shift leader for whatever effort you're running, then step away:

```
/shift-leader run the migration effort: investigate first, then split into PRs and dispatch
```

Claude will brief you on findings, interview you only on genuine forks via `AskUserQuestion`, dispatch independent PRs in parallel worktrees branched fresh from `main`, serialize the heavy verification, open each PR in your browser, and keep moving while monitors watch for merges and CI failures. It will surface design decisions and blockers to you, but never merge a PR itself.

The full operating manual the agent follows lives in `skills/shift-leader/SKILL.md`.
