import { Semaphore } from 'effect';
import { createWorkerActivityState, type WorkerActivityState } from './activity.ts';
import type { ChildLaunchProfile } from './child-profile.ts';
import type { WorkerProtocolDiagnostic, WorkerStderrTail } from './diagnostics.ts';
import type { WorkerRpcState } from './rpc/codecs.ts';
import type { WorkerRpcSession } from './rpc/session.ts';

export type WorkerStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'crashed';
export type WorkerThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type WorkerSendBehavior = 'auto' | 'prompt' | 'steer' | 'followUp';
export type WorkerResolvedSendBehavior = Exclude<WorkerSendBehavior, 'auto'>;
export type WorkerQueueMode = 'all' | 'one-at-a-time';
export type WorkerCompactionReason = 'manual' | 'threshold' | 'overflow';

export interface WorkerSendResult {
  readonly requestedBehavior: WorkerSendBehavior;
  readonly deliveredAs: WorkerResolvedSendBehavior;
}

export interface WorkerCompactionCompletion {
  readonly reason: WorkerCompactionReason;
  readonly succeeded: boolean;
  readonly aborted: boolean;
  readonly willRetry: boolean;
  readonly tokensBefore?: number;
  readonly errorMessage?: string;
  readonly completedAt: number;
}

export interface WorkerSpawnInput {
  readonly agentId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly sessionFile?: string;
  readonly sessionName: string;
  readonly task: string;
  readonly model: string;
  readonly thinkingLevel: WorkerThinkingLevel;
  readonly workerExtensionPath?: string;
  readonly childProfile?: ChildLaunchProfile;
  /** Ephemeral launch ownership token used to reject delayed prior-generation events. */
  readonly lifecycleGeneration?: number;
}

export interface WorkerSessionStats {
  readonly totalMessages: number;
  readonly toolCalls: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}

export interface WorkerRuntimeSnapshot {
  readonly agentId: string;
  readonly status: WorkerStatus;
  readonly pid: number | undefined;
  readonly sessionFile: string | undefined;
  readonly stderr: WorkerStderrTail;
  readonly startedAt: number;
  readonly task: string;
  readonly model: string;
  readonly thinkingLevel: WorkerThinkingLevel;
  readonly stats: WorkerSessionStats | undefined;
  readonly sampledAt: number | undefined;
  readonly completedCompactionCount: number;
  /** Ephemeral launch ownership token; never persisted in manager state. */
  readonly lifecycleGeneration?: number;
  readonly totalActiveMs?: number;
  readonly currentAskElapsedMs?: number;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly autoCompactionEnabled?: boolean;
  readonly pendingMessageCount?: number;
  readonly steeringMode?: WorkerQueueMode;
  readonly followUpMode?: WorkerQueueMode;
  readonly steeringQueueCount?: number;
  readonly followUpQueueCount?: number;
  readonly compactionReason?: WorkerCompactionReason;
  readonly compactionStartedAt?: number;
  readonly lastCompaction?: WorkerCompactionCompletion;
  /** Ephemeral monitor preview. This projection is never persisted in manager state. */
  readonly recentActivityLines?: ReadonlyArray<string>;
}

export interface WorkerSupervisorEventOwnership {
  /** Ephemeral launch ownership token used to reject delayed prior-generation events. */
  readonly lifecycleGeneration?: number;
}

export type WorkerSupervisorEvent =
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'status';
      readonly agentId: string;
      readonly status: WorkerStatus;
      readonly sessionFile?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'telemetry';
      readonly agentId: string;
      readonly runtime: WorkerRuntimeSnapshot;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'compaction_completed';
      readonly agentId: string;
      readonly compaction: WorkerCompactionCompletion;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'report';
      readonly agentId: string;
      readonly status: 'progress' | 'completed' | 'blocked';
      readonly summary: string;
      readonly details?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'question';
      readonly agentId: string;
      readonly question: string;
      readonly context?: string;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'unexpected_exit';
      readonly agentId: string;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: WorkerStderrTail;
    })
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'protocol_error';
      readonly agentId: string;
      readonly diagnostic: WorkerProtocolDiagnostic;
      readonly message?: never;
    })
  /** Transitional adapter compatibility; production sessions emit the counted diagnostic variant. */
  | (WorkerSupervisorEventOwnership & {
      readonly type: 'protocol_error';
      readonly agentId: string;
      readonly diagnostic?: never;
      readonly message: string;
    });

/** Mutable state for one attached retained child conversation. */
export interface RetainedWorkerRuntime {
  readonly input: WorkerSpawnInput;
  readonly session: WorkerRpcSession;
  readonly deliverySemaphore: Semaphore.Semaphore;
  readonly startedAt: number;
  status: WorkerStatus;
  sessionFile: string | undefined;
  stats: WorkerSessionStats | undefined;
  sampledAt: number | undefined;
  completedCompactionCount: number;
  totalActiveMs: number;
  currentAskStartedAt: number | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  pendingMessageCount: number;
  steeringMode: WorkerQueueMode;
  followUpMode: WorkerQueueMode;
  steeringQueueCount: number | undefined;
  followUpQueueCount: number | undefined;
  compactionReason: WorkerCompactionReason | undefined;
  compactionStartedAt: number | undefined;
  lastCompaction: WorkerCompactionCompletion | undefined;
  activity: WorkerActivityState;
  assistantActivitySawDelta: boolean;
  assistantActivityCapturedText: boolean;
  expectedExit: boolean;
}

