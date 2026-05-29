// writer-reviewer — implement a change in isolation, then have a SECOND,
// adversarial agent review the resulting diff before any PR opens.
//
// Shape: pipeline (writer -> reviewer), with a bounded fix⟲re-review loop. The
// reviewer must see the writer's committed diff, so this is sequential, not
// parallel. The writer runs worktree-isolated (a file-editing agent in a
// non-isolated orchestrator cannot write to the shared checkout and stalls).
//
// HARD BOUNDARY: this workflow NEVER merges and NEVER opens a PR. It returns the
// diff location plus the final review verdict so a human makes the call. Opening
// the PR — and certainly merging it — stays a human decision.
//
// args: a task description string, or { task, maxRounds?, setupCommand? }.
//   - task         (required) what to implement, in generic second person.
//   - maxRounds    (optional) max fix→re-review cycles; default 2, capped at 4.
//   - setupCommand (optional) one-shot bootstrap to run in the fresh worktree
//                  (deps/codegen/local config). Safe no-op when unset.

export const meta = {
  description:
    'Implement a change in a worktree-isolated agent, then run an adversarial reviewer over the diff (bounded fix⟲re-review loop). Never merges or opens a PR — returns the diff location and a structured verdict for a human.',
  name: 'writer-reviewer',
  phases: [
    { detail: 'A worktree-isolated writer agent implements the task.', title: 'Implement' },
    { detail: 'An adversarial read-only reviewer judges the diff.', title: 'Review' },
    {
      detail: 'Blocking findings go back to a fixer, then re-review (bounded).',
      title: 'Fix ⟲ Review',
    },
    { detail: 'Return the diff location and final verdict — no merge, no PR.', title: 'Hand back' },
  ],
  whenToUse:
    'Use to get an independent, adversarial review of a change before it becomes a PR — catching the defects a self-reviewing author misses.',
};

const task = typeof args === 'string' ? args : args?.task;
const maxRounds = Math.min(
  Math.max(Number((typeof args === 'object' && args?.maxRounds) || 2), 1),
  4,
);
const setupCommand = (typeof args === 'object' && args?.setupCommand) || '';

if (!task) {
  log('No task provided. Pass a description string or { task, ... }.');
  return { error: 'missing-task' };
}

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
let writer = await agent(
  `Implement this task in an isolated worktree, then commit it. ${setupNote}\n` +
    `Make the change cleanly — no shortcuts, no disabling checks. If the task's premise\n` +
    `conflicts with the code, STOP and report the conflict instead of guessing.\n` +
    `Do NOT open a PR and do NOT merge. Report the worktree path, the branch, and the\n` +
    `commit SHA(s).\n\nTASK:\n${task}`,
  { isolation: 'worktree', label: 'writer', phase: 'Implement' },
);

let review;
for (let round = 1; round <= maxRounds; round++) {
  phase(round === 1 ? 'Review' : `Fix ⟲ Review (round ${round})`);
  review = await agent(
    `Adversarially review the committed diff produced by the writer. Be skeptical:\n` +
      `look for correctness bugs, missed edge cases, broken contracts, and shortcuts.\n` +
      `Read-only — do not edit. Verdict 'approve' only if you'd merge it as-is.\n\n` +
      `Writer report:\n${writer}`,
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
  writer = await agent(
    `A reviewer raised these blocking findings on your diff. Address each in the SAME\n` +
      `isolated worktree and re-commit. Do not open a PR or merge.\n\n` +
      `Findings:\n${JSON.stringify(blocking, null, 2)}`,
    { isolation: 'worktree', label: 'fixer', phase: 'Fix' },
  );
}

phase('Hand back');
// No merge, no PR — a human opens the PR after reading this.
return { note: 'No PR opened and nothing merged — review, then open the PR yourself.', review, writerReport: writer };
