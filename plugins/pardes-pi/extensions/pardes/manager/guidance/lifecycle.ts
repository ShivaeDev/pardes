import type { ManagerGuidanceReason } from './bounds.ts';
import {
  currentSnapshotLines,
  type ManagerGuidanceProjection,
  operationalSnapshotLines,
} from './projection.ts';
import {
  AUTONOMOUS_INBOX_PATH,
  MANAGER_COMMUNICATION_GUIDANCE,
  MANAGER_DISPATCH_GUIDANCE,
  MANAGER_PUBLICATION_GUIDANCE,
  MANAGER_REVIEW_GUIDANCE,
  MANAGER_ROLE_GUIDANCE,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from './wording.ts';

function guidanceLines(text: string): ReadonlyArray<string> {
  return text.trim().split('\n');
}

function renderActivatedGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager activated. This is a coordination control plane; software owns deterministic mechanics and you own engineering judgment.
${MANAGER_ROLE_GUIDANCE}
${MANAGER_DISPATCH_GUIDANCE}
${MANAGER_REVIEW_GUIDANCE}
${MANAGER_PUBLICATION_GUIDANCE}
${PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE}
Inbox: inspect \`pardes_status(view="inbox")\`; use \`inbox_get({ eventId })\` only for a known row. ${AUTONOMOUS_INBOX_PATH}
${USER_JUDGMENT_INBOX_PATH}
${USER_JUDGMENT_HANDOFF_PATH}
${MANAGER_COMMUNICATION_GUIDANCE}
${currentSnapshotLines(projection).join('\n')}
`);
}

function renderRestoredGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager restored. Persisted state is authoritative; process-scoped child runtimes do not survive a prior manager process, so attachment is not assumed.
Next: inspect bounded \`pardes_status\`, then \`pardes_status(view="inbox")\`; account for open review gates and revive only detached retained conversations that should continue. Use \`pardes_status(view="cleanup")\` only for explicit resolved-artifact guidance.
${MANAGER_ROLE_GUIDANCE}
Workflow: delegate coherent worker outcomes; read bounded reports; request advisory verification for meaningful engineering; wait for durable delivery without polling; publish exact committed worker state only through \`pull_request_create\`; user controls merges.
${PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE}
Inbox path 1: ${AUTONOMOUS_INBOX_PATH}
Inbox path 2: ${USER_JUDGMENT_INBOX_PATH}
${USER_JUDGMENT_HANDOFF_PATH}
${MANAGER_COMMUNICATION_GUIDANCE}
${currentSnapshotLines(projection).join('\n')}
`);
}

function renderReloadedGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes plugin reloaded. The manager intentionally rebound to loaded plugin code and refreshed its pinned child-runtime snapshot.
Fact: former child RPC attachments disconnected; managed worktrees and retained conversations were preserved. Next: inspect bounded \`pardes_status\` and \`pardes_status(view="inbox")\`; account for open review gates; revive selectively.
${MANAGER_ROLE_GUIDANCE}
Workflow: delegate coherent worker outcomes; retrieve bounded reports; use advisory verification for meaningful engineering; publish exact committed worker state only through \`pull_request_create\`; user controls merges.
${PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE}
Inbox path 1: ${AUTONOMOUS_INBOX_PATH}
Inbox path 2: ${USER_JUDGMENT_INBOX_PATH}
${USER_JUDGMENT_HANDOFF_PATH}
${currentSnapshotLines(projection).join('\n')}
`);
}

function renderCompactedGuidance(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  return guidanceLines(`
Pardes manager compacted. Persisted state and the coordinating suffix are authoritative; deliberately re-establish the operating model before lifecycle actions.
Next: inspect bounded \`pardes_status\`, then \`pardes_status(view="inbox")\`; keep open-review owners attached for CI or review feedback. Use \`pardes_status(view="cleanup")\` only for explicit resolved-artifact guidance.
${MANAGER_ROLE_GUIDANCE}
${MANAGER_DISPATCH_GUIDANCE}
Review: read bounded reports; for meaningful engineering request advisory verification, wait for durable delivery without polling, route findings to the retained writer, refresh after fixes, and publish exact committed worker state only through \`pull_request_create\`; user controls merges.
${PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE}
Inbox path 1: ${AUTONOMOUS_INBOX_PATH}
Inbox path 2: ${USER_JUDGMENT_INBOX_PATH}
${USER_JUDGMENT_HANDOFF_PATH}
${MANAGER_COMMUNICATION_GUIDANCE}
${operationalSnapshotLines(projection).join('\n')}
`);
}

const renderers: Readonly<
  Record<ManagerGuidanceReason, (projection: ManagerGuidanceProjection) => ReadonlyArray<string>>
> = {
  activated: renderActivatedGuidance,
  compacted: renderCompactedGuidance,
  reloaded: renderReloadedGuidance,
  restored: renderRestoredGuidance,
};

export function renderLifecycleGuidanceLines(
  projection: ManagerGuidanceProjection,
  reason: ManagerGuidanceReason,
): ReadonlyArray<string> {
  return renderers[reason](projection);
}