export function makeRetainedWorkerRuntime(
  input: WorkerSpawnInput,
  session: WorkerRpcSession,
  startedAt: number,
): RetainedWorkerRuntime {
  return {
    activity: createWorkerActivityState(),
    assistantActivityCapturedText: false,
    assistantActivitySawDelta: false,
    autoCompactionEnabled: false,
    compactionReason: undefined,
    compactionStartedAt: undefined,
    completedCompactionCount: 0,
    currentAskStartedAt: undefined,
    deliverySemaphore: Semaphore.makeUnsafe(1),
    expectedExit: false,
    followUpMode: 'one-at-a-time',
    followUpQueueCount: undefined,
    input,
    isCompacting: false,
    isStreaming: false,
    lastCompaction: undefined,
    pendingMessageCount: 0,
    sampledAt: undefined,
    session,
    sessionFile: undefined,
    startedAt,
    stats: undefined,
    status: 'starting',
    steeringMode: 'one-at-a-time',
    steeringQueueCount: undefined,
    totalActiveMs: 0,
  };
}

export function runtimeEventOwnership(
  runtime: RetainedWorkerRuntime,
): WorkerSupervisorEventOwnership {
  return runtime.input.lifecycleGeneration === undefined
    ? {}
    : { lifecycleGeneration: runtime.input.lifecycleGeneration };
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt);
}

export function snapshotRetainedWorkerRuntime(
  runtime: RetainedWorkerRuntime,
  now: number,
): WorkerRuntimeSnapshot {
  const currentAskElapsedMs =
    runtime.currentAskStartedAt === undefined
      ? undefined
      : elapsedMs(runtime.currentAskStartedAt, now);
  return {
    agentId: runtime.input.agentId,
    completedCompactionCount: runtime.completedCompactionCount,
    model: runtime.input.model,
    pid: runtime.session.pid,
    sampledAt: runtime.sampledAt,
    sessionFile: runtime.sessionFile,
    startedAt: runtime.startedAt,
    stats: runtime.stats,
    status: runtime.status,
    stderr: runtime.session.stderr(),
    task: runtime.input.task,
    thinkingLevel: runtime.input.thinkingLevel,
    ...(runtime.input.lifecycleGeneration === undefined
      ? {}
      : { lifecycleGeneration: runtime.input.lifecycleGeneration }),
    autoCompactionEnabled: runtime.autoCompactionEnabled,
    compactionReason: runtime.compactionReason,
    compactionStartedAt: runtime.compactionStartedAt,
    currentAskElapsedMs,
    followUpMode: runtime.followUpMode,
    followUpQueueCount: runtime.followUpQueueCount,
    isCompacting: runtime.isCompacting,
    isStreaming: runtime.isStreaming,
    lastCompaction: runtime.lastCompaction,
    pendingMessageCount: runtime.pendingMessageCount,
    recentActivityLines: [...runtime.activity.recentActivityLines],
    steeringMode: runtime.steeringMode,
    steeringQueueCount: runtime.steeringQueueCount,
    totalActiveMs: runtime.totalActiveMs + (currentAskElapsedMs ?? 0),
  };
}

export function transitionRetainedWorkerStatus(
  runtime: RetainedWorkerRuntime,
  status: WorkerStatus,
  transitionedAt: number,
  notify: (event: WorkerSupervisorEvent) => void,
): void {
  if (runtime.status === status) return;
  if (runtime.currentAskStartedAt !== undefined && status !== 'running') {
    runtime.totalActiveMs += elapsedMs(runtime.currentAskStartedAt, transitionedAt);
    runtime.currentAskStartedAt = undefined;
  }
  if (runtime.status !== 'running' && status === 'running')
    runtime.currentAskStartedAt = transitionedAt;
  runtime.status = status;
  notify({
    agentId: runtime.input.agentId,
    sessionFile: runtime.sessionFile,
    status,
    type: 'status',
    ...runtimeEventOwnership(runtime),
  });
}

export function reconcileRetainedWorkerRpcState(
  runtime: RetainedWorkerRuntime,
  state: WorkerRpcState,
  setStatus: (runtime: RetainedWorkerRuntime, status: WorkerStatus) => void,
): void {
  runtime.sessionFile = state.sessionFile ?? runtime.sessionFile;
  runtime.isStreaming = state.isStreaming;
  runtime.isCompacting = state.isCompacting;
  runtime.autoCompactionEnabled = state.autoCompactionEnabled;
  runtime.pendingMessageCount = state.pendingMessageCount;
  runtime.steeringMode = state.steeringMode;
  runtime.followUpMode = state.followUpMode;
  if (state.pendingMessageCount === 0) {
    runtime.steeringQueueCount = 0;
    runtime.followUpQueueCount = 0;
  } else if (
    (runtime.steeringQueueCount ?? 0) + (runtime.followUpQueueCount ?? 0) !==
    state.pendingMessageCount
  ) {
    runtime.steeringQueueCount = undefined;
    runtime.followUpQueueCount = undefined;
  }
  if (state.isStreaming) setStatus(runtime, 'running');
  else if (!state.isCompacting && runtime.status === 'running') setStatus(runtime, 'idle');
  if (!state.isCompacting) {
    runtime.compactionReason = undefined;
    runtime.compactionStartedAt = undefined;
  }
}

export function resetRetainedWorkerBusyState(runtime: RetainedWorkerRuntime): void {
  runtime.isStreaming = false;
  runtime.isCompacting = false;
  runtime.compactionReason = undefined;
  runtime.compactionStartedAt = undefined;
}

/** Mirror Pi's post-compaction RPC state until the next sampled assistant usage is available. */
export function recalibratingContextStats(
  stats: WorkerSessionStats | undefined,
): WorkerSessionStats | undefined {
  if (!stats?.contextUsage) return stats;
  return {
    ...stats,
    contextUsage: { ...stats.contextUsage, percent: null, tokens: null },
  };
}
