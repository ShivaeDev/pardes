export const CONTROL_PLANE_MAX_ROWS = 12;
export const CONTROL_PLANE_DEFAULT_ROWS = 7;
export const CONTROL_PLANE_MAX_TEXT_LENGTH = 2_000;
export const CONTROL_PLANE_MAX_LINE_LENGTH = 180;
const SUMMARY_ATTENTION_TOKEN_MAX_CHARS = 80;
const SUMMARY_ATTENTION_TOKEN_PATTERN = /^[a-zA-Z0-9._-]+$/;
const PLAIN_STRUCTURAL_VALUE_PATTERN = /^[a-zA-Z0-9._/@:+#=-]+$/;
const BIDI_CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069]/g;

export function compactText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

/** Keep diagnostics complete or replace them with explicit structural omission metadata. */
export function completeOrOmittedText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit
    ? normalized
    : `<omitted oversized text: ${normalized.length} chars>`;
}

/** Render one identifier, ref, SHA, branch, or path without clipping or terminal-active controls. */
export function structuralValue(value: string): string {
  if (PLAIN_STRUCTURAL_VALUE_PATTERN.test(value)) return value;
  return JSON.stringify(value).replace(
    BIDI_CONTROL_PATTERN,
    (control) => `\\u${control.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export type ProjectionRowGroup = string | ReadonlyArray<string>;

export interface StructuralRowsInput {
  /** Software-authored orientation rows that remain visible before variable records. */
  readonly authoredLines: ReadonlyArray<string>;
  /** Variable records. A multi-row record is admitted or omitted as one complete group. */
  readonly itemLines?: ReadonlyArray<ProjectionRowGroup>;
  /** Software-authored retrieval or bounds hints that remain visible after variable records. */
  readonly retrievalHintLines?: ReadonlyArray<string>;
  readonly maxItems?: number;
  readonly omissionLine?: (omittedItems: number, omittedRows: number) => string;
}

function oneProjectionLine(line: string): string {
  return /[\r\n]/.test(line) ? '<omitted multiline projection row>' : line;
}

function groupRows(group: ProjectionRowGroup): ReadonlyArray<string> {
  return (typeof group === 'string' ? [group] : group).map(oneProjectionLine);
}

function textLength(lines: ReadonlyArray<string>): number {
  return lines.join('\n').length;
}

function defaultOmissionLine(_omittedItems: number, omittedRows: number): string {
  return `… ${omittedRows} more ${omittedRows === 1 ? 'row' : 'rows'} omitted`;
}

/**
 * Budget model-visible projections by complete structural rows. Authored rows,
 * omission metadata, and retrieval hints are reserved; variable groups are
 * admitted only as a complete first-N prefix. No row or final string is sliced.
 */
export function structuralRows(
  input: StructuralRowsInput,
  requestedRows = CONTROL_PLANE_DEFAULT_ROWS,
): string {
  const rowTarget = Math.max(1, Math.min(CONTROL_PLANE_MAX_ROWS, Math.floor(requestedRows)));
  const authoredLines = input.authoredLines.map(oneProjectionLine);
  const retrievalHintLines = (input.retrievalHintLines ?? []).map(oneProjectionLine);
  const groups = (input.itemLines ?? []).map(groupRows);
  const maxItems = Math.max(0, Math.floor(input.maxItems ?? groups.length));
  let visibleItems = Math.min(groups.length, maxItems);
  const omissionLine = input.omissionLine ?? defaultOmissionLine;

  const render = (count: number): ReadonlyArray<string> => {
    const omittedGroups = groups.slice(count);
    const omittedRows = omittedGroups.reduce((total, rows) => total + rows.length, 0);
    return [
      ...authoredLines,
      ...groups.slice(0, count).flat(),
      ...(omittedGroups.length === 0
        ? []
        : [oneProjectionLine(omissionLine(omittedGroups.length, omittedRows))]),
      ...retrievalHintLines,
    ];
  };

  while (visibleItems > 0) {
    const lines = render(visibleItems);
    if (lines.length <= rowTarget && textLength(lines) <= CONTROL_PLANE_MAX_TEXT_LENGTH)
      return lines.join('\n');
    visibleItems -= 1;
  }

  const reserved = render(0);
  if (
    reserved.length <= CONTROL_PLANE_MAX_ROWS &&
    textLength(reserved) <= CONTROL_PLANE_MAX_TEXT_LENGTH
  )
    return reserved.join('\n');
  return 'projection unavailable: reserved structural rows exceed the model-visible budget';
}

/** Retained convenience for one authored header followed by variable complete rows. */
export function boundedRows(
  lines: ReadonlyArray<string>,
  requestedRows = CONTROL_PLANE_DEFAULT_ROWS,
): string {
  const [header, ...items] = lines;
  return structuralRows(
    {
      authoredLines: header === undefined ? [] : [header],
      itemLines: items,
    },
    requestedRows,
  );
}

export function plural(count: number, singular: string, pluralized = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralized}`;
}

export function elapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function summaryAttentionToken(value: string, fallback: string): string {
  return value.length <= SUMMARY_ATTENTION_TOKEN_MAX_CHARS &&
    SUMMARY_ATTENTION_TOKEN_PATTERN.test(value)
    ? value
    : fallback;
}
