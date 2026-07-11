import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  matchesFeedbackFilter,
} from './schemas.ts';

const FEEDBACK_ID_PATTERN = /^feedback-[a-f0-9-]+$/;
const CURSOR_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
const FEEDBACK_ARTIFACT_MAX_BYTES = FEEDBACK_TEXT_MAX_BYTES + 16 * 1_024;

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

async function ensureDirectories(paths: FeedbackRegistryPaths): Promise<void> {
  await mkdir(paths.submissions, { recursive: true });
  await mkdir(paths.triage, { recursive: true });
  await mkdir(paths.watchCursors, { recursive: true });
}

/** Create one immutable, atomically visible artifact without ever replacing an existing target. */
async function createImmutableArtifact(path: string, source: string): Promise<boolean> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o444);
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
    const names = (await readdir(paths.submissions, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
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

/** Atomically claim one entry for a durable named watch cursor. */
export function claimFeedbackForWatch(
  cursor: string,
  feedbackId: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<boolean, FeedbackStoreError> {
  return effectPromise('claim feedback for watch', async () => {
    if (!CURSOR_PATTERN.test(cursor)) throw new Error('invalid watch cursor');
    if (!validFeedbackId(feedbackId)) throw new Error('invalid feedback id');
    const paths = feedbackRegistryPaths(root);
    const cursorDirectory = join(paths.watchCursors, cursor);
    await mkdir(cursorDirectory, { recursive: true });
    const receipt = `${JSON.stringify({ feedbackId, seenAt: new Date().toISOString() })}\n`;
    return createImmutableArtifact(join(cursorDirectory, `${feedbackId}.json`), receipt);
  });
}

export function watchCursorExists(
  cursor: string,
  root = pardesGlobalStateRoot(),
): Effect.Effect<boolean, FeedbackStoreError> {
  return effectPromise('inspect feedback watch cursor', async () => {
    if (!CURSOR_PATTERN.test(cursor)) throw new Error('invalid watch cursor');
    try {
      await access(join(feedbackRegistryPaths(root).watchCursors, cursor), constants.F_OK);
      return true;
    } catch (error) {
      if (isCode(error, 'ENOENT')) return false;
      throw error;
    }
  });
}
