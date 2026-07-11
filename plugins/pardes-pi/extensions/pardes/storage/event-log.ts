import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Effect } from 'effect';
import { fsPromise } from './filesystem.ts';
import { STORAGE_EVENT_WRITE_MAX_BYTES } from './state-limits.ts';

const PENDING_RAW_SUFFIX = '.corrupt-pending';
const PENDING_METADATA_SUFFIX = '.corrupt-pending.json';
export const EVENT_CORRUPTION_STATUS_SUFFIX = '.corruption-status.json';

export type EventLogCorruptionKind = 'malformed_trailing_fragment' | 'interior_corruption';

interface EventLogRepairMetadata {
  readonly classification: EventLogCorruptionKind | 'interrupted_repair';
  readonly malformedLines: number;
  readonly originalBytes: number;
  readonly repairId: string;
  readonly repairedAt: string;
  readonly retainedValidLines: number;
  readonly version: 1;
}

export interface EventLogIdentityScan {
  readonly exists: boolean;
  readonly repair?: {
    readonly classification: EventLogCorruptionKind;
    readonly malformedLines: number;
    readonly originalBytes: number;
    readonly retainedValidLines: number;
  };
}

interface ParsedEventLog {
  readonly exists: boolean;
  readonly malformedLines: number;
  readonly originalBytes: number;
  readonly retainedValidLines: number;
  readonly trailingFragment: boolean;
}

function missing(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
  );
}

async function parseEventLog(
  path: string,
  eventId: string,
  validLine?: (line: Buffer) => Promise<void>,
): Promise<ParsedEventLog> {
  let exists = false;
  let malformedLines = 0;
  let originalBytes = 0;
  let retainedValidLines = 0;
  let pending = Buffer.alloc(0);
  let oversized = false;
  let lastNonemptyMalformed = false;
  let endedWithNewline = false;

  const consume = async (terminated: boolean) => {
    if (pending.length === 0 && !oversized) {
      endedWithNewline = terminated;
      return;
    }
    let valid = false;
    if (!oversized) {
      try {
        const decoded: unknown = JSON.parse(pending.toString('utf8'));
        if (
          typeof decoded === 'object' &&
          decoded !== null &&
          'id' in decoded &&
          decoded.id === eventId
        )
          exists = true;
        valid = true;
      } catch {
        // Classified below without retaining unbounded malformed input in memory.
      }
    }
    if (valid) {
      retainedValidLines += 1;
      lastNonemptyMalformed = false;
      if (validLine) await validLine(pending);
    } else {
      malformedLines += 1;
      lastNonemptyMalformed = true;
    }
    pending = Buffer.alloc(0);
    oversized = false;
    endedWithNewline = terminated;
  };

  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      originalBytes += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        if (!oversized && end > offset) {
          const nextLength = pending.length + end - offset;
          if (nextLength > STORAGE_EVENT_WRITE_MAX_BYTES) {
            pending = Buffer.alloc(0);
            oversized = true;
          } else {
            pending = Buffer.concat([pending, bytes.subarray(offset, end)], nextLength);
          }
        }
        if (newline < 0) break;
        await consume(true);
        offset = newline + 1;
      }
    }
  } catch (cause) {
    if (missing(cause))
      return {
        exists: false,
        malformedLines: 0,
        originalBytes: 0,
        retainedValidLines: 0,
        trailingFragment: false,
      };
    throw cause;
  }
  if (pending.length > 0 || oversized) await consume(false);
  return {
    exists,
    malformedLines,
    originalBytes,
    retainedValidLines,
    trailingFragment: malformedLines === 1 && lastNonemptyMalformed && !endedWithNewline,
  };
}

function repairPaths(eventPath: string, repairId: string) {
  const raw = `${eventPath}.corrupt-${repairId}`;
  return { metadata: `${raw}.json`, raw };
}

async function finalizePendingRepair(eventPath: string): Promise<void> {
  const pendingRaw = `${eventPath}${PENDING_RAW_SUFFIX}`;
  const pendingMetadata = `${eventPath}${PENDING_METADATA_SUFFIX}`;
  let rawExists = true;
  try {
    await stat(pendingRaw);
  } catch (cause) {
    if (!missing(cause)) throw cause;
    rawExists = false;
  }
  if (!rawExists) return;
  let metadata: EventLogRepairMetadata;
  try {
    metadata = JSON.parse(await readFile(pendingMetadata, 'utf8')) as EventLogRepairMetadata;
  } catch {
    metadata = {
      classification: 'interrupted_repair',
      malformedLines: 0,
      originalBytes: (await stat(pendingRaw)).size,
      repairedAt: new Date().toISOString(),
      repairId: randomUUID(),
      retainedValidLines: 0,
      version: 1,
    };
  }
  const finalized = repairPaths(eventPath, metadata.repairId);
  try {
    await rename(pendingRaw, finalized.raw);
  } catch (cause) {
    if (!missing(cause)) throw cause;
  }
  await writeFile(finalized.metadata, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  await writeFile(
    `${eventPath}${EVENT_CORRUPTION_STATUS_SUFFIX}`,
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
  await rm(pendingMetadata, { force: true });
}

/**
 * Scan one JSONL event stream with bounded line memory. If malformed data is
 * found, preserve the complete original bytes, rebuild all parseable records,
 * and atomically replace the active stream before returning.
 */
export const scanAndRepairEventIdentity = Effect.fnUntraced(function* (
  eventPath: string,
  eventId: string,
) {
  return yield* fsPromise('scan and repair event identities', eventPath, async () => {
    await finalizePendingRepair(eventPath);
    const scan = await parseEventLog(eventPath, eventId);
    if (scan.malformedLines === 0) return { exists: scan.exists };

    const temporaryPath = join(
      dirname(eventPath),
      `.${basename(eventPath)}.${randomUUID()}.repair`,
    );
    const output = await open(temporaryPath, 'wx');
    try {
      await parseEventLog(eventPath, eventId, async (line) => {
        await output.write(line);
        await output.write('\n');
      });
    } catch (cause) {
      await rm(temporaryPath, { force: true });
      throw cause;
    } finally {
      await output.close();
    }

    const classification: EventLogCorruptionKind = scan.trailingFragment
      ? 'malformed_trailing_fragment'
      : 'interior_corruption';
    const repairId = randomUUID();
    const metadata: EventLogRepairMetadata = {
      classification,
      malformedLines: scan.malformedLines,
      originalBytes: scan.originalBytes,
      repairedAt: new Date().toISOString(),
      repairId,
      retainedValidLines: scan.retainedValidLines,
      version: 1,
    };
    const pendingRaw = `${eventPath}${PENDING_RAW_SUFFIX}`;
    const pendingMetadata = `${eventPath}${PENDING_METADATA_SUFFIX}`;
    await copyFile(eventPath, pendingRaw);
    await writeFile(pendingMetadata, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, eventPath);
    await finalizePendingRepair(eventPath);
    return {
      exists: scan.exists,
      repair: {
        classification,
        malformedLines: scan.malformedLines,
        originalBytes: scan.originalBytes,
        retainedValidLines: scan.retainedValidLines,
      },
    };
  });
});
