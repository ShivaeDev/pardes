// writer-reviewer — implement a change in isolation, then have a SECOND,
// adversarial agent review the resulting diff before any PR opens.
//
// Shape: pipeline (writer -> reviewer), with a bounded fix⟲re-review loop. The
// reviewer must see the writer's committed diff, so this is sequential, not
// parallel. The writer runs worktree-isolated (a file-editing agent in a
// non-isolated orchestrator cannot write to the shared checkout and stalls).
//
// Continuity gotcha (the load-bearing detail): each worktree-isolated agent gets
// a FRESH worktree branched from the base — they do NOT share a working tree. So
// state flows between rounds through the git BRANCH, whose ref is shared across
// every worktree of the repo: the writer reports its branch, the reviewer diffs
// that ref read-only, and the fixer branches a NEW ref off it. (You can't check
// out a branch that's still checked out in another worktree — but you can always
// branch FROM it.)
//
// HARD BOUNDARY: this workflow NEVER merges and NEVER opens a PR. It returns the
// final branch plus the review verdict so a human makes the call. Opening the
// PR — and certainly merging it — stays a human decision.
//
// args: a task description string, or { task, base?, maxRounds?, setupCommand? }.
//   - task         (required) what to implement, in generic second person.
//   - base         (optional) base ref to diff against; default below.
//   - maxRounds    (optional) max fix→re-review cycles; default 2, capped at 4.
//   - setupCommand (optional) one-shot bootstrap to run in the fresh worktree
//                  (deps/codegen/local config). Safe no-op when unset.

export const meta = {
  description:
    'Implement a change in a worktree-isolated agent, then run an adversarial reviewer over the diff (bounded fix⟲re-review loop). Never merges or opens a PR — returns the final branch and a structured verdict for a human.',
  name: 'writer-reviewer',
  phases: [
    { detail: 'A worktree-isolated writer agent implements the task.', title: 'Implement' },
    { detail: 'An adversarial read-only reviewer judges the diff.', title: 'Review' },
    {
      detail: 'Blocking findings go back to a fixer, then re-review (bounded).',
      title: 'Fix ⟲ Review',
    },
    { detail: 'Return the final branch and verdict — no merge, no PR.', title: 'Hand back' },
  ],
  whenToUse:
    'Use to get an independent, adversarial review of a change before it becomes a PR — catching the defects a self-reviewing author misses.',
};

const task = typeof args === 'string' ? args : args?.task;
const base = (typeof args === 'object' && args?.base) || 'the default branch';
const maxRounds = Math.min(
  Math.max(Number((typeof args === 'object' && args?.maxRounds) || 2), 1),
  4,
);
const setupCommand = (typeof args === 'object' && args?.setupCommand) || '';

if (!task) {
  log('No task provided. Pass a description string or { task, ... }.');
  return { error: 'missing-task' };
}

// Writer/fixer report their branch (structured) so the next step can diff it or
// branch off it — see the continuity gotcha at the top.
const workSchema = {
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    summary: { type: 'string' },
    worktreePath: { type: 'string' },
  },
  required: ['branch', 'summary'],
  type: 'object',
};

// Reviewer verdict shape — we branch on `verdict`, so it must be structured.
const reviewSchema = {
  additionalProperties: false,
  properties: {
    diffSummary: { type: 'string' },
    findings: {
      items: {
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          issue: { type: 'string' },
          severity: { enum: ['blocker', 'major', 'minor', 'nit'] },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'issue', 'suggestion'],
        type: 'object',
      },
      type: 'array',
    },
    verdict: { enum: ['approve', 'request-changes', 'reject'] },
  },
  required: ['verdict', 'diffSummary', 'findings'],
  type: 'object',
};

const setupNote = setupCommand
  ? `First bootstrap the worktree by running: ${setupCommand}`
  : 'If the repo needs a bootstrap step (deps/codegen/local config), read its contributor docs and run it.';

phase('Implement');
let work = await agent(
  `Implement this task in your own isolated worktree, then commit it to your branch. ${setupNote}\n` +
    `Make the change cleanly — no shortcuts, no disabling checks. If the task's premise\n` +
    `conflicts with the code, STOP and report the conflict instead of guessing.\n` +
    `Do NOT open a PR and do NOT merge. Report your branch name, worktree path, and a\n` +
    `short summary of what you did.\n\nTASK:\n${task}`,
  { isolation: 'worktree', label: 'writer', phase: 'Implement', schema: workSchema },
);
let currentBranch = work.branch;

let review;
for (let round = 1; round <= maxRounds; round++) {
  phase(round === 1 ? 'Review' : `Fix ⟲ Review (round ${round})`);
  review = await agent(
    `Adversarially review the committed diff on branch "${currentBranch}", READ-ONLY —\n` +
      `e.g. \`git fetch\` then \`git diff ${base}...${currentBranch}\`. Do NOT check the branch\n` +
      `out and do NOT edit anything. Be skeptical: correctness bugs, missed edge cases,\n` +
      `broken contracts, shortcuts. Verdict 'approve' only if you'd merge it as-is.\n\n` +
      `Writer summary:\n${work.summary}`,
    { label: 'reviewer', phase: 'Review', schema: reviewSchema },
  );

  const blocking = (review.findings || []).filter(
    (f) => f.severity === 'blocker' || f.severity === 'major',
  );
  if (review.verdict === 'approve' || blocking.length === 0) break;
  if (round === maxRounds) {
    log(`Still ${blocking.length} blocking finding(s) after ${maxRounds} round(s); handing back.`);
    break;
  }

  phase(`Fix (round ${round})`);
  work = await agent(
    `A reviewer raised these blocking findings. In your own isolated worktree, branch off\n` +
      `the prior work and fix them: \`git fetch\` then\n` +
      `\`git checkout -b ${currentBranch}-fix${round} ${currentBranch}\` (you can't check out\n` +
      `${currentBranch} directly — it may still be checked out elsewhere — so branch off it).\n` +
      `Address each finding, commit, and report the NEW branch name. Do not open a PR or merge.\n\n` +
      `Findings:\n${JSON.stringify(blocking, null, 2)}`,
    { isolation: 'worktree', label: 'fixer', phase: 'Fix', schema: workSchema },
  );
  currentBranch = work.branch;
}

phase('Hand back');
// No merge, no PR — a human opens the PR on `finalBranch` after reading this.
return {
  finalBranch: currentBranch,
  note: 'No PR opened and nothing merged — review, then open the PR on finalBranch yourself.',
  review,
  work,
};
