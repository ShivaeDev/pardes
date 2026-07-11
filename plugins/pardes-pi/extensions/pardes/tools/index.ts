import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ManagerController } from '../manager/index.ts';
import { registerAgentDomainTools } from './agents.ts';
import {
  registerInboxAcknowledgeTool,
  registerInboxGetTool,
  registerPardesStatusTool,
} from './control-plane.ts';
import { registerHostedDrilldownTools } from './hosted-drilldown.ts';
import { registerPullRequestTools } from './pull-requests.ts';
import { registerReportTools } from './reports.ts';
import { registerVerificationTools } from './verifications.ts';
import { registerWorkstreamDomainTools } from './workstreams.ts';

export { registerHostedDrilldownTools } from './hosted-drilldown.ts';
export { conciseAgentStatus } from './projections/agents.ts';
export { RESOLVED_WORK_CLEANUP_DEFAULT_ROWS } from './projections/cleanup.ts';
export {
  CONTROL_PLANE_DEFAULT_ROWS,
  CONTROL_PLANE_MAX_ROWS,
  CONTROL_PLANE_MAX_TEXT_LENGTH,
} from './projections/core.ts';
export {
  INBOX_EVENT_CHILD_TRUST_LABEL,
  INBOX_EVENT_DETAIL_RENDER_MAX_CHARS,
  INBOX_EVENT_DETAIL_SUMMARY_MAX_CHARS,
  INBOX_EVENT_EXTERNAL_FEEDBACK_TRUST_LABEL,
  INBOX_EVENT_EXTERNAL_METADATA_TRUST_LABEL,
  INBOX_EVENT_VERIFIER_TRUST_LABEL,
} from './projections/inbox.ts';
export {
  COMPOSITION_MAX_CLUSTERS,
  COMPOSITION_MAX_GATES_PER_CLUSTER,
  COMPOSITION_MAX_PATHS_PER_ROW,
  COMPOSITION_MAX_UNCERTAIN_GATES,
} from './projections/reviews.ts';
export { registerQuestionTool } from './question.ts';
export { registerPullRequestTools };

export function registerWorkstreamTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesStatusTool(pi, manager);
  registerWorkstreamDomainTools(pi, manager);
  registerReportTools(pi, manager);
  registerInboxGetTool(pi, manager);
  registerInboxAcknowledgeTool(pi, manager);
}

export function registerAgentTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPullRequestTools(pi, manager);
  registerHostedDrilldownTools(pi, manager);
  registerVerificationTools(pi, manager);
  registerAgentDomainTools(pi, manager);
}
