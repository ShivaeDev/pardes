import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { afterEach, describe, expect, test } from 'vitest';
import type { RepoState, WorktreeLease } from '../git/index.ts';
import { requiredValue } from '../test-support.ts';
import { type AgentRecord, initialManagerState } from './domain.ts';
import {
  isNamespaceSegment,
  type ManagerNamespaceContext,
  managedLeaseOwner,
  managerDirectory,
  stateRoot,
  validateManagerStateNamespace,
  validateRetainedAgentState,
} from './namespace.ts';

const temporaryDirectories: string[] = [];
const originalStateDir = process.env.PARDES_PI_STATE_DIR;

interface NamespaceFixture {
  readonly root: string;
  readonly context: ManagerNamespaceContext;
  readonly agent: AgentRecord;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
  if (originalStateDir === undefined) delete process.env.PARDES_PI_STATE_DIR;
  else process.env.PARDES_PI_STATE_DIR = originalStateDir;
});

function fixture(): NamespaceFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pardes-manager-namespace-')));
  temporaryDirectories.push(root);
  process.env.PARDES_PI_STATE_DIR = join(root, 'state-root');
  const managerId = 'manager-one';
  const agentId = 'agent-one';
  const repo: RepoState = {
    currentCheckout: join(root, 'repo'),
    gitCommonDir: join(root, 'repo', '.git'),
    key: 'repo-key',
    primaryCheckout: join(root, 'repo'),
  };
  const directory = managerDirectory(repo, managerId);
  const sessionDir = join(directory, 'sessions', agentId);
  const sessionFile = join(sessionDir, 'fixture.jsonl');
  const worktreePath = join(repo.primaryCheckout, '.worktrees', 'pardes', managerId, agentId);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(sessionFile, 'fixture session\n');
  const worktree: WorktreeLease = {
    agentId,
    branch: 'pardes/manager-/agent-one',
    branchPointSha: 'a'.repeat(40),
    createdAt: '2026-01-01T00:00:00.000Z',
    managerId,
    path: worktreePath,
  };
  return {
    agent: {
      createdAt: '2026-01-01T00:00:00.000Z',
      id: agentId,
      model: 'fixture/model',
      role: 'worker',
      sessionDir,
      sessionFile,
      status: 'stopped',
      task: 'Retain a validated worker session.',
      thinkingLevel: 'low',
      updatedAt: '2026-01-01T00:00:00.000Z',
      workstreamId: 'ws-one',
      worktree,
    },
    context: { managerId, repo, store: { directory } },
    root,
  };
}

