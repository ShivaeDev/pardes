import type { ExtensionAPI, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import type { WorkerRuntimeSnapshot } from '../../worker-runtime/index.ts';
import type { ManagerState } from '../domain.ts';
import {
  boundManagerGuidance,
  MANAGER_GUIDANCE_BOUNDS,
  type ManagerGuidanceReason,
} from './bounds.ts';
import { renderLifecycleGuidanceLines } from './lifecycle.ts';
import { projectManagerGuidance } from './projection.ts';

export {
  boundManagerGuidance,
  MANAGER_GUIDANCE_BOUNDS,
  MANAGER_GUIDANCE_MAX_CHARS,
  MANAGER_GUIDANCE_MAX_LINE_CHARS,
  MANAGER_GUIDANCE_MAX_LINES,
  type ManagerGuidanceBounds,
  type ManagerGuidanceReason,
} from './bounds.ts';
export {
  AUTONOMOUS_INBOX_PATH,
  INBOX_TWO_PATH_GUIDANCE,
  MANAGER_COMPACTION_COORDINATING_GUIDANCE,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
  USER_JUDGMENT_HANDOFF_PATH,
  USER_JUDGMENT_INBOX_PATH,
} from './wording.ts';

export const MANAGER_GUIDANCE_MESSAGE_TYPE = 'pardes-manager-guidance';

export function managerGuidanceReasonForSessionStart(
  reason: SessionStartEvent['reason'],
): Extract<ManagerGuidanceReason, 'restored' | 'reloaded'> {
  return reason === 'reload' ? 'reloaded' : 'restored';
}

/** Render one lifecycle-specific, hard-bounded operating reminder from durable state and ephemeral runtimes. */
export function renderManagerGuidance(
  state: ManagerState | undefined,
  reason: ManagerGuidanceReason,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot> = new Map(),
): string | undefined {
  if (!state) return undefined;
  return boundManagerGuidance(
    renderLifecycleGuidanceLines(projectManagerGuidance(state, runtimes), reason),
    MANAGER_GUIDANCE_BOUNDS[reason],
  );
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
