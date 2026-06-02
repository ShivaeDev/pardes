import { Buffer } from 'node:buffer';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  type AgentReport,
  ReportArtifactError,
  type ReportArtifactErrorReason,
} from '../reporting/index.ts';
import { decodeReport, decodeReportId, parseReportJson } from './codecs.ts';
import { type StoreError, storeError } from './errors.ts';
import { ensureDirectory, fsPromise } from './filesystem.ts';

/** Hard write-side disk-allocation cap after JSON serialization and before any artifact write. */
export const STORAGE_REPORT_WRITE_MAX_BYTES = 16 * 1_024 * 1_024;
/** Generous read-side breaker for retained historical artifacts, not the current write policy. */
export const STORAGE_REPORT_ARTIFACT_MAX_BYTES = 128 * 1_024 * 1_024;

/** Refuse unexpectedly expansive JSON encodings before creating a temporary or authoritative artifact. */
export function validateSerializedReportWrite(
  path: string,
  source: string,
): Effect.Effect<void, StoreError> {
  const bytes = Buffer.byteLength(source, 'utf8');
  return bytes <= STORAGE_REPORT_WRITE_MAX_BYTES
    ? Effect.void
    : Effect.fail(
        storeError(
          'validate serialized report size',
          path,
          `serialized report allocation breaker exceeded: reason=serialized_report_write_limit originalBytes=${bytes} shownBytes=0 omittedBytes=${bytes} maxBytes=${STORAGE_REPORT_WRITE_MAX_BYTES}`,
        ),
      );
}

function noFollowReadOnlyFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

function isMissing(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}

function isRedirected(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ELOOP';
}

function lookupReason(cause: unknown): ReportArtifactErrorReason {
  if (isMissing(cause)) return 'not_found';
  if (isRedirected(cause)) return 'redirected';
  return 'unavailable';
}

function artifactError(
  reportId: string,
  reason: ReportArtifactErrorReason,
  cause?: unknown,
): ReportArtifactError {
  return new ReportArtifactError({ reason, reportId, ...(cause === undefined ? {} : { cause }) });
}

const verifyWriteDirectory = Effect.fnUntraced(function* (path: string, label: string) {
  const stats = yield* fsPromise(`inspect ${label}`, path, () => lstat(path));
  if (stats.isSymbolicLink() || !stats.isDirectory())
    return yield* storeError(
      `validate direct ${label}`,
      path,
      `${label} is not a direct directory`,
    );
});

/** Create direct report storage leaves while refusing redirected manager/report roots. */
export const ensureDirectReportsDirectory = Effect.fnUntraced(function* (
  directory: string,
  reportsPath: string,
) {
  yield* ensureDirectory('create manager directory', directory);
  yield* verifyWriteDirectory(directory, 'manager directory');
  yield* ensureDirectory('create reports directory', reportsPath);
  yield* verifyWriteDirectory(reportsPath, 'reports directory');
});

const inspectLookupLeaf = Effect.fnUntraced(function* (reportId: string, path: string) {
  return yield* fsPromise('inspect report artifact leaf', path, () => lstat(path)).pipe(
    Effect.mapError((error) => artifactError(reportId, lookupReason(error.cause), error)),
  );
});

function requireDirectDirectory(
  reportId: string,
  stats: Stats,
): Effect.Effect<void, ReportArtifactError> {
  if (stats.isSymbolicLink()) return Effect.fail(artifactError(reportId, 'redirected'));
  if (!stats.isDirectory()) return Effect.fail(artifactError(reportId, 'unusual'));
  return Effect.void;
}

function requireDirectFile(
  reportId: string,
  stats: Stats,
): Effect.Effect<void, ReportArtifactError> {
  if (stats.isSymbolicLink()) return Effect.fail(artifactError(reportId, 'redirected'));
  if (!stats.isFile()) return Effect.fail(artifactError(reportId, 'unusual'));
  if (stats.size > STORAGE_REPORT_ARTIFACT_MAX_BYTES)
    return Effect.fail(artifactError(reportId, 'too_large'));
  return Effect.void;
}

function mapDecodeError(reportId: string, error: StoreError): ReportArtifactError {
  const reason = error.operation === 'parse report JSON' ? 'invalid_json' : 'invalid_schema';
  return artifactError(reportId, reason, error);
}

export interface ReportArtifactPaths {
  readonly directory: string;
  readonly reportsPath: string;
}

/** Read one direct manager-scoped JSON artifact without scanning or following redirects. */
export const readDirectReportArtifact = Effect.fnUntraced(function* (
  paths: ReportArtifactPaths,
  rawReportId: string,
) {
  const reportId = yield* decodeReportId(paths.reportsPath, rawReportId).pipe(
    Effect.mapError((error) => artifactError(rawReportId, 'invalid_id', error)),
  );
  const reportPath = join(paths.reportsPath, `${reportId}.json`);
  yield* requireDirectDirectory(reportId, yield* inspectLookupLeaf(reportId, paths.directory));
  yield* requireDirectDirectory(reportId, yield* inspectLookupLeaf(reportId, paths.reportsPath));
  yield* requireDirectFile(reportId, yield* inspectLookupLeaf(reportId, reportPath));
  const source = yield* Effect.acquireUseRelease(
    fsPromise('open report artifact', reportPath, () =>
      open(reportPath, noFollowReadOnlyFlags()),
    ).pipe(Effect.mapError((error) => artifactError(reportId, lookupReason(error.cause), error))),
    (handle) =>
      Effect.gen(function* () {
        const stats = yield* fsPromise('inspect opened report artifact', reportPath, () =>
          handle.stat(),
        ).pipe(Effect.mapError((error) => artifactError(reportId, 'unavailable', error)));
        yield* requireDirectFile(reportId, stats);
        return yield* fsPromise('read report artifact', reportPath, () =>
          handle.readFile('utf8'),
        ).pipe(Effect.mapError((error) => artifactError(reportId, 'unavailable', error)));
      }),
    (handle) =>
      fsPromise('close report artifact', reportPath, () => handle.close()).pipe(Effect.ignore),
  );
  const json = yield* parseReportJson(reportPath, source).pipe(
    Effect.mapError((error) => mapDecodeError(reportId, error)),
  );
  const report = yield* decodeReport(reportPath, json).pipe(
    Effect.mapError((error) => mapDecodeError(reportId, error)),
  );
  if (report.id !== reportId)
    return yield* artifactError(
      reportId,
      'invalid_schema',
      'artifact id does not match its direct manager-scoped leaf',
    );
  return report satisfies AgentReport;
});
