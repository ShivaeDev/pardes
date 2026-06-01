import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { storeError } from './errors.ts';
import { fsPromise } from './filesystem.ts';

export const STORAGE_EVENT_SCAN_MAX_BYTES = 64 * 1_024;
export const STORAGE_REPORT_SCAN_MAX_ENTRIES = 128;
const STORAGE_SCAN_BUFFER_BYTES = 8 * 1_024;

export type StorageObservationIssue = 'access_denied' | 'io_error';
export type StorageBlockedReason = 'root_redirected' | 'root_unavailable' | 'root_unusual';
export type StorageLeafKind =
  | 'missing'
  | 'regular_file'
  | 'directory'
  | 'redirected'
  | 'unusual'
  | 'unavailable'
  | 'blocked';
export type StorageMetricAccuracy = 'exact' | 'lower_bound' | 'unavailable';

export interface StorageLeafObservation {
  readonly kind: StorageLeafKind;
  readonly bytes?: number;
  readonly issue?: StorageObservationIssue;
  readonly blockedReason?: StorageBlockedReason;
}

export interface EventStorageObservation extends StorageLeafObservation {
  readonly eventLines: number;
  readonly eventLinesAccuracy: StorageMetricAccuracy;
  readonly scannedBytes: number;
}

export interface ReportStorageObservation extends StorageLeafObservation {
  readonly reports: number;
  readonly reportBytes: number;
  readonly metricsAccuracy: StorageMetricAccuracy;
  readonly scannedEntries: number;
  readonly otherEntries: number;
}

export interface StorageInspection {
  readonly root: StorageLeafObservation;
  readonly state: StorageLeafObservation;
  readonly events: EventStorageObservation;
  readonly reports: ReportStorageObservation;
  readonly bounds: {
    readonly eventScanMaxBytes: number;
    readonly reportScanMaxEntries: number;
  };
}

export interface FileSystemStoragePaths {
  readonly directory: string;
  readonly statePath: string;
  readonly eventPath: string;
  readonly reportsPath: string;
}

function observationIssue(cause: unknown): StorageObservationIssue {
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = String(cause.code);
    if (code === 'EACCES' || code === 'EPERM') return 'access_denied';
  }
  return 'io_error';
}

function isMissing(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}

function observeStats(stats: Stats): StorageLeafObservation {
  if (stats.isSymbolicLink()) return { kind: 'redirected' };
  if (stats.isFile()) return { bytes: stats.size, kind: 'regular_file' };
  if (stats.isDirectory()) return { kind: 'directory' };
  return { kind: 'unusual' };
}

const observeLeaf = Effect.fnUntraced(function* (path: string) {
  return yield* fsPromise('inspect storage leaf', path, () => lstat(path)).pipe(
    Effect.map(observeStats),
    Effect.catch((error) =>
      Effect.succeed(
        isMissing(error.cause)
          ? { kind: 'missing' as const }
          : { issue: observationIssue(error.cause), kind: 'unavailable' as const },
      ),
    ),
  );
});

interface EventLineScan {
  readonly bytes: number;
  readonly eventLines: number;
  readonly accuracy: Exclude<StorageMetricAccuracy, 'unavailable'>;
  readonly scannedBytes: number;
}

function noFollowReadOnlyFlags(): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

