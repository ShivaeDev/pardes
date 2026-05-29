# workflows

A starter library of reusable Workflow-tool orchestration scripts for the
[pardes](../../README.md) marketplace. Each script
ships as a deterministic ES module under `workflows/` and is auto-discovered by
Claude Code, registered as `workflows:<name>`.

These are **reference examples** as much as tools: small, heavily commented, and
parameterized entirely through `args` — no hardcoded repo paths, branch names,
bootstrap commands, or home directories. Read them, fork them, adapt them.

## Install

```bash
/plugin marketplace add ShivaeDev/pardes
/plugin install workflows@pardes
```

Once installed, each script is callable by its namespaced id from any session:

```js
Workflow({ name: 'workflows:writer-reviewer', args: '<task description>' });
```

> No manifest entry is needed — Claude Code auto-loads every `*.js` in this
> plugin's `workflows/` directory and registers it from its `export const meta`.

## Shared disciplines

Every script bakes in the same posture:

- **Writers run worktree-isolated** (`isolation: 'worktree'`); read-only agents do
  not, because a file-editing agent in a non-isolated orchestrator stalls. The one
  deliberate exception is `investigate`'s synthesis, which writes a single report
  to an **absolute path outside any checkout** so a non-isolated orchestrator can
  run it and the caller can still read the deliverable.
- **Never merge, never open a PR.** The workflows hand back a branch (or results)
  and a verdict; a human opens the PR and decides whether to merge.
- **Continuity flows through git branches.** Each isolated agent gets a *fresh*
  worktree, so work is passed between agents by branch ref (diff it, or branch off
  it) — not by sharing a working tree.
- **Lean context.** Long artifacts are written to files; only a tight briefing and
  the path come back to the caller.
- **Structured output** (`schema`) is used for any result the workflow branches on.

## The workflows

### `workflows:writer-reviewer`

Implement a change in a worktree-isolated agent, then have a *second, adversarial*
agent review the resulting diff — catching the class of defects a self-reviewing
author misses. Optionally loops: blocking findings go back to a fixer and get
re-reviewed. `maxRounds` is the **max number of fix attempts** (each followed by a
re-review); there is always an initial review, and `maxRounds: 0` disables fixing
(review only). **Never merges and never opens a PR** — it returns the final branch
plus the structured verdict so a human makes the call.

```js
// string form — just the task
Workflow({ name: 'workflows:writer-reviewer', args: 'Add retry-with-backoff to the upload client.' });

// object form
Workflow({
  name: 'workflows:writer-reviewer',
  args: {
    task: 'Add retry-with-backoff to the upload client.',
    maxRounds: 2, // max fix attempts, each re-reviewed; default 2, capped at 4 (0 = review only)
    setupCommand: './script/bootstrap', // optional one-shot worktree bootstrap; no-op if unset
  },
});
```

`args`: a task string, or `{ task, base?, maxRounds?, setupCommand? }`.

### `workflows:investigate`

Answer a research/architecture question **read-only**: fan out reader agents over
several angles, synthesize their findings, then run a completeness critic that
flags fabricated citations, unread surfaces, and missing angles. Real gaps feed one
more bounded round. Writes the full report to a file and returns only a tight
briefing plus the path.

```js
// string form — just the question
Workflow({ name: 'workflows:investigate', args: 'How does session resumption work after a crash?' });

// object form
Workflow({
  name: 'workflows:investigate',
  args: {
    question: 'How does session resumption work after a crash?',
    angles: ['storage format', 'replay path', 'failure modes'], // optional; derived if omitted
    roots: ['src/session', 'docs/architecture'], // optional scope hints
    reportPath: '/tmp/session-resume-report.md', // optional; default /tmp/investigation-report.md
  },
});
```

`args`: a question string, or `{ question, angles?, roots?, reportPath? }`. `reportPath`
must be an **absolute path outside any git checkout** — the synthesis agent is not
worktree-isolated, so a path inside a checkout would stall a non-isolated orchestrator.

### `workflows:parallel-verify`

Fan out one worktree-isolated writer per **disjoint** work partition, then
**integrate the partition branches** (merge their refs into one fresh worktree) and
run a **single serialized** heavy verification on the combined result. Writers run
in parallel (isolated in their own worktrees), but the heavy build/test runs exactly
once, alone — running several heavy verifications at once can exhaust memory. The
caller supplies the partition cut (the workflow never invents one); if `partitions`
is missing or empty, it logs and returns early. A real merge conflict at integration
means the partitions weren't disjoint. **Never merges to the base branch and never
opens PRs.**

```js
Workflow({
  name: 'workflows:parallel-verify',
  args: {
    partitions: [
      { label: 'api', files: ['src/api/**'], task: 'Add pagination to the list endpoints.' },
      { label: 'ui', files: ['src/ui/list/**'], task: 'Render the paginated list with a load-more button.' },
    ],
    verifyCommand: 'bun run ci', // optional heavy build/test; skipped (logged) if unset
    setupCommand: './script/bootstrap', // optional per-worktree bootstrap; no-op if unset
  },
});
```

`args`: `{ partitions: [{ label, files, task }], base?, verifyCommand?, setupCommand? }`.
Partitions **must** touch disjoint files — that disjointness is the only thing
preventing parallel writers from clobbering each other.
