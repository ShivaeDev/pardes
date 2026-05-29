---
name: orchestrate
description: Plan a large multi-chunk PR through a user interview, then ship it by dispatching focused Opus sub-agents one chunk at a time. Use when the work is too big for a single agent context but is sequenceable into discrete commits.
user-invocable: true
---

# orchestrate

A two-phase workflow for big PRs that would otherwise overflow context or get bogged down mid-stream.

**Phase 1 — Plan.** A multi-round interview narrows scope and shape before any code.
**Phase 2 — Dispatch.** Sequential sub-agents, one chunk per agent, one commit per chunk.

The orchestrator (you) stays high-level. Sub-agents do the coding. That separation is what unlocks big PRs in one session.

## When to use

- The work spans more files than one agent can hold (typically: ≥30 files modified, multiple subsystems).
- The work has internal sequencing — chunk N depends on chunk N-1 in a way that makes parallelism counterproductive.
- The user has explicitly asked you to drive it autonomously to a PR, or it's obvious from the brief that's the shape.

**Don't use** for: single-file changes, exploration questions, work that fits in one agent context, or work where the sequencing isn't yet clear (plan first, dispatch later).

## Phase 1 — Plan

### Interview the user across multiple AskUserQuestion rounds

Bias toward more rounds, not fewer. Each round narrows one tier of decision. A representative arc:

1. **Scope tier.** Bundled vs phased. Which adjacent work to absorb. What to defer.
2. **Shape tier.** Interface shape, manifest shape, data-model shape. The structural decisions that fall out of scope.
3. **Detail tier.** Specific field semantics, relationship directions, invariant rules. Anything the user hasn't seen articulated yet.

Use `AskUserQuestion` with 3–4 options per question, and mark the recommended one. If the user pushes back on a framing ("that concept should disappear entirely"), reframe and re-ask — don't proceed on a misread.

A pivot inside the interview is cheap. A pivot during execution is expensive. Spend the rounds.

### Write the plan visibly before any code

After the interview settles, output two things in one message:

1. **Goals (ideal end state).** Bulleted by area. What the world looks like after the PR merges.
2. **Sequence.** Numbered chunks, one paragraph each. Each chunk specifies: what it changes, what it depends on, and whether it commits clean or as intentional WIP.

The plan is the source of truth for every sub-agent prompt. Work from conversation context rather than saving it to a file.

Then create a task per chunk so progress is trackable.

## Phase 2 — Dispatch

### Branch first

A short-lived branch off the default branch. Name it after the PR (`feat/auth-rewrite`, `migrate-payments-schema`, etc.).

### One chunk = one sub-agent = one commit

Sequential, never parallel. Parallel sub-agents on dependent work create orchestration overhead and lose the "next agent sees the prior commit" simplicity.

Each sub-agent invocation:

```
Agent({
  description: "Chunk N: <short>",
  subagent_type: "general-purpose",
  model: "opus",                          // largest-context model — explicit override
  prompt: <see briefing template below>
})
```

Always pass `model: "opus"` explicitly. Sub-agents otherwise default to smaller models that can't carry these briefings.

### Per-chunk briefing template

Every sub-agent prompt has these sections, in this order:

1. **Position.** "You are implementing chunk N of M in PR X. Branch is `<name>` at `<path>`. Chunks 1..N-1 already landed (commits `<sha1>`, `<sha2>`, ...)."
2. **State after prior chunks.** Bulleted: what the codebase looks like now. The agent doesn't see your conversation — it needs this.
3. **PR overall goal.** One paragraph. Context, not deliverable.
4. **This chunk's deliverable.** Concrete. File paths. Specific shapes. Code skeletons where helpful.
5. **Constraints.** Don't touch X / Y / Z. Test-run protocol. WIP-commit permission scope. No type-escape hatches. Stop-and-report if stuck. **Brief vs. code disagreement → STOP, don't pick a side.** If the brief asserts a domain fact ("X persists across Y", "behavior Z is required") and the code shows something different, the agent must stop and report *both halves* — quote the brief, quote the code, name the disagreement. Don't silently follow either. The orchestrator owns the resolution; the agent's job is to surface, not decide.
6. **Commit message.** The exact text. Include the chunk number and a WIP marker if applicable.
7. **Report-back format.** Under N words. Specific items to enumerate. "STOP and report rather than guess" for genuine ambiguity.

Be generous with context — sub-agents on cold start can't infer what they don't see. The brief for chunk 4 in a 10-chunk PR is rightly 300+ lines.

### Test-run protocol (hard rules)

