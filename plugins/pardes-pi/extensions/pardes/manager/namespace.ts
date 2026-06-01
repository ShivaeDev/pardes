import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { Effect } from 'effect';
import {
  type ManagedLeaseOwner,
  type RepoState,
  validateManagedWorktreeLease,
} from '../git/index.ts';
import type { AgentRecord, ManagerState } from './domain.ts';
import { InvalidManagedStateError } from './errors.ts';

const SAFE_NAMESPACE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export interface ManagerNamespaceContext {
  readonly store: { readonly directory: string };
  readonly managerId: string;
  readonly repo: RepoState;
}

export function stateRoot(): string {
  return process.env.PARDES_PI_STATE_DIR || join(homedir(), '.pi', 'agent', 'pardes');
}

export function managerDirectory(repo: RepoState, managerId: string): string {
  return join(stateRoot(), 'projects', repo.key, 'managers', managerId);
}

export function isNamespaceSegment(value: string): boolean {
  return value !== '.' && value !== '..' && SAFE_NAMESPACE_SEGMENT.test(value);
}

function invalidManagedState(reason: string): InvalidManagedStateError {
  return new InvalidManagedStateError({ reason });
}

export const validateManagerStateNamespace = Effect.fnUntraced(function* (
  namespace: ManagerNamespaceContext,
  state: ManagerState,
) {
  if (!isNamespaceSegment(namespace.managerId))
    return yield* invalidManagedState('manager namespace is invalid');
  if (state.managerId !== namespace.managerId)
    return yield* invalidManagedState('manager namespace does not match its activation');
  if (
    state.repo.key !== namespace.repo.key ||
    state.repo.primaryCheckout !== namespace.repo.primaryCheckout ||
    state.repo.gitCommonDir !== namespace.repo.gitCommonDir
  ) {
    return yield* invalidManagedState('repository namespace does not match its activation');
  }
});

export function managedLeaseOwner(
  namespace: ManagerNamespaceContext,
  agentId: string,
): ManagedLeaseOwner {
  return { agentId, managerId: namespace.managerId, repo: namespace.repo };
}

export function verifyRetainedPath<A>(
  run: () => PromiseLike<A>,
  reason: string,
): Effect.Effect<A, InvalidManagedStateError> {
  return Effect.tryPromise({ catch: () => invalidManagedState(reason), try: run });
}

export const validateRetainedAgentState = Effect.fnUntraced(function* (
  namespace: ManagerNamespaceContext,
  expectedAgentId: string,
  agent: AgentRecord,
) {
  if (agent.id !== expectedAgentId)
    return yield* invalidManagedState('agent record namespace does not match its owner');
  if (!isNamespaceSegment(expectedAgentId))
    return yield* invalidManagedState('agent namespace is invalid');
  if (agent.worktree)
    yield* validateManagedWorktreeLease(
      managedLeaseOwner(namespace, expectedAgentId),
      agent.worktree,
    );
  const expectedSessionDir = join(namespace.store.directory, 'sessions', expectedAgentId);
  if (agent.sessionDir !== expectedSessionDir)
    return yield* invalidManagedState(
      'agent session directory does not match its managed namespace',
    );
  if (!agent.sessionFile) return;
  const sessionFile = agent.sessionFile;
  if (
    dirname(sessionFile) !== expectedSessionDir ||
    extname(sessionFile) !== '.jsonl' ||
    basename(sessionFile) === '.jsonl'
  ) {
    return yield* invalidManagedState(
      'agent session file is not a direct managed JSONL session file',
    );
  }
  const physicalStoreDirectory = yield* verifyRetainedPath(
    () => realpath(namespace.store.directory),
    'manager session root cannot be verified',
  );
  const sessionDirectoryStats = yield* verifyRetainedPath(
    () => lstat(agent.sessionDir),
    'agent session directory cannot be verified',
  );
  if (!sessionDirectoryStats.isDirectory() || sessionDirectoryStats.isSymbolicLink()) {
    return yield* invalidManagedState('agent session directory is redirected');
  }
  const physicalSessionDir = yield* verifyRetainedPath(
    () => realpath(agent.sessionDir),
    'agent session directory cannot be verified',
  );
  if (physicalSessionDir !== join(physicalStoreDirectory, 'sessions', expectedAgentId)) {
    return yield* invalidManagedState('agent session directory is redirected');
  }
  const sessionFileStats = yield* verifyRetainedPath(
    () => lstat(sessionFile),
    'agent session file cannot be verified',
  );
  if (!sessionFileStats.isFile() || sessionFileStats.isSymbolicLink())
    return yield* invalidManagedState('agent session file is redirected');
  const physicalSessionFile = yield* verifyRetainedPath(
    () => realpath(sessionFile),
    'agent session file cannot be verified',
  );
  if (physicalSessionFile !== join(physicalSessionDir, basename(sessionFile))) {
    return yield* invalidManagedState('agent session file is redirected');
  }
});