describe('manager namespace', () => {
  test('constructs and validates one manager-scoped namespace', async () => {
    const { root, context } = fixture();
    const expectedStateRoot = join(root, 'state-root');
    const expectedDirectory = join(
      expectedStateRoot,
      'projects',
      context.repo.key,
      'managers',
      context.managerId,
    );

    expect(stateRoot()).toBe(expectedStateRoot);
    expect(managerDirectory(context.repo, context.managerId)).toBe(expectedDirectory);
    expect(isNamespaceSegment(context.managerId)).toBe(true);
    expect(isNamespaceSegment('manager/other')).toBe(false);
    expect(isNamespaceSegment('.')).toBe(false);
    expect(isNamespaceSegment('..')).toBe(false);
    expect(managedLeaseOwner(context, 'agent-one')).toEqual({
      agentId: 'agent-one',
      managerId: context.managerId,
      repo: context.repo,
    });
    await Effect.runPromise(
      validateManagerStateNamespace(context, initialManagerState(context.managerId, context.repo)),
    );
  });

  test('rejects mismatched manager, repository, and retained state-directory namespaces', async () => {
    const managerMismatch = fixture();
    const mismatchedManagerState = initialManagerState(
      'manager-other',
      managerMismatch.context.repo,
    );
    expect(
      await Effect.runPromise(
        validateManagerStateNamespace(managerMismatch.context, mismatchedManagerState).pipe(
          Effect.flip,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'manager namespace does not match its activation',
    });

    const repoMismatch = fixture();
    const mismatchedRepoState = initialManagerState(repoMismatch.context.managerId, {
      ...repoMismatch.context.repo,
      gitCommonDir: join(repoMismatch.root, 'other.git'),
    });
    expect(
      await Effect.runPromise(
        validateManagerStateNamespace(repoMismatch.context, mismatchedRepoState).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'repository namespace does not match its activation',
    });

    const intentMismatch = fixture();
    const mismatchedIntentState = {
      ...initialManagerState(intentMismatch.context.managerId, intentMismatch.context.repo),
      workstreamCompletionIntents: {
        'ws-key': {
          pendingAgents: [{ agentId: 'agent-one', lifecycleGeneration: 1, reportId: 'report-one' }],
          requestedAt: '2026-01-01T00:00:00.000Z',
          workstreamId: 'ws-other',
        },
      },
    };
    expect(
      await Effect.runPromise(
        validateManagerStateNamespace(intentMismatch.context, mismatchedIntentState).pipe(
          Effect.flip,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'workstream completion intent namespace does not match its owner',
    });

    const stateDirectoryMismatch = fixture();
    const mismatchedContext = {
      ...stateDirectoryMismatch.context,
      store: { directory: join(stateDirectoryMismatch.root, 'other-manager-state') },
    };
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(
          mismatchedContext,
          stateDirectoryMismatch.agent.id,
          stateDirectoryMismatch.agent,
        ).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session directory does not match its managed namespace',
    });
  });

  test('rejects traversal retained agent namespaces before lease delegation or session path derivation', async () => {
    for (const agentId of ['.', '..']) {
      const leaseFixture = fixture();
      let worktreeAccesses = 0;
      const guardedLeaseAgent: AgentRecord = {
        ...leaseFixture.agent,
        id: agentId,
        get worktree() {
          worktreeAccesses += 1;
          return leaseFixture.agent.worktree;
        },
      };

      expect(
        await Effect.runPromise(
          validateRetainedAgentState(leaseFixture.context, agentId, guardedLeaseAgent).pipe(
            Effect.flip,
          ),
        ),
      ).toMatchObject({ _tag: 'InvalidManagedStateError', reason: 'agent namespace is invalid' });
      expect(worktreeAccesses).toBe(0);

      const pathFixture = fixture();
      let storeDirectoryAccesses = 0;
      const guardedPathContext: ManagerNamespaceContext = {
        ...pathFixture.context,
        store: {
          get directory() {
            storeDirectoryAccesses += 1;
            return pathFixture.context.store.directory;
          },
        },
      };

      expect(
        await Effect.runPromise(
          validateRetainedAgentState(guardedPathContext, agentId, {
            ...pathFixture.agent,
            id: agentId,
            worktree: undefined,
          }).pipe(Effect.flip),
        ),
      ).toMatchObject({ _tag: 'InvalidManagedStateError', reason: 'agent namespace is invalid' });
      expect(storeDirectoryAccesses).toBe(0);
    }
  });

  test('rejects redirected retained session state directories', async () => {
    const { root, context, agent } = fixture();
    const redirectedDirectory = join(root, 'redirected-session-state');
    mkdirSync(redirectedDirectory);
    writeFileSync(join(redirectedDirectory, 'fixture.jsonl'), 'redirected session\n');
    rmSync(agent.sessionDir, { recursive: true });
    symlinkSync(redirectedDirectory, agent.sessionDir, 'dir');

    expect(
      await Effect.runPromise(
        validateRetainedAgentState(context, agent.id, agent).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session directory is redirected',
    });
  });

  test('rejects retained record, lease, and session namespace mismatches', async () => {
    const recordMismatch = fixture();
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(
          recordMismatch.context,
          'agent-other',
          recordMismatch.agent,
        ).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent record namespace does not match its owner',
    });

    const leaseMismatch = fixture();
    const mismatchedLeaseAgent = {
      ...leaseMismatch.agent,
      worktree: { ...requiredValue(leaseMismatch.agent.worktree), managerId: 'manager-other' },
    };
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(
          leaseMismatch.context,
          leaseMismatch.agent.id,
          mismatchedLeaseAgent,
        ).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedLeaseError',
      reason: 'manager namespace does not match its owner',
    });

    const sessionMismatch = fixture();
    const mismatchedSessionAgent = {
      ...sessionMismatch.agent,
      sessionFile: join(sessionMismatch.agent.sessionDir, 'nested', 'fixture.jsonl'),
    };
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(
          sessionMismatch.context,
          sessionMismatch.agent.id,
          mismatchedSessionAgent,
        ).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session file is not a direct managed JSONL session file',
    });
  });

  test('rejects symlinked, non-direct, non-JSONL, and missing retained session files', async () => {
    const symlinked = fixture();
    const redirectedFile = join(symlinked.root, 'redirected-session.jsonl');
    writeFileSync(redirectedFile, 'redirected session\n');
    rmSync(requiredValue(symlinked.agent.sessionFile));
    symlinkSync(redirectedFile, requiredValue(symlinked.agent.sessionFile));
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(symlinked.context, symlinked.agent.id, symlinked.agent).pipe(
          Effect.flip,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session file is redirected',
    });

    const nonDirect = fixture();
    const nestedDirectory = join(nonDirect.agent.sessionDir, 'nested');
    mkdirSync(nestedDirectory);
    const nestedFile = join(nestedDirectory, 'fixture.jsonl');
    writeFileSync(nestedFile, 'nested session\n');
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(nonDirect.context, nonDirect.agent.id, {
          ...nonDirect.agent,
          sessionFile: nestedFile,
        }).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session file is not a direct managed JSONL session file',
    });

    const nonJsonl = fixture();
    const textFile = join(nonJsonl.agent.sessionDir, 'fixture.txt');
    writeFileSync(textFile, 'text session\n');
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(nonJsonl.context, nonJsonl.agent.id, {
          ...nonJsonl.agent,
          sessionFile: textFile,
        }).pipe(Effect.flip),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session file is not a direct managed JSONL session file',
    });

    const missing = fixture();
    rmSync(requiredValue(missing.agent.sessionFile));
    expect(
      await Effect.runPromise(
        validateRetainedAgentState(missing.context, missing.agent.id, missing.agent).pipe(
          Effect.flip,
        ),
      ),
    ).toMatchObject({
      _tag: 'InvalidManagedStateError',
      reason: 'agent session file cannot be verified',
    });
  });

  test('accepts valid retained state and transitional state without a persisted session file', async () => {
    const retained = fixture();
    await Effect.runPromise(
      validateRetainedAgentState(retained.context, retained.agent.id, retained.agent),
    );

    const transitional = fixture();
    const { sessionFile: _sessionFile, ...withoutSessionFile } = transitional.agent;
    await Effect.runPromise(
      validateRetainedAgentState(transitional.context, transitional.agent.id, withoutSessionFile),
    );
  });
});
