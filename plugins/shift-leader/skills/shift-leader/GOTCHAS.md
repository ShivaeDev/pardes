# shift-leader gotchas

Shared, durable lessons that hold for any shift-leader run. This is general reference material — read it at the start of a shift. Contributions are welcome: when you discover a new *universal* lesson (one that holds regardless of stack, repo, or habit), add it here so every shift leader benefits.

## A green build can be a false green on shared-type changes
An incremental build cache can skip rechecking files and report success while a real type error hides — the opposite failure mode from a flaky red. A change that widens or narrows a shared type (an annotation helper, a generic, a widely-imported type) can compile against a warm cache yet fail from a clean build, depending only on cache state. For any change touching a shared type or inference surface, do not trust a single incremental build: verify from a clean build (or force a full recheck) and confirm the type's dependents still compile. Bake "verify from a clean build, not just incremental" into the dispatch prompt for such changes.

## A compile-with-emit can drop stray artifacts beside sources
Running a compiler *with* emit (rather than no-emit) can drop generated files (e.g. `.js`) next to the sources they came from, and those output files may not be gitignored — so they show up as untracked and a blanket `git add -A` would commit build output. Before committing in any checkout, run `git status` and do not stage stray emit. Bake "verify no stray build artifacts are staged" into dispatch prompts for type-touching changes. (Deleting the strays is safe — they are just compiled output of tracked sources.)

## Writing sub-agents need real isolation, or they deadlock
A background orchestrator session that is not itself isolated cannot let a sub-agent write to the shared checkout: the agent's write is rejected, and its own attempt to enter a worktree also refuses — a deadlock the agent cannot resolve from inside, so it stalls with a fully-specified change and zero writes. Pass the harness's worktree-isolation flag in the dispatch options for every file-editing agent. An in-prompt "create your worktree" instruction is NOT enough. Read-only agents (investigations, design spikes) don't need it.

## Partition parallel writers by disjoint files — it's a correctness requirement, not tidiness
Two parallel agents that touch the same file clobber each other. The disjoint file partition is the only thing preventing it. Choose the cut before dispatching and verify it actually holds; never let two simultaneous writers share a file.

## When a brief and the code disagree, the agent must STOP
If a briefing asserts a domain fact and the code shows otherwise, the agent must not silently follow either one — it reports both halves (quote the brief, quote the code, name the disagreement) and the orchestrator owns the resolution, escalating to the user on a genuine fork. Scan every agent report for "I followed the brief over the code" / "the brief said X but the code does Y" and surface those before treating the work as canonical. The failure this prevents: a wrong assumption in a brief gets dutifully baked in, ships, and costs a revert plus trust.

## Verify dispatch parameters actually arrive before fanning out
If per-agent arguments silently fail to reach the dispatched agents, every agent runs with no mission and freelances — voiding the whole wave at full cost. Before launching a parameterized fan-out, confirm the per-agent spec actually lands (or inline each agent's mission directly into its prompt). Lock each agent to its specific deliverable and name what is out of scope, or agents drift.

## Verify the full relevant surface, not a convenient subset
A change to a shared schema or contract can regress an adjacent surface the agent never thought to test — a passing run on a hand-picked subset means nothing. Dispatch prompts for any shared-schema or contract change must require running the full suite across every affected surface, on every side a shared change can reach (not just the side that was edited). "X tests passing" in a report is only trustworthy if it is the whole suite.

## Re-review a fix-forward that CHANGED the approach
When a fix-forward implements a *different* approach than the original diff (e.g. a structural rewrite the first reviewer recommended), CI-green plus "the reviewer recommended this" is not the same as "the new implementation was verified." Before green-lighting it, run a second targeted read-only review scoped to exactly the risk the new approach introduces (e.g. does a client-side reimplementation reproduce identical results to the server path it replaces?). It is cheap and runs fine alongside a builder under the serialize-heavy-verification rule.

## Re-check PR state before assuming it's still open
The user reviews fast and may merge (or enable auto-merge) before you notice. Always re-check the PR's state before assuming it is still open and before advancing or dispatching dependent work.

## The worktree bootstrap is repo-specific — confirm it, don't assume
The fresh-worktree setup (install deps, run codegen, copy gitignored local config, apply migrations) differs per repo. Before baking a bootstrap command into dispatch prompts, confirm what the repo actually uses — read its contributor docs and its package/build manifest scripts. A fresh isolated worktree also lacks gitignored local config (a `.env`-style file), so any agent that type-checks/builds/tests must copy or seed that config as part of bootstrap.

## In-worktree checks are authoritative — fix the failure, don't blame infra
A type-check / lint / test failure inside an agent's own worktree is a REAL failure — fix the root cause. Do NOT treat it as a worktree/infra false-positive, and do NOT tell agents to "confirm against the main checkout / CI" before believing it. Once worktree isolation is configured correctly, that re-confirmation is a stale workaround that only makes agents circle on genuine compile/lint errors instead of fixing them. If the hook or check reports something, it's real.

## The orchestrator may commit/push/open PRs — only merging is off-limits
Committing, pushing, and opening a PR are all fine for the orchestrator (e.g. to land an agent's commit if it stalls mid-way); the one off-limits action is merging — the user does that. Agents commit in their own worktree and let the pre-commit hook run clean there; do not manufacture a "the worktree hook is unreliable, let me commit in the primary checkout instead" rationale. If the hook reports something, it's real.

## Amending/force-pushing your OWN unmerged branch is fine
A no-force-push rule targets shared or already-merged history (such as the default branch). For a solo, not-yet-merged feature branch you alone own, amending or force-pushing to tidy it up is fine and beats noisier close-and-recreate churn. (Some repos still adopt an absolute no-force policy — honor the repo's own rule when it's stricter.)

## Workflow ideas (build a library over time)
- **writer → reviewer:** agent A implements a PR in a worktree; agent B adversarially reviews the diff (or posts inline review comments) before the PR opens.
- **read-only investigation:** fan out readers → synthesis → a completeness critic that catches fabricated citations and unread surfaces. Investigate-and-interview a distrusted system *before* dispatching any mutation work.
- **parallel worktree edits + serialized heavy verification:** run only one heavy verification (full test/build) at a time to avoid memory exhaustion; each agent verifies fully in its own worktree, so no re-run in the primary checkout is needed.
- (add more as they prove out)
