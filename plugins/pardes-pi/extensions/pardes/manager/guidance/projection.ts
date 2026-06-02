import type { WorkerRuntimeSnapshot, WorkerStatus } from '../../worker-runtime/index.ts';
import { effectiveAgentStatus, hasAgentWarning, pullRequestNeedsAttention } from '../attention.ts';
import type { ManagerState } from '../domain.ts';

/** Explicit bound for interpolated runtime/state counts; authored lifecycle guidance is never truncated. */
export const MANAGER_GUIDANCE_DYNAMIC_COUNT_MAX = 999_999_999;

export function boundedManagerGuidanceCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  const count = Math.floor(value);
  return count <= MANAGER_GUIDANCE_DYNAMIC_COUNT_MAX
    ? String(count)
    : `${MANAGER_GUIDANCE_DYNAMIC_COUNT_MAX}+`;
}

export interface ManagerGuidanceProjection {
  readonly workstreams: {
    readonly total: number;
    readonly active: number;
    readonly planned: number;
    readonly complete: number;
    readonly cancelled: number;
  };
  readonly workers: {
    readonly total: number;
    readonly attached: number;
    readonly detached: number;
    readonly revivable: number;
    readonly statuses: Readonly<Record<WorkerStatus, number>>;
    readonly compacting: number;
    readonly pendingMessages: number;
    readonly warnings: number;
  };
  readonly reviews: {
    readonly open: number;
    readonly draftOpen: number;
    readonly warnings: number;
  };
  readonly inbox: number;
}

export function projectManagerGuidance(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): ManagerGuidanceProjection {
  const workstreams = { active: 0, cancelled: 0, complete: 0, planned: 0, total: 0 };
  const statuses: Record<WorkerStatus, number> = {
    crashed: 0,
    idle: 0,
    running: 0,
    starting: 0,
    stopped: 0,
  };
  let attached = 0;
  let detached = 0;
  let revivable = 0;
  let compacting = 0;
  let pendingMessages = 0;
  let workerWarnings = 0;
  let openReviews = 0;
  let draftOpenReviews = 0;
  let reviewWarnings = 0;

  for (const workstream of Object.values(state.workstreams)) {
    workstreams.total += 1;
    workstreams[workstream.status] += 1;
  }
  for (const agent of Object.values(state.agents)) {
    const runtime = runtimes.get(agent.id);
    const status = effectiveAgentStatus(agent, runtime);
    statuses[status] += 1;
    if (runtime) {
      attached += 1;
      if (runtime.isCompacting) compacting += 1;
      pendingMessages += runtime.pendingMessageCount ?? 0;
    } else {
      detached += 1;
      if (agent.sessionFile) revivable += 1;
    }
    if (hasAgentWarning(agent, status)) workerWarnings += 1;
  }
  for (const pullRequest of Object.values(state.pullRequests)) {
    if (pullRequest.status === 'open') {
      openReviews += 1;
      if (pullRequest.draft === true) draftOpenReviews += 1;
    }
    if (pullRequestNeedsAttention(pullRequest)) reviewWarnings += 1;
  }

  return {
    inbox: state.inbox.length,
    reviews: { draftOpen: draftOpenReviews, open: openReviews, warnings: reviewWarnings },
    workers: {
      attached,
      compacting,
      detached,
      pendingMessages,
      revivable,
      statuses,
      total: Object.keys(state.agents).length,
      warnings: workerWarnings,
    },
    workstreams,
  };
}

export function currentSnapshotLines(projection: ManagerGuidanceProjection): ReadonlyArray<string> {
  const { workstreams, workers, reviews, inbox } = projection;
  const count = boundedManagerGuidanceCount;
  return [
    `State: streams ${count(workstreams.total)} total (${count(workstreams.active)} active/${count(workstreams.planned)} planned/${count(workstreams.complete)} complete); workers ${count(workers.total)} total (${count(workers.attached)} attached/${count(workers.detached)} detached, ${count(workers.revivable)} revivable).`,
    `Attention: ${count(workers.statuses.running)} running/${count(workers.statuses.idle)} idle; ${count(workers.warnings + reviews.warnings)} warnings; inbox ${count(inbox)}; ${count(reviews.open)} open review gates (${count(reviews.draftOpen)} draft).`,
  ];
}

export function operationalSnapshotLines(
  projection: ManagerGuidanceProjection,
): ReadonlyArray<string> {
  const { workstreams, workers, reviews, inbox } = projection;
  const count = boundedManagerGuidanceCount;
  return [
    `State: streams ${count(workstreams.total)} total; ${count(workstreams.active)} active/${count(workstreams.planned)} planned/${count(workstreams.complete)} complete/${count(workstreams.cancelled)} cancelled.`,
    `Workers: ${count(workers.total)} total; ${count(workers.attached)} attached/${count(workers.detached)} detached/${count(workers.revivable)} revivable; states ${count(workers.statuses.starting)} starting/${count(workers.statuses.running)} running/${count(workers.statuses.idle)} idle/${count(workers.statuses.stopped)} stopped/${count(workers.statuses.crashed)} crashed; compacting ${count(workers.compacting)}; queued ${count(workers.pendingMessages)}.`,
    `Attention: ${count(workers.warnings)} worker warnings; ${count(reviews.warnings)} review warnings; inbox ${count(inbox)}; ${count(reviews.open)} open review gates (${count(reviews.draftOpen)} draft).`,
  ];
}