- **One test run at a time, synchronous.** Running multiple heavy test/build processes in parallel can exhaust memory and crash the machine. Never start a parallel run. Never relaunch before completion.
- **Redirect to a log file**: `<test command> > <tmp-log> 2>&1`, then read with `tail` or grep for `FAIL`. Keeps multi-megabyte output out of the agent's context.
- **Tests run only when relevant.** WIP chunks that intentionally break the code globally should skip the full test run entirely — type-check the touched scope only.
- **The final chunk runs the full quality gate** (lint + type-check + tests) and only commits if green. No bypassing verification for the close.

### Intentional-WIP discipline

Skipping pre-commit verification is permitted only on chunks the plan explicitly labels WIP, and the justification is always the same: "intermediate states are intentionally red; subsequent chunks bring it back to green." Never carry it over to clean chunks. Never use it on the chunk that opens the PR.

### Verifier (optional but valuable)

After a sub-agent reports done, decide whether to spot-check:

- **Skip the verifier** when: the chunk was purely additive, the implementer ran type-check + tests green, and the report is detailed enough to trust.
- **Run a verifier sub-agent** when: the chunk was a big breaking surface (a destructive migration, a service rewrite), the implementer pivoted from the brief, or the report flags surprises.

A verifier doesn't fix — it spots problems and reports back. Keep its brief tight: "spot-check this specific deliverable, not global green."

### Pause-and-ask triggers

Stop and surface to the user if:

- A sub-agent reports an unexpected pivot that affects scope.
- A real design question surfaces that wasn't pre-decided (e.g. the UX shifts as forced by a backend contract).
- A chunk's verifier flags semantic concerns, not just nits.
- The work reveals a real bug in prior chunks that needs a decision.
- A sub-agent's report flags a "deliberate divergence" between the brief and the code, *or* its findings show the brief was wrong about a domain fact. Don't accept the agent's resolution silently — surface both sides to the user with the agent's exact phrasing, and let them decide before the chunk's commit is treated as canonical. Scan every report for phrases like "deliberate divergence", "the brief said X but the code does Y", "I followed the brief over the code" — those are the textual signals.

Don't pause for: typing nuances, mechanical drift, or decisions the user already implied. The interview's job was to remove these pre-emptively.

## Anti-patterns to avoid

- **Skipping the interview.** If you start dispatching with unclear scope, the first chunk's sub-agent will surface the ambiguity at high cost.
- **Parallel sub-agents on sequential work.** Save token budget by going sequential — each chunk's sub-agent reads the prior commit cleanly. Parallel only helps for genuinely independent surfaces.
- **Coding yourself.** The orchestrator's job is briefing, sequencing, and verification. If you find yourself reading 10 files and writing edits, you're filling a sub-agent's role and losing the context-efficiency that makes this approach work.
- **Verbose chunk-by-chunk narration.** Status one-liners between chunks ("Chunk 3 landed, moving to chunk 4") are enough. The detailed reports are tool output, not user-facing — summarize at the end.
- **Forgetting `model: "opus"`.** Default sub-agent models can't carry the context these briefings demand. Always override.
- **Briefs that contain domain mistakes get baked in by dutiful agents.** The orchestrator writes "X persists across Y" as a stated fact in the brief. The agent's audit catches that the code actually does the opposite. The report flags it as "deliberate divergence" — a clear yellow flag. The orchestrator reads the report, accepts the framing, and moves on. The mistake ships and gets caught downstream — costing a fix commit, a revert, and the user's trust. Mitigation has three parts: (1) agents must stop on brief-vs-code disagreement (per the briefing template's Constraints); (2) orchestrators must read every report for "deliberate divergence" phrasing and surface it to the user as a pause-and-ask trigger; (3) orchestrators must read the code authoritatively before writing briefs about contested domain facts (domain intent, state-reset semantics, persistence rules) — don't assume the docs are current. When in doubt, ask the user before writing the brief, not after the chunk lands.

## Closing the PR

After the final chunk lands green:

1. `git push -u origin <branch>`.
2. `gh pr create` with the project's PR template (or your standard Why / How / Decisions / Callouts format).
3. The PR's Decisions section is where the genuinely meaningful tradeoffs go — bullet each one with the reason. Mid-execution sub-agent surfacings (UX shifts, real bug fixes, scope pivots) belong here, not just the up-front scope choices.
4. The PR's Callouts section flags reviewer eyes: migration discipline, accessor-rename surface, env-var dependencies, anywhere the PR is a one-way door.
5. Verify CI with `gh pr checks <num>`.

## Memory hygiene

Before starting, check memory for:

- Feedback about PR shape, commit conventions, and test discipline.
- Project memory for the repo's own conventions (test-run rules, commit protocol).

After finishing, capture only genuinely new feedback as memory — not the chunk-by-chunk specifics, which are PR-scoped, not skill-scoped.
