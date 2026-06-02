import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Layer, Semaphore } from 'effect';
import type { ManagerEvent, ManagerState } from '../manager/index.ts';
import type { AgentReport, ReportArtifactError } from '../reporting/index.ts';
import { decodeState, encodeEvent, encodeReport, encodeState, parseStateJson } from './codecs.ts';
import type { StoreError } from './errors.ts';
import { ensureDirectory, fsPromise, writeJsonAtomically } from './filesystem.ts';
import { inspectFileSystemStorage, type StorageInspection } from './inspection.ts';
import {
  ensureDirectReportsDirectory,
  readDirectReportArtifact,
  validateSerializedReportWrite,
} from './report-artifacts.ts';
import {
  readBoundedStateSource,
  validateSerializedEventWrite,
  validateSerializedLegacyStateShrinkWrite,
  validateSerializedStateWrite,
} from './state-limits.ts';

export interface StateStoreShape {
  readonly directory: string;
  readonly statePath: string;
  readonly eventPath: string;
  readonly reportsPath: string;
  readonly initialize: (state: ManagerState) => Effect.Effect<void, StoreError>;
  readonly load: () => Effect.Effect<ManagerState, StoreError>;
  /** Restore-only recovery: remove stale cursor metadata without discarding inbox prose. */
  readonly dropStaleInboxCursorsForRestore: (options: {
    readonly dropInboxHandoff: boolean;
    readonly dropInboxWake: boolean;
  }) => Effect.Effect<boolean, StoreError>;
  /** Returning the supplied state object exactly is an authoritative no-op. */
  readonly mutate: <A, E>(
    mutation: (state: ManagerState) => Effect.Effect<readonly [A, ManagerState], E>,
  ) => Effect.Effect<A, StoreError | E>;
  readonly appendEvent: (event: ManagerEvent) => Effect.Effect<void, StoreError>;
  readonly writeReport: (report: AgentReport) => Effect.Effect<string, StoreError>;
  readonly readReport: (reportId: string) => Effect.Effect<AgentReport, ReportArtifactError>;
  readonly inspectStorage: () => Effect.Effect<StorageInspection>;
}

export class StateStore extends Context.Service<StateStore, StateStoreShape>()(
  'pardes/StateStore',
) {}

/** Construct one manager-scoped JSON store with a single serialized mutation permit. */
export const makeFileSystemStateStore = Effect.fnUntraced(function* (directory: string) {
  const statePath = join(directory, 'state.json');
  const eventPath = join(directory, 'events.jsonl');
  const reportsPath = join(directory, 'reports');
  const semaphore = yield* Semaphore.make(1);

  const ensureManagerDirectory = () => ensureDirectory('create manager directory', directory);
  const ensureReportsDirectory = () => ensureDirectReportsDirectory(directory, reportsPath);

  const loadStateSourceUnlocked = Effect.fnUntraced(function* () {
    const source = yield* readBoundedStateSource(statePath);
    const json = yield* parseStateJson(statePath, source);
    const state = yield* decodeState(statePath, json);
    return { source, state };
  });

  const loadUnlocked = () => loadStateSourceUnlocked().pipe(Effect.map(({ state }) => state));

  const encodeStateSource = Effect.fnUntraced(function* (state: ManagerState) {
    const encoded = yield* encodeState(statePath, state);
    return `${JSON.stringify(encoded, null, 2)}\n`;
  });

  const writeUnlocked = Effect.fnUntraced(function* (state: ManagerState) {
    yield* ensureManagerDirectory();
    const source = yield* encodeStateSource(state);
    yield* validateSerializedStateWrite(statePath, source);
    yield* writeJsonAtomically(statePath, source, 'state');
  });

  const initialize = (state: ManagerState) => semaphore.withPermit(writeUnlocked(state));
  const load = () => semaphore.withPermit(loadUnlocked());
  const dropStaleInboxCursorsForRestore: StateStoreShape['dropStaleInboxCursorsForRestore'] = (
    options,
  ) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const { source: previousSource, state: current } = yield* loadStateSourceUnlocked();
        const dropInboxHandoff = options.dropInboxHandoff || options.dropInboxWake;
        if (
          (!options.dropInboxWake || current.inboxWake === undefined) &&
          (!dropInboxHandoff || current.inboxHandoff === undefined)
        )
          return false;
        const {
          inboxHandoff: _inboxHandoff,
          inboxWake: _inboxWake,
          ...withoutInboxCursors
        } = current;
        const proposed: ManagerState = {
          ...withoutInboxCursors,
          ...(options.dropInboxWake || current.inboxWake === undefined
            ? {}
            : { inboxWake: current.inboxWake }),
          ...(dropInboxHandoff || current.inboxHandoff === undefined
            ? {}
            : { inboxHandoff: current.inboxHandoff }),
          revision: current.revision + 1,
        };
        yield* ensureManagerDirectory();
        const nextSource = yield* encodeStateSource(proposed);
        yield* validateSerializedLegacyStateShrinkWrite(statePath, previousSource, nextSource);
        yield* writeJsonAtomically(statePath, nextSource, 'state');
        return true;
      }),
    );
  const mutate: StateStoreShape['mutate'] = (mutation) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const current = yield* loadUnlocked();
        const [result, proposed] = yield* mutation(current);
        if (proposed === current) return result;
        const next = { ...proposed, revision: current.revision + 1 };
        yield* writeUnlocked(next);
        return result;
      }),
    );
  const appendEventToLog = (event: ManagerEvent) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        yield* ensureManagerDirectory();
        const encoded = yield* encodeEvent(eventPath, event);
        const source = `${JSON.stringify(encoded)}\n`;
        yield* validateSerializedEventWrite(eventPath, source);
        yield* fsPromise('append event', eventPath, () => appendFile(eventPath, source, 'utf8'));
      }),
    );
  const writeReport = (report: AgentReport) =>
    semaphore.withPermit(
      Effect.gen(function* () {
        const encoded = yield* encodeReport(reportsPath, report);
        const reportPath = join(reportsPath, `${encoded.id}.json`);
        const source = `${JSON.stringify(encoded, null, 2)}\n`;
        yield* validateSerializedReportWrite(reportPath, source);
        yield* ensureReportsDirectory();
        yield* writeJsonAtomically(reportPath, source, 'report');
        return reportPath;
      }),
    );
  const readReport = (reportId: string) =>
    semaphore.withPermit(readDirectReportArtifact({ directory, reportsPath }, reportId));
  const inspectStorage = () =>
    semaphore.withPermit(
      inspectFileSystemStorage({ directory, eventPath, reportsPath, statePath }),
    );

  return StateStore.of({
    appendEvent: appendEventToLog,
    directory,
    dropStaleInboxCursorsForRestore,
    eventPath,
    initialize,
    inspectStorage,
    load,
    mutate,
    readReport,
    reportsPath,
    statePath,
    writeReport,
  });
});

export const fileSystemStateStoreLayer = (directory: string) =>
  Layer.effect(StateStore, makeFileSystemStateStore(directory));
