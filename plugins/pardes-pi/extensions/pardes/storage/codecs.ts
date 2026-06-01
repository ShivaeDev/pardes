import { Effect, Schema } from 'effect';
import {
  type ManagerEvent,
  ManagerEventSchema,
  type ManagerState,
  ManagerStateSchema,
} from '../manager/index.ts';
import {
  type AgentReport,
  AgentReportSchema,
  AgentReportWriteSchema,
  type ReportId,
  ReportIdSchema,
} from '../reporting/index.ts';
import { type StoreError, storeError } from './errors.ts';

function parseJson(
  operation: string,
  path: string,
  source: string,
): Effect.Effect<unknown, StoreError> {
  return Effect.try({
    catch: (cause) => storeError(operation, path, cause),
    try: () => JSON.parse(source) as unknown,
  });
}

export function parseStateJson(path: string, source: string): Effect.Effect<unknown, StoreError> {
  return parseJson('parse state JSON', path, source);
}

export function parseReportJson(path: string, source: string): Effect.Effect<unknown, StoreError> {
  return parseJson('parse report JSON', path, source);
}

export function decodeReportId(path: string, input: unknown): Effect.Effect<ReportId, StoreError> {
  return Schema.decodeUnknownEffect(ReportIdSchema)(input).pipe(
    Effect.mapError((cause) => storeError('decode report id schema', path, cause)),
  );
}

export function decodeReport(path: string, input: unknown): Effect.Effect<AgentReport, StoreError> {
  return Schema.decodeUnknownEffect(AgentReportSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input).pipe(Effect.mapError((cause) => storeError('decode report schema', path, cause)));
}

export function decodeState(path: string, input: unknown): Effect.Effect<ManagerState, StoreError> {
  return Schema.decodeUnknownEffect(ManagerStateSchema)(input).pipe(
    Effect.mapError((cause) => storeError('decode state schema', path, cause)),
  );
}

export function encodeState(
  path: string,
  state: ManagerState,
): Effect.Effect<typeof ManagerStateSchema.Encoded, StoreError> {
  return Schema.encodeEffect(ManagerStateSchema)(state).pipe(
    Effect.mapError((cause) => storeError('encode state schema', path, cause)),
  );
}

export function encodeEvent(
  path: string,
  event: ManagerEvent,
): Effect.Effect<typeof ManagerEventSchema.Encoded, StoreError> {
  return Schema.encodeEffect(ManagerEventSchema)(event).pipe(
    Effect.mapError((cause) => storeError('encode event schema', path, cause)),
  );
}

export function encodeReport(
  path: string,
  report: AgentReport,
): Effect.Effect<typeof AgentReportWriteSchema.Encoded, StoreError> {
  return Schema.encodeEffect(AgentReportWriteSchema)(report).pipe(
    Effect.mapError((cause) => storeError('encode report schema', path, cause)),
  );
}
