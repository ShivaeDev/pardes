// parallel-verify — fan out one worktree-isolated writer per DISJOINT partition,
// then run a SINGLE serialized heavy verification at the end.
//
// Correctness hinge: the partitions must touch disjoint files. Two agents on the
// same file clobber each other — disjoint partitioning is the only thing
// preventing it, so the CALLER supplies the cut. We never invent partitions.
//
// Why one serialized verification, not one per agent in parallel: a heavy
// build/test run is memory-hungry, and running several at once can exhaust memory
// and take the machine down. So writers fan out (each isolated in its own
// worktree), but the heavy verification runs exactly once, at integration, alone.
//
// HARD BOUNDARY: never merges and never opens PRs. Returns per-partition results
// plus the single verification outcome for a human to act on.
//
// args: { partitions: [{ label, files, task }], verifyCommand?, setupCommand? }.
//   - partitions   (required) DISJOINT units of work. `files` documents the cut
//                  so a reader can confirm no two partitions overlap.
//   - verifyCommand (optional) the heavy build/test command; safe no-op when
//                  unset (we log and skip verification rather than guess).
//   - setupCommand (optional) one-shot bootstrap per worktree. No-op when unset.

export const meta = {
  description:
    'Fan out one worktree-isolated writer per DISJOINT work partition (supplied by the caller), then run a SINGLE serialized heavy verification at the end (one at a time — parallel heavy runs exhaust memory). Never merges or opens PRs.',
  name: 'parallel-verify',
  phases: [
    { detail: 'One worktree-isolated writer per disjoint partition.', title: 'Fan-out edit' },
    { detail: 'Run the heavy build/test exactly once, alone.', title: 'Serialized verify' },
  ],
  whenToUse:
    'Use to parallelize several independent, file-disjoint changes and then verify them together exactly once, without risking memory exhaustion from concurrent heavy builds.',
};

const partitions =
  (typeof args === 'object' && Array.isArray(args?.partitions) && args.partitions) || [];
const verifyCommand = (typeof args === 'object' && args?.verifyCommand) || '';
const setupCommand = (typeof args === 'object' && args?.setupCommand) || '';

// Never fabricate partitions — the disjoint cut is the caller's correctness call.
if (!partitions.length) {
  log(
    'No partitions provided. Pass { partitions: [{ label, files, task }, ...] } with a DISJOINT file cut.',
  );
  return { error: 'missing-partitions' };
}

const setupNote = setupCommand
  ? `First bootstrap the worktree by running: ${setupCommand}`
  : 'If the repo needs a bootstrap step (deps/codegen/local config), read its contributor docs and run it.';

phase('Fan-out edit');
// parallel() takes an array of thunks (() => agent(...)), not bare promises.
const results = await parallel(
  partitions.map(
    (p, i) => () =>
      agent(
        `Implement ONLY this partition in your own isolated worktree, then commit. ${setupNote}\n` +
          `Stay strictly within the listed files — other agents own the rest in parallel,\n` +
          `so editing outside your partition will clobber their work. No shortcuts; if the\n` +
          `task conflicts with the code, STOP and report it. Do NOT open a PR or merge.\n` +
          `Report the worktree path, branch, and commit SHA(s).\n\n` +
          `PARTITION: ${p.label || `#${i + 1}`}\n` +
          `FILES (stay within these): ${JSON.stringify(p.files || [])}\n` +
          `TASK: ${p.task || '(none specified)'}`,
        { isolation: 'worktree', label: `writer-${p.label || i + 1}`, phase: 'Fan-out edit' },
      ),
  ),
);

// Serialized, single heavy verification — deliberately NOT inside parallel().
let verification;
phase('Serialized verify');
if (!verifyCommand) {
  log('No verifyCommand provided — skipping the heavy verification step.');
  verification = { reason: 'no-verify-command', skipped: true };
} else {
  verification = await agent(
    `All parallel partitions are committed in their own worktrees. Run the heavy\n` +
      `verification EXACTLY ONCE against the integrated result: \`${verifyCommand}\`.\n` +
      `This is the only heavy run — do not parallelize it. Report pass/fail and any\n` +
      `failures, tied back to the partition that likely caused them. Do NOT merge or\n` +
      `open PRs.`,
    { isolation: 'worktree', label: 'verify', phase: 'Serialized verify' },
  );
}

// No merge, no PR — a human integrates after reading these.
return { note: 'Nothing merged and no PR opened — review the results, then integrate yourself.', partitions: results, verification };
