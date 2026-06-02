import type { ExtensionAPI, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import type { WorkerRuntimeSnapshot } from '../../worker-runtime/index.ts';
import type { ManagerState } from '../domain.ts';
import { type ManagerGuidanceReason, renderLifecycleGuidance } from './lifecycle.ts';
import { projectManagerGuidance } from './projection.ts';

export {
  AUTONOMOUS_INBOX_PATH,
  INBOX_TWO_PATH_GUIDANCE,
  MANAGER_COMPACTION_COORDINATING_GUIDANCE,
  MANAGER_LIFECYCLE_AUTHORED_GUIDANCE,
  type ManagerGuidanceReason,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from './lifecycle.ts';
export {
  boundedManagerGuidanceCount,
  MANAGER_GUIDANCE_DYNAMIC_COUNT_MAX,
} from './projection.ts';

export const MANAGER_GUIDANCE_MESSAGE_TYPE = 'pardes-manager-guidance';

export function managerGuidanceReasonForSessionStart(
  reason: SessionStartEvent['reason'],
): Extract<ManagerGuidanceReason, 'restored' | 'reloaded'> {
  return reason === 'reload' ? 'reloaded' : 'restored';
}

/** Render authored lifecycle guidance intact; append bounded count orientation except on specific reload. */
export function renderManagerGuidance(
  state: ManagerState | undefined,
  reason: ManagerGuidanceReason,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
): string | undefined {
  if (!state) return undefined;
  return renderLifecycleGuidance(projectManagerGuidance(state, runtimes), reason);
}

export function queueManagerGuidance(
  pi: Pick<ExtensionAPI, 'sendMessage'>,
  state: ManagerState | undefined,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
  reason: ManagerGuidanceReason,
): boolean {
  const content = renderManagerGuidance(state, reason, runtimes);
  if (!content) return false;
  pi.sendMessage(
    { content, customType: MANAGER_GUIDANCE_MESSAGE_TYPE, details: { reason }, display: true },
    { deliverAs: 'nextTurn' },
  );
  return true;
}
