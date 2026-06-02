import type { WorkerRuntimeSnapshot, WorkerStatus } from '../../worker-runtime/index.ts';
import { effectiveAgentStatus, hasAgentWarning, pullRequestNeedsAttention } from '../attention.ts';
import type { ManagerState } from '../domain.ts';

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
  return [
    `State: streams ${workstreams.total} total (${workstreams.active} active/${workstreams.planned} planned/${workstreams.complete} complete); workers ${workers.total} total (${workers.attached} attached/${workers.detached} detached, ${workers.revivable} revivable).`,
    `Attention: ${workers.statuses.running} running/${workers.statuses.idle} idle; ${workers.warnings + reviews.warnings} warnings; inbox ${inbox}; ${reviews.open} open review gates (${reviews.draftOpen} draft).`,
  ];
}

export function operationalSnapshotLines(
  projection: ManagerGuidanceProjection,
): ReadonlyArray<string> {
  const { workstreams, workers, reviews, inbox } = projection;
  return [
    `State: streams ${workstreams.total} total; ${workstreams.active} active/${workstreams.planned} planned/${workstreams.complete} complete/${workstreams.cancelled} cancelled.`,
    `Workers: ${workers.total} total; ${workers.attached} attached/${workers.detached} detached/${workers.revivable} revivable; states ${workers.statuses.starting} starting/${workers.statuses.running} running/${workers.statuses.idle} idle/${workers.statuses.stopped} stopped/${workers.statuses.crashed} crashed; compacting ${workers.compacting}; queued ${workers.pendingMessages}.`,
    `Attention: ${workers.warnings} worker warnings; ${reviews.warnings} review warnings; inbox ${inbox}; ${reviews.open} open review gates (${reviews.draftOpen} draft).`,
  ];
}
