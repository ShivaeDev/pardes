// parallel-verify — fan out one worktree-isolated writer per DISJOINT partition,
// then INTEGRATE the partition branches and run a SINGLE serialized heavy
// verification on the combined result.
//
// Correctness hinge: the partitions must touch disjoint files. Two agents on the
// same file clobber each other — disjoint partitioning is the only thing
// preventing it, so the CALLER supplies the cut. We never invent partitions.
//
// Continuity gotcha: each worktree-isolated writer gets a FRESH worktree on its
// own branch — they don't share a working tree. So each writer reports its
// branch, and the verification step integrates by MERGING those branch refs
// (refs are shared across all worktrees of the repo) into one fresh worktree
// before verifying. A real merge conflict means the partitions weren't actually
// disjoint.
//
// Why one serialized verification, not one per agent in parallel: a heavy
// build/test run is memory-hungry, and running several at once can exhaust memory
// and take the machine down. So writers fan out, but the heavy verification runs
// exactly once, at integration, alone.
//
// HARD BOUNDARY: never merges to the base branch and never opens PRs. Returns
// per-partition results plus the single verification outcome for a human to act on.
//
// args: { partitions: [{ label, files, task }], base?, verifyCommand?, setupCommand? }.
//   - partitions    (required) DISJOINT units of work. `files` documents the cut
//                   so a reader can confirm no two partitions overlap.
//   - base          (optional) base ref the integration branch starts from.
//   - verifyCommand (optional) the heavy build/test command; safe no-op when
//                   unset (we log and skip verification rather than guess).
//   - setupCommand  (optional) one-shot bootstrap per worktree. No-op when unset.

export const meta = {
  description:
    'Fan out one worktree-isolated writer per DISJOINT work partition (supplied by the caller), then integrate the partition branches and run a SINGLE serialized heavy verification (one at a time — parallel heavy runs exhaust memory). Never merges to base or opens PRs.',
  name: 'parallel-verify',
  phases: [
    { detail: 'One worktree-isolated writer per disjoint partition.', title: 'Fan-out edit' },
    { detail: 'Merge the partition branches and run the heavy build/test once.', title: 'Integrate & verify' },
  ],
  whenToUse:
    'Use to parallelize several independent, file-disjoint changes and then verify them together exactly once, without risking memory exhaustion from concurrent heavy builds.',
};

const partitions =
  (typeof args === 'object' && Array.isArray(args?.partitions) && args.partitions) || [];
const base = (typeof args === 'object' && args?.base) || 'the default branch';
const verifyCommand = (typeof args === 'object' && args?.verifyCommand) || '';
const setupCommand = (typeof args === 'object' && args?.setupCommand) || '';

// Never fabricate partitions — the disjoint cut is the caller's correctness call.
if (!partitions.length) {
  log(
    'No partitions provided. Pass { partitions: [{ label, files, task }, ...] } with a DISJOINT file cut.',
  );
  return { error: 'missing-partitions' };
}

// Each writer reports its branch so the integration step can merge the refs.
const partitionSchema = {
  additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    label: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['branch', 'summary'],
  type: 'object',
};

const setupNote = setupCommand
  ? `First bootstrap the worktree by running: ${setupCommand}`
  : 'If the repo needs a bootstrap step (deps/codegen/local config), read its contributor docs and run it.';

phase('Fan-out edit');
// parallel() takes an array of thunks (() => agent(...)), not bare promises.
const results = await parallel(
  partitions.map(
    (p, i) => () =>
      agent(
        `Implement ONLY this partition in your own isolated worktree, then commit to your\n` +
          `branch. ${setupNote}\n` +
          `Stay strictly within the listed files — other agents own the rest in parallel,\n` +
          `so editing outside your partition will clobber their work. No shortcuts; if the\n` +
          `task conflicts with the code, STOP and report it. Do NOT open a PR or merge.\n` +
          `Report your branch name and a short summary.\n\n` +
          `PARTITION: ${p.label || `#${i + 1}`}\n` +
          `FILES (stay within these): ${JSON.stringify(p.files || [])}\n` +
          `TASK: ${p.task || '(none specified)'}`,
        {
          isolation: 'worktree',
          label: `writer-${p.label || i + 1}`,
          phase: 'Fan-out edit',
          schema: partitionSchema,
        },
      ),
  ),
);

const branches = results.map((r) => r?.branch).filter(Boolean);

// Serialized, single heavy verification — deliberately NOT inside parallel().
let verification;
phase('Integrate & verify');
if (!verifyCommand) {
  log('No verifyCommand provided — skipping the heavy verification step.');
  verification = { branches, reason: 'no-verify-command', skipped: true };
} else if (!branches.length) {
  log('No partition branches were reported — cannot integrate; skipping verification.');
  verification = { reason: 'no-branches', skipped: true };
} else {
  verification = await agent(
    `Integrate the parallel partitions and verify them together, EXACTLY ONCE. In your own\n` +
      `isolated worktree: \`git fetch\`, start a fresh integration branch off ${base}, then\n` +
      `merge each partition branch into it: ${branches.join(', ')}. Merging refs needs no\n` +
      `checkout of those branches. Resolve only trivial conflicts; a real conflict means the\n` +
      `partitions weren't disjoint — STOP and report it. Then run the heavy verification ONCE:\n` +
      `\`${verifyCommand}\`. This is the only heavy run — do not parallelize it. Report pass/fail\n` +
      `and tie any failure back to the likely partition. Do NOT merge to ${base} or open a PR.`,
    { isolation: 'worktree', label: 'verify', phase: 'Integrate & verify' },
  );
}

// No merge to base, no PR — a human integrates for real after reading these.
return {
  note: 'Nothing merged to the base branch and no PR opened — review the results, then integrate yourself.',
  partitions: results,
  verification,
};