const scanEventLines = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.acquireUseRelease(
    fsPromise('open events for inspection', path, () => open(path, noFollowReadOnlyFlags())),
    (handle) =>
      Effect.gen(function* () {
        const stats = yield* fsPromise('inspect opened events', path, () => handle.stat());
        if (!stats.isFile())
          return yield* storeError(
            'inspect opened events type',
            path,
            'events leaf is no longer a regular file',
          );
        const bytesToScan = Math.min(stats.size, STORAGE_EVENT_SCAN_MAX_BYTES);
        const buffer = Buffer.allocUnsafe(
          Math.min(STORAGE_SCAN_BUFFER_BYTES, Math.max(1, bytesToScan)),
        );
        let scannedBytes = 0;
        let eventLines = 0;
        let lastByte: number | undefined;
        while (scannedBytes < bytesToScan) {
          const length = Math.min(buffer.length, bytesToScan - scannedBytes);
          const read = yield* fsPromise('read events for inspection', path, () =>
            handle.read(buffer, 0, length, scannedBytes),
          );
          if (read.bytesRead === 0)
            return yield* storeError(
              'read events for inspection',
              path,
              'events leaf changed during inspection',
            );
          for (let index = 0; index < read.bytesRead; index += 1) {
            if (buffer[index] === 10) eventLines += 1;
          }
          lastByte = buffer[read.bytesRead - 1];
          scannedBytes += read.bytesRead;
        }
        const accuracy =
          stats.size <= STORAGE_EVENT_SCAN_MAX_BYTES
            ? ('exact' as const)
            : ('lower_bound' as const);
        if (accuracy === 'exact' && stats.size > 0 && lastByte !== 10) eventLines += 1;
        return { accuracy, bytes: stats.size, eventLines, scannedBytes } satisfies EventLineScan;
      }),
    (handle) =>
      fsPromise('close events inspection', path, () => handle.close()).pipe(Effect.ignore),
  );
});

const observeEvents = Effect.fnUntraced(function* (path: string) {
  const leaf = yield* observeLeaf(path);
  if (leaf.kind === 'missing')
    return { ...leaf, eventLines: 0, eventLinesAccuracy: 'exact' as const, scannedBytes: 0 };
  if (leaf.kind !== 'regular_file')
    return { ...leaf, eventLines: 0, eventLinesAccuracy: 'unavailable' as const, scannedBytes: 0 };
  return yield* scanEventLines(path).pipe(
    Effect.map((scan) => ({
      bytes: scan.bytes,
      eventLines: scan.eventLines,
      eventLinesAccuracy: scan.accuracy,
      kind: 'regular_file' as const,
      scannedBytes: scan.scannedBytes,
    })),
    Effect.catch((error) =>
      Effect.succeed({
        ...leaf,
        eventLines: 0,
        eventLinesAccuracy: 'unavailable' as const,
        issue: observationIssue(error.cause),
        scannedBytes: 0,
      }),
    ),
  );
});

interface ReportDirectoryScan {
  readonly reports: number;
  readonly reportBytes: number;
  readonly accuracy: Exclude<StorageMetricAccuracy, 'unavailable'>;
  readonly scannedEntries: number;
  readonly otherEntries: number;
}

const scanReportDirectory = Effect.fnUntraced(function* (path: string) {
  return yield* Effect.acquireUseRelease(
    fsPromise('open reports for inspection', path, () => opendir(path)),
    (directory) =>
      Effect.gen(function* () {
        let reports = 0;
        let reportBytes = 0;
        let scannedEntries = 0;
        let otherEntries = 0;
        while (scannedEntries < STORAGE_REPORT_SCAN_MAX_ENTRIES) {
          const entry = yield* fsPromise('read reports for inspection', path, () =>
            directory.read(),
          );
          if (!entry)
            return {
              accuracy: 'exact' as const,
              otherEntries,
              reportBytes,
              reports,
              scannedEntries,
            } satisfies ReportDirectoryScan;
          scannedEntries += 1;
          if (!entry.name.endsWith('.json')) {
            otherEntries += 1;
            continue;
          }
          const leaf = yield* observeLeaf(join(path, entry.name));
          if (leaf.kind === 'regular_file') {
            reports += 1;
            reportBytes += leaf.bytes ?? 0;
          } else {
            otherEntries += 1;
          }
        }
        const overflow = yield* fsPromise('read reports scan boundary', path, () =>
          directory.read(),
        );
        return {
          accuracy: overflow ? ('lower_bound' as const) : ('exact' as const),
          otherEntries,
          reportBytes,
          reports,
          scannedEntries,
        } satisfies ReportDirectoryScan;
      }),
    (directory) =>
      fsPromise('close reports inspection', path, () => directory.close()).pipe(Effect.ignore),
  );
});

