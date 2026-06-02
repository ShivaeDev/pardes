export const CONTROL_PLANE_MAX_ROWS = 12;
export const CONTROL_PLANE_DEFAULT_ROWS = 7;
export const CONTROL_PLANE_MAX_TEXT_LENGTH = 2_000;
export const CONTROL_PLANE_MAX_LINE_LENGTH = 180;
const SUMMARY_ATTENTION_TOKEN_MAX_CHARS = 80;
const SUMMARY_ATTENTION_TOKEN_PATTERN = /^[a-zA-Z0-9._-]+$/;

export function compactText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

export function boundedRows(
  lines: ReadonlyArray<string>,
  requestedRows = CONTROL_PLANE_DEFAULT_ROWS,
): string {
  const rowLimit = Math.max(1, Math.min(CONTROL_PLANE_MAX_ROWS, Math.floor(requestedRows)));
  const normalized = lines.map((line) => compactText(line, CONTROL_PLANE_MAX_LINE_LENGTH));
  const visible =
    normalized.length <= rowLimit
      ? normalized
      : [
          ...normalized.slice(0, Math.max(0, rowLimit - 1)),
          `… ${normalized.length - rowLimit + 1} more rows`,
        ];
  const text = visible.join('\n');
  return text.length <= CONTROL_PLANE_MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, CONTROL_PLANE_MAX_TEXT_LENGTH - 1)}…`;
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
  return SUMMARY_ATTENTION_TOKEN_PATTERN.test(value)
    ? compactText(value, SUMMARY_ATTENTION_TOKEN_MAX_CHARS)
    : fallback;
}
