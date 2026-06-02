import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Effect } from 'effect';
import type { ManagedWorktreeShape } from '../git/index.ts';
import type { StateStoreShape } from '../storage/index.ts';
import type {
  GuardedWorkerSupervisorShape,
  WorkerRuntimeSnapshot,
  WorkerThinkingLevel,
} from '../worker-runtime/index.ts';
import type { ManagerEvent, ManagerState } from './domain.ts';
import type { ManagerNamespaceContext } from './namespace.ts';

export interface VerificationRequestInput {
  readonly sourceAgentId: string;
  readonly task?: string;
  readonly model?: string;
  readonly thinkingLevel?: WorkerThinkingLevel;
}

export interface VerificationLifecycleNamespace extends ManagerNamespaceContext {
  readonly store: StateStoreShape;
  state: ManagerState;
}

export interface VerificationLifecycleCallbacks {
  readonly refresh: (ctx?: ExtensionContext) => Effect.Effect<void, unknown>;
  readonly appendEventSafely: (event: ManagerEvent) => Effect.Effect<void>;
  readonly releaseInboxWake: () => Effect.Effect<boolean, unknown>;
  readonly defaultModel: (ctx?: ExtensionContext) => string | undefined;
  readonly defaultThinkingLevel: () => WorkerThinkingLevel;
  readonly requirePinnedWorkerExtensionPath: () => Effect.Effect<string, unknown>;
  readonly recordRuntime: (agentId: string, runtime: WorkerRuntimeSnapshot) => void;
  readonly forgetRuntime: (agentId: string) => void;
  readonly suppressWorkerEvents: (agentId: string) => void;
  readonly resumeWorkerEvents: (agentId: string) => void;
}

export interface VerificationLifecycleCoordinatorOptions {
  readonly namespace: VerificationLifecycleNamespace;
  readonly worktrees: ManagedWorktreeShape;
  readonly workers: GuardedWorkerSupervisorShape;
  readonly callbacks: VerificationLifecycleCallbacks;
}
