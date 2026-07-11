import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect, Schema } from 'effect';
import { FeedbackNotFoundError, FeedbackStoreError } from './errors.ts';
import {
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_TEXT_MAX_BYTES,
  type FeedbackEntry,
  type FeedbackFilter,
  type FeedbackProvenance,
  type FeedbackSubmission,
  FeedbackSubmissionSchema,
  type FeedbackTriage,
  FeedbackTriageSchema,
  type FeedbackWatchInitialization,
  FeedbackWatchInitializationSchema,
  matchesFeedbackFilter,
} from './schemas.ts';

const FEEDBACK_ID_PATTERN = /^feedback-[a-f0-9-]+$/;
const CURSOR_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const FEEDBACK_ARTIFACT_MAX_BYTES = FEEDBACK_TEXT_MAX_BYTES + 16 * 1_024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_IMMUTABLE_FILE_MODE = 0o400;
const WATCH_LOCK_RECOVERY_GRACE_MS = 5_000;

export interface FeedbackRegistryPaths {
  readonly directory: string;
  readonly submissions: string;
  readonly triage: string;
  readonly watchCursors: string;
}

export function pardesGlobalStateRoot(): string {
  return process.env.PARDES_PI_STATE_DIR || join(homedir(), '.pi', 'agent', 'pardes');
}

export function feedbackRegistryPaths(root = pardesGlobalStateRoot()): FeedbackRegistryPaths {
  const directory = join(root, 'feedback');
  return {
    directory,
    submissions: join(directory, 'submissions'),
    triage: join(directory, 'triage'),
    watchCursors: join(directory, 'watch-cursors'),
  };
}

function storeError(operation: string, cause: unknown): FeedbackStoreError {
  return new FeedbackStoreError({ cause, operation });
}

function effectPromise<A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, FeedbackStoreError> {
  return Effect.tryPromise({ catch: (cause) => storeError(operation, cause), try: run });
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateAndTightenPrivateDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('feedback registry directory is redirected');
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE, recursive });
  } catch (error) {
    if (!isCode(error, 'EEXIST')) throw error;
  }
  await validateAndTightenPrivateDirectory(path);
}

async function tightenJsonArtifacts(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error('feedback registry artifact is redirected');
    await chmod(join(directory, entry.name), PRIVATE_IMMUTABLE_FILE_MODE);
  }
}

