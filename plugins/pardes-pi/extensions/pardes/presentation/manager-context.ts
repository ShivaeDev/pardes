export interface ManagerContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

const CONTEXT_BAR_WIDTH = 10;
const MAX_COMPACT_TOKEN_COUNT = 999_999_999_999;
const compactTokenFormatter = Intl.NumberFormat('en', {
  maximumFractionDigits: 1,
  notation: 'compact',
});

export const MANAGER_CONTEXT_INLINE_MAX_LENGTH = 35;

export type ManagerContextUsageSnapshot =
  | {
      readonly status: 'known';
      readonly tokens: number;
      readonly contextWindow: number;
      readonly percent: number;
    }
  | {
      readonly status: 'recalibrating';
      readonly tokens: null;
      readonly contextWindow: number;
      readonly percent: null;
    }
  | {
      readonly status: 'unknown';
      readonly tokens: null;
      readonly contextWindow: null;
      readonly percent: null;
    };

const UNKNOWN_USAGE: ManagerContextUsageSnapshot = {
  contextWindow: null,
  percent: null,
  status: 'unknown',
  tokens: null,
};

function positiveWholeNumber(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function nonNegativeWholeNumber(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function boundedPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function normalizeManagerContextUsage(
  usage: ManagerContextUsage | null | undefined,
): ManagerContextUsageSnapshot {
  if (!usage) return UNKNOWN_USAGE;
  const contextWindow = positiveWholeNumber(usage.contextWindow);
  if (contextWindow === undefined) return UNKNOWN_USAGE;
  if (usage.tokens === null)
    return { contextWindow, percent: null, status: 'recalibrating', tokens: null };
  const tokens = nonNegativeWholeNumber(usage.tokens);
  if (tokens === undefined) return UNKNOWN_USAGE;
  const estimatedPercent = tokens === 0 ? 0 : (tokens / contextWindow) * 100;
  const percent =
    usage.percent !== null && Number.isFinite(usage.percent)
      ? boundedPercent(usage.percent)
      : boundedPercent(Number.isFinite(estimatedPercent) ? estimatedPercent : 100);
  return { contextWindow, percent, status: 'known', tokens };
}

function contextProgressBar(percent: number | null): string {
  const normalized = percent === null || !Number.isFinite(percent) ? 0 : boundedPercent(percent);
  const filled = Math.round((normalized / 100) * CONTEXT_BAR_WIDTH);
  return `[${'█'.repeat(filled)}${'░'.repeat(CONTEXT_BAR_WIDTH - filled)}]`;
}

function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '…';
  if (value > MAX_COMPACT_TOKEN_COUNT) return '1T+';
  return compactTokenFormatter.format(Math.floor(value));
}

function inline(text: string): string {
  return text.slice(0, MANAGER_CONTEXT_INLINE_MAX_LENGTH);
}

export function renderManagerContextUsage(snapshot: ManagerContextUsageSnapshot): string {
  if (snapshot.status === 'unknown') return `${contextProgressBar(null)} ctx …`;
  if (snapshot.status === 'recalibrating') {
    return inline(`${contextProgressBar(null)} ctx … …/${compactTokens(snapshot.contextWindow)}`);
  }
  const percent = Number.isFinite(snapshot.percent)
    ? `${Math.round(boundedPercent(snapshot.percent))}%`
    : '…';
  return inline(
    `${contextProgressBar(snapshot.percent)} ctx ${percent} ${compactTokens(snapshot.tokens)}/${compactTokens(snapshot.contextWindow)}`,
  );
}

export function managerContextSummary(usage: ManagerContextUsage | null | undefined): string {
  return renderManagerContextUsage(normalizeManagerContextUsage(usage));
}
