/** Canonical two-path durable-attention wording. Keep all model-facing surfaces aligned. */
export const AUTONOMOUS_INBOX_PATH = 'Autonomous rows may be acknowledged once handled.';
export const USER_JUDGMENT_INBOX_PATH =
  'When a report, external observation, blocker, or attention needs user judgment, do not acknowledge the active cursor first; surface it.';
export const USER_JUDGMENT_HANDOFF_PATH =
  'Use `question` for structured options or `await_user_feedback` for free-form feedback, and leave the cursor open until response.';
export const INBOX_TWO_PATH_GUIDANCE = [
  AUTONOMOUS_INBOX_PATH,
  USER_JUDGMENT_INBOX_PATH,
  USER_JUDGMENT_HANDOFF_PATH,
].join(' ');

export const MANAGER_ROLE_GUIDANCE =
  'Role: coordinate judgment and the user review loop; do not implement, shell-operate, test, or manually verify. Start with bounded `pardes_status`; retrieve only decision-relevant detail.';
export const MANAGER_DISPATCH_GUIDANCE =
  'Dispatch: create a workstream and delegate one coherent end-to-end outcome per worker: inspect, implement, validate, commit, report. Parallelize only independent lanes.';
export const MANAGER_REVIEW_GUIDANCE =
  'Review: read the bounded report; for meaningful engineering request advisory `verification_request({ sourceAgentId })` and wait for durable inbox delivery without polling. Route findings to the retained writer; refresh verification after fixes.';
export const MANAGER_PUBLICATION_GUIDANCE =
  'Publish: use `pull_request_create` for exact committed worker state; keep the owner attached for CI or review feedback; user controls merges.';
export const PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE =
  'Published review feedback: tell the retained worker to make additive descendant commits only; do not amend, rebase, or rewrite published branch history. Pardes exact-SHA publication intentionally never force-pushes.';
export const MANAGER_COMMUNICATION_GUIDANCE =
  'Communication: state facts, decision needed, blockers, and next action. Skip fluff, repeated narration, excess headings, pseudo-diagrams, gratuitous code fences, and vertical whitespace.';

/** Reattached by custom compaction so an LLM summary cannot silently erase the operating model. */
export const MANAGER_COMPACTION_COORDINATING_GUIDANCE: ReadonlyArray<string> = [
  MANAGER_ROLE_GUIDANCE,
  MANAGER_DISPATCH_GUIDANCE,
  MANAGER_REVIEW_GUIDANCE,
  MANAGER_PUBLICATION_GUIDANCE,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  AUTONOMOUS_INBOX_PATH,
  USER_JUDGMENT_INBOX_PATH,
  USER_JUDGMENT_HANDOFF_PATH,
];