const observeReports = Effect.fnUntraced(function* (path: string) {
  const leaf = yield* observeLeaf(path);
  if (leaf.kind === 'missing') {
    return {
      ...leaf,
      metricsAccuracy: 'exact' as const,
      otherEntries: 0,
      reportBytes: 0,
      reports: 0,
      scannedEntries: 0,
    };
  }
  if (leaf.kind !== 'directory') {
    return {
      ...leaf,
      metricsAccuracy: 'unavailable' as const,
      otherEntries: 0,
      reportBytes: 0,
      reports: 0,
      scannedEntries: 0,
    };
  }
  return yield* scanReportDirectory(path).pipe(
    Effect.map((scan) => ({
      kind: 'directory' as const,
      metricsAccuracy: scan.accuracy,
      otherEntries: scan.otherEntries,
      reportBytes: scan.reportBytes,
      reports: scan.reports,
      scannedEntries: scan.scannedEntries,
    })),
    Effect.catch((error) =>
      Effect.succeed({
        ...leaf,
        issue: observationIssue(error.cause),
        metricsAccuracy: 'unavailable' as const,
        otherEntries: 0,
        reportBytes: 0,
        reports: 0,
        scannedEntries: 0,
      }),
    ),
  );
});

function blockedLeaf(blockedReason: StorageBlockedReason): StorageLeafObservation {
  return { blockedReason, kind: 'blocked' };
}

function blockedEvents(blockedReason: StorageBlockedReason): EventStorageObservation {
  return {
    ...blockedLeaf(blockedReason),
    eventLines: 0,
    eventLinesAccuracy: 'unavailable',
    scannedBytes: 0,
  };
}

function blockedReports(blockedReason: StorageBlockedReason): ReportStorageObservation {
  return {
    ...blockedLeaf(blockedReason),
    metricsAccuracy: 'unavailable',
    otherEntries: 0,
    reportBytes: 0,
    reports: 0,
    scannedEntries: 0,
  };
}

function inspection(
  root: StorageLeafObservation,
  state: StorageLeafObservation,
  events: EventStorageObservation,
  reports: ReportStorageObservation,
): StorageInspection {
  return {
    bounds: {
      eventScanMaxBytes: STORAGE_EVENT_SCAN_MAX_BYTES,
      reportScanMaxEntries: STORAGE_REPORT_SCAN_MAX_ENTRIES,
    },
    events,
    reports,
    root,
    state,
  };
}

/** Observe only direct storage leaves and bounded aggregate metrics; never return artifact content or listings. */
export const inspectFileSystemStorage = Effect.fnUntraced(function* (
  paths: FileSystemStoragePaths,
) {
  const root = yield* observeLeaf(paths.directory);
  if (root.kind === 'missing') {
    return inspection(
      root,
      { kind: 'missing' },
      { eventLines: 0, eventLinesAccuracy: 'exact', kind: 'missing', scannedBytes: 0 },
      {
        kind: 'missing',
        metricsAccuracy: 'exact',
        otherEntries: 0,
        reportBytes: 0,
        reports: 0,
        scannedEntries: 0,
      },
    );
  }
  if (root.kind !== 'directory') {
    const blockedReason =
      root.kind === 'redirected'
        ? 'root_redirected'
        : root.kind === 'unavailable'
          ? 'root_unavailable'
          : 'root_unusual';
    return inspection(
      root,
      blockedLeaf(blockedReason),
      blockedEvents(blockedReason),
      blockedReports(blockedReason),
    );
  }
  const state = yield* observeLeaf(paths.statePath);
  const events = yield* observeEvents(paths.eventPath);
  const reports = yield* observeReports(paths.reportsPath);
  return inspection(root, state, events, reports);
});