async function ensureDirectories(paths: FeedbackRegistryPaths): Promise<void> {
  await ensurePrivateDirectory(paths.directory, true);
  await ensurePrivateDirectory(paths.submissions);
  await ensurePrivateDirectory(paths.triage);
  await ensurePrivateDirectory(paths.watchCursors);
  await tightenJsonArtifacts(paths.submissions);
  await tightenJsonArtifacts(paths.triage);
  for (const entry of await readdir(paths.watchCursors, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error('feedback watch cursor directory is redirected');
    const cursorDirectory = join(paths.watchCursors, entry.name);
    await validateAndTightenPrivateDirectory(cursorDirectory);
    await tightenJsonArtifacts(cursorDirectory);
  }
}

async function ensureCursorDirectory(
  paths: FeedbackRegistryPaths,
  cursor: string,
): Promise<string> {
  if (!CURSOR_PATTERN.test(cursor)) throw new Error('invalid watch cursor');
  await ensureDirectories(paths);
  const cursorDirectory = join(paths.watchCursors, cursor);
  await ensurePrivateDirectory(cursorDirectory);
  return cursorDirectory;
}

/** Create one immutable, atomically visible artifact without ever replacing an existing target. */
async function createImmutableArtifact(path: string, source: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', PRIVATE_IMMUTABLE_FILE_MODE);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if (isCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

function validFeedbackId(feedbackId: string): boolean {
  return FEEDBACK_ID_PATTERN.test(feedbackId) && basename(feedbackId) === feedbackId;
}

async function readDecoded<A>(
  path: string,
  schema: Schema.Codec<A, unknown, never, never>,
): Promise<A> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('feedback artifact is redirected');
  if (stats.size > FEEDBACK_ARTIFACT_MAX_BYTES) throw new Error('feedback artifact is oversized');
  const source = await readFile(path, 'utf8');
  const parsed = JSON.parse(source) as unknown;
  return Effect.runPromise(
    Schema.decodeUnknownEffect(schema, { errors: 'all', onExcessProperty: 'error' })(parsed),
  );
}

async function readTriageIfPresent(paths: FeedbackRegistryPaths, feedbackId: string) {
  try {
    return await readDecoded(join(paths.triage, `${feedbackId}.json`), FeedbackTriageSchema);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export function submitFeedback(
  text: string,
  provenance: FeedbackProvenance,
  root = pardesGlobalStateRoot(),
): Effect.Effect<FeedbackSubmission, FeedbackStoreError> {
  return effectPromise('submit feedback', async () => {
    if (text.length === 0) throw new Error('feedback text is required');
    if (Buffer.byteLength(text, 'utf8') > FEEDBACK_TEXT_MAX_BYTES)
      throw new Error(`feedback text exceeds ${FEEDBACK_TEXT_MAX_BYTES} bytes`);
    const paths = feedbackRegistryPaths(root);
    await ensureDirectories(paths);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const submission: FeedbackSubmission = {
        createdAt: new Date().toISOString(),
        id: `feedback-${randomUUID()}`,
        provenance,
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        text,
      };
      const encoded = await Effect.runPromise(
        Schema.encodeEffect(FeedbackSubmissionSchema)(submission),
      );
      const source = `${JSON.stringify(encoded, null, 2)}\n`;
      if (await createImmutableArtifact(join(paths.submissions, `${submission.id}.json`), source))
        return submission;
    }
    throw new Error('could not allocate a unique feedback id');
  });
}

export function getFeedback(
  feedbackId: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<FeedbackEntry, FeedbackStoreError | FeedbackNotFoundError> {
  if (!validFeedbackId(feedbackId)) return Effect.fail(new FeedbackNotFoundError({ feedbackId }));
  const paths = feedbackRegistryPaths(root);
  return Effect.tryPromise({
    catch: (cause) =>
      isCode(cause, 'ENOENT')
        ? new FeedbackNotFoundError({ feedbackId })
        : storeError('read feedback', cause),
    try: async () => {
      await ensureDirectories(paths);
      const submission = await readDecoded(
        join(paths.submissions, `${feedbackId}.json`),
        FeedbackSubmissionSchema,
      );
      const triage = await readTriageIfPresent(paths, feedbackId);
      return { submission, ...(triage === undefined ? {} : { triage }) };
    },
  });
}

export function listFeedback(
  filter: FeedbackFilter = {},
  root = pardesGlobalStateRoot(),
): Effect.Effect<ReadonlyArray<FeedbackEntry>, FeedbackStoreError> {
  return effectPromise('list feedback', async () => {
    const paths = feedbackRegistryPaths(root);
    await ensureDirectories(paths);
    const names: string[] = [];
    for (const entry of await readdir(paths.submissions, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error('feedback submission artifact is redirected');
      names.push(entry.name);
    }
    names.sort();
    const entries: FeedbackEntry[] = [];
    for (const name of names) {
      const feedbackId = name.slice(0, -'.json'.length);
      if (!validFeedbackId(feedbackId)) continue;
      const submission = await readDecoded(join(paths.submissions, name), FeedbackSubmissionSchema);
      const triage = await readTriageIfPresent(paths, feedbackId);
      const entry = { submission, ...(triage === undefined ? {} : { triage }) };
      if (matchesFeedbackFilter(entry, filter)) entries.push(entry);
    }
    return entries.sort(
      (left, right) =>
        left.submission.createdAt.localeCompare(right.submission.createdAt) ||
        left.submission.id.localeCompare(right.submission.id),
    );
  });
}

export function markFeedbackAddressed(
  feedbackId: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<FeedbackTriage, FeedbackStoreError | FeedbackNotFoundError> {
  return getFeedback(feedbackId, root).pipe(
    Effect.flatMap((entry) => {
      if (entry.triage) return Effect.succeed(entry.triage);
      return effectPromise('mark feedback addressed', async () => {
        const paths = feedbackRegistryPaths(root);
        await ensureDirectories(paths);
        const triage: FeedbackTriage = {
          addressedAt: new Date().toISOString(),
          feedbackId,
          schemaVersion: FEEDBACK_SCHEMA_VERSION,
          status: 'addressed',
        };
        const encoded = await Effect.runPromise(Schema.encodeEffect(FeedbackTriageSchema)(triage));
        const path = join(paths.triage, `${feedbackId}.json`);
        const created = await createImmutableArtifact(
          path,
          `${JSON.stringify(encoded, null, 2)}\n`,
        );
        return created ? triage : readDecoded(path, FeedbackTriageSchema);
      });
    }),
  );
}

interface WatchLockRecord {
  readonly createdAt: string;
  readonly ownerFile?: string;
  readonly pid: number;
  readonly token: string;
}

export interface FeedbackWatchLock {
  readonly release: () => Effect.Effect<void, FeedbackStoreError>;
}

function watchLockRecord(input: unknown): WatchLockRecord | undefined {
  if (typeof input !== 'object' || input === null) return;
  const record = input as Partial<WatchLockRecord>;
  if (
    typeof record.createdAt !== 'string' ||
    typeof record.pid !== 'number' ||
    !Number.isInteger(record.pid) ||
    typeof record.token !== 'string' ||
    (record.ownerFile !== undefined && typeof record.ownerFile !== 'string')
  )
    return;
  return {
    createdAt: record.createdAt,
    ...(record.ownerFile === undefined ? {} : { ownerFile: record.ownerFile }),
    pid: record.pid,
    token: record.token,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, 'EPERM');
  }
}

function sameFile(
  left: { readonly dev: number; readonly ino: number },
  right: { readonly dev: number; readonly ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function optionalStats(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function releaseWatchLock(
  cursorDirectory: string,
  path: string,
  ownerPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ownerStats = await optionalStats(ownerPath);
    if (!ownerStats) return;
    if (ownerStats.nlink <= 2) break;
    await sleep(2);
  }
  const ownerStats = await optionalStats(ownerPath);
  const currentStats = await optionalStats(path);
  if (ownerStats && currentStats && sameFile(ownerStats, currentStats)) await rm(path);
  await rm(ownerPath, { force: true });
  await syncDirectory(cursorDirectory);
}

async function recoverObservedWatchLock(
  cursorDirectory: string,
  path: string,
): Promise<'retry' | 'busy'> {
  const observerPath = join(cursorDirectory, `observer-${process.pid}-${randomUUID()}.lock`);
  try {
    try {
      await link(path, observerPath);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return 'retry';
      throw error;
    }
    const observedStats = await lstat(observerPath);
    if (!observedStats.isFile() || observedStats.isSymbolicLink())
      throw new Error('feedback watch lock is redirected');
    let observed: WatchLockRecord | undefined;
    try {
      if (observedStats.size <= 16 * 1_024)
        observed = watchLockRecord(JSON.parse(await readFile(observerPath, 'utf8')) as unknown);
    } catch {
      observed = undefined;
    }
    const young = Date.now() - observedStats.mtimeMs <= WATCH_LOCK_RECOVERY_GRACE_MS;
    if ((observed && processIsAlive(observed.pid)) || (!observed && young)) return 'busy';

    for (const entry of await readdir(cursorDirectory, { withFileTypes: true })) {
      const match = /^observer-(\d+)-[a-f0-9-]+\.lock$/.exec(entry.name);
      if (!match || entry.name === basename(observerPath) || !entry.isFile()) continue;
      const observerPid = Number(match[1]);
      if (Number.isInteger(observerPid) && processIsAlive(observerPid)) continue;
      const staleObserverPath = join(cursorDirectory, entry.name);
      const staleObserverStats = await optionalStats(staleObserverPath);
      if (staleObserverStats && sameFile(observedStats, staleObserverStats))
        await rm(staleObserverPath, { force: true });
    }

    let ownerPath: string | undefined;
    let ownerStats: Awaited<ReturnType<typeof lstat>> | undefined;
    if (observed?.ownerFile && /^owner-[a-f0-9-]+\.lock$/.test(observed.ownerFile)) {
      ownerPath = join(cursorDirectory, observed.ownerFile);
      ownerStats = await optionalStats(ownerPath);
      if (ownerStats && !sameFile(observedStats, ownerStats)) ownerStats = undefined;
    }
    const expectedLinks = ownerStats ? 3 : 2;
    const freshObservedStats = await optionalStats(observerPath);
    if (!freshObservedStats || freshObservedStats.nlink !== expectedLinks) {
      await sleep(Math.floor(Math.random() * 5) + 1);
      return 'retry';
    }

    const currentStats = await optionalStats(path);
    if (!currentStats || !sameFile(observedStats, currentStats)) return 'retry';
    try {
      await rm(path);
    } catch (error) {
      if (!isCode(error, 'ENOENT')) throw error;
      return 'retry';
    }

    if (ownerPath && ownerStats) await rm(ownerPath, { force: true });
    await syncDirectory(cursorDirectory);
    return 'retry';
  } finally {
    await rm(observerPath, { force: true });
  }
}

/**
 * Serialize one cursor scan across processes. Unique owner inodes and temporary
 * observer hard links fence stale recovery so it can never unlink a successor.
 */
export function acquireFeedbackWatchLock(
  cursor: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<FeedbackWatchLock | undefined, FeedbackStoreError> {
  return effectPromise('acquire feedback watch lock', async () => {
    const cursorDirectory = await ensureCursorDirectory(feedbackRegistryPaths(root), cursor);
    const path = join(cursorDirectory, 'scan.lock');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = randomUUID();
      const ownerFile = `owner-${token}.lock`;
      const ownerPath = join(cursorDirectory, ownerFile);
      const owner: WatchLockRecord = {
        createdAt: new Date().toISOString(),
        ownerFile,
        pid: process.pid,
        token,
      };
      const handle = await open(ownerPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(ownerPath, path);
        await syncDirectory(cursorDirectory);
        return {
          release: () =>
            effectPromise('release feedback watch lock', () =>
              releaseWatchLock(cursorDirectory, path, ownerPath),
            ),
        };
      } catch (error) {
        await rm(ownerPath, { force: true });
        if (!isCode(error, 'EEXIST')) throw error;
      }
      if ((await recoverObservedWatchLock(cursorDirectory, path)) === 'busy') return undefined;
    }
    return undefined;
  });
}

/** Atomically record delivery after output succeeds. */
export function claimFeedbackForWatch(
  cursor: string,
  feedbackId: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<boolean, FeedbackStoreError> {
  return effectPromise('record feedback watch delivery', async () => {
    if (!validFeedbackId(feedbackId)) throw new Error('invalid feedback id');
    const cursorDirectory = await ensureCursorDirectory(feedbackRegistryPaths(root), cursor);
    const receipt = `${JSON.stringify({ feedbackId, seenAt: new Date().toISOString() })}\n`;
    return createImmutableArtifact(join(cursorDirectory, `${feedbackId}.json`), receipt);
  });
}

export function feedbackWasSeenByWatch(
  cursor: string,
  feedbackId: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<boolean, FeedbackStoreError> {
  return effectPromise('inspect feedback watch delivery', async () => {
    if (!validFeedbackId(feedbackId)) throw new Error('invalid feedback id');
    const cursorDirectory = await ensureCursorDirectory(feedbackRegistryPaths(root), cursor);
    try {
      await access(join(cursorDirectory, `${feedbackId}.json`), constants.F_OK);
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  });
}

async function optionalInitialization(
  path: string,
): Promise<FeedbackWatchInitialization | undefined> {
  try {
    return await readDecoded(path, FeedbackWatchInitializationSchema);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Establish one durable timestamp boundary before baseline enumeration. An
 * interrupted initializer is resumed from the immutable boundary on restart.
 * Callers hold the cursor scan lock while running this transition.
 */
export function ensureFeedbackWatchInitialized(
  cursor: string,
  includeExisting: boolean,
  root = pardesGlobalStateRoot(),
): Effect.Effect<FeedbackWatchInitialization, FeedbackStoreError> {
  return effectPromise('initialize feedback watch cursor', async () => {
    const cursorDirectory = await ensureCursorDirectory(feedbackRegistryPaths(root), cursor);
    const completedPath = join(cursorDirectory, 'initialized.json');
    const completed = await optionalInitialization(completedPath);
    if (completed) {
      if (completed.cursor !== cursor || completed.status !== 'initialized')
        throw new Error('feedback watch initialization does not match its cursor');
      return completed;
    }

    const pendingPath = join(cursorDirectory, 'initializing.json');
    let pending = await optionalInitialization(pendingPath);
    if (!pending) {
      const proposed: FeedbackWatchInitialization = {
        boundaryAt: new Date().toISOString(),
        cursor,
        includeExisting,
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        status: 'initializing',
      };
      const encoded = await Effect.runPromise(
        Schema.encodeEffect(FeedbackWatchInitializationSchema)(proposed),
      );
      const created = await createImmutableArtifact(
        pendingPath,
        `${JSON.stringify(encoded, null, 2)}\n`,
      );
      pending = created
        ? proposed
        : await readDecoded(pendingPath, FeedbackWatchInitializationSchema);
    }
    if (pending.cursor !== cursor || pending.status !== 'initializing')
      throw new Error('feedback watch initialization does not match its cursor');

    if (!pending.includeExisting) {
      const baseline = await Effect.runPromise(listFeedback({}, root));
      for (const entry of baseline) {
        if (entry.submission.createdAt < pending.boundaryAt)
          await Effect.runPromise(claimFeedbackForWatch(cursor, entry.submission.id, root));
      }
    }

    const initialized: FeedbackWatchInitialization = { ...pending, status: 'initialized' };
    const encoded = await Effect.runPromise(
      Schema.encodeEffect(FeedbackWatchInitializationSchema)(initialized),
    );
    const created = await createImmutableArtifact(
      completedPath,
      `${JSON.stringify(encoded, null, 2)}\n`,
    );
    return created ? initialized : readDecoded(completedPath, FeedbackWatchInitializationSchema);
  });
}

export function watchCursorExists(
  cursor: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<boolean, FeedbackStoreError> {
  return effectPromise('inspect feedback watch cursor', async () => {
    const cursorDirectory = await ensureCursorDirectory(feedbackRegistryPaths(root), cursor);
    try {
      const initialized = await readDecoded(
        join(cursorDirectory, 'initialized.json'),
        FeedbackWatchInitializationSchema,
      );
      return initialized.cursor === cursor && initialized.status === 'initialized';
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  });
}
