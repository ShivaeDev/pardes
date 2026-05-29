# shift-leader gotchas

Durable, universal lessons for any shift-leader run — read at the start of a shift. Contributions welcome: add a lesson when it holds regardless of stack, repo, or habit.

## A green build can be a false green
Incremental build caches skip rechecking and can report success while a real type error hides. After any change to a shared type, generic, or widely-imported surface, verify from a *clean* build and confirm dependents still compile — don't trust one incremental pass.

## Compile-with-emit drops stray artifacts
A compiler run *with* emit can leave generated files (e.g. `.js`) beside their sources, often un-gitignored — so a blanket `git add -A` commits build output. Check `git status` before staging; never stage stray emit. (Deleting strays is safe.)

## Verify the full surface, not a convenient subset
A change to a shared schema or contract can regress an adjacent surface the agent never tested. Require the full suite across *every* affected side — "X tests passing" only counts if it's the whole suite.

## Writing sub-agents need real isolation
A non-isolated orchestrator can't let a sub-agent write to the shared checkout: the write is rejected, the agent can't self-isolate, and it stalls. Pass the harness's worktree-isolation flag for every file-editing agent — an in-prompt "make your own worktree" is not enough. Read-only agents don't need it.

## Partition parallel writers by disjoint files
Two parallel agents on the same file clobber each other; disjoint partitioning is the only thing preventing it — a correctness requirement, not tidiness. Choose the cut before dispatching and confirm it holds.

## Verify dispatch parameters actually arrive
If per-agent args silently fail to reach the agents, the whole wave runs mission-less and freelances at full cost. Confirm the per-agent spec lands (or inline each mission into its prompt), and name what's out of scope.

## When brief and code disagree, STOP
If a briefing asserts a fact the code contradicts, the agent reports both halves (quote each, name the conflict) instead of silently picking one; the orchestrator resolves it, escalating on a genuine fork. Watch agent reports for "the brief said X but the code does Y" before trusting the work.

## Re-review a fix-forward that CHANGED the approach
When a fix-forward takes a *different* approach than the original (e.g. a structural rewrite), CI-green plus "the reviewer suggested it" is not the same as verified. Run a second read-only review scoped to the new approach's specific risk before green-lighting.

## In-worktree checks are authoritative
A type/lint/test failure in an agent's own worktree is REAL — fix the root cause. Don't dismiss it as an infra false-positive or tell agents to "re-confirm against the main checkout / CI"; once isolation is set up correctly, that re-confirmation is a stale workaround that makes agents circle instead of fixing the error.

## Re-check PR state before relying on it
The user reviews fast and may merge (or auto-merge) before you notice. Re-check a PR's state before assuming it's still open and before advancing dependent work.

## The orchestrator may commit/push/open PRs — only merging is off-limits
Committing, pushing, and opening PRs are fine (e.g. to land a stalled agent's commit); merging is the user's call. Let the pre-commit hook run clean in the agent's own worktree — don't invent a "the worktree hook is unreliable" excuse to commit in the primary checkout.

## Amending/force-pushing your OWN unmerged branch is fine
The no-force rule targets shared or already-merged history (e.g. the default branch). On a solo, unmerged branch you alone own, amend/force-push beats noisier close-and-recreate. (Honor a repo's stricter absolute-no-force rule where it has one.)

## The worktree bootstrap is repo-specific — confirm it
Fresh-worktree setup (deps, codegen, gitignored local config, migrations) differs per repo; read the repo's contributor docs and manifest scripts before baking a bootstrap into prompts. A fresh worktree also lacks gitignored local config (a `.env`-style file) — agents that build or test must seed it.

## Workflow ideas (build a library over time)
- **writer → reviewer:** agent A implements a PR in a worktree; agent B adversarially reviews the diff before it opens.
- **read-only investigation:** fan out readers → synthesis → a completeness critic that catches fabricated citations and unread surfaces.
- **parallel edits + serialized heavy verification:** run only one heavy build/test at a time (memory); each agent verifies in its own worktree, so no primary-checkout re-run.
- (add more as they prove out)
