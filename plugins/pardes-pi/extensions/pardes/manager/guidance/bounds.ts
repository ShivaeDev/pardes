export interface ManagerGuidanceBounds {
  readonly maxLines: number;
  readonly maxLineChars: number;
  readonly maxChars: number;
}

export type ManagerGuidanceReason = 'activated' | 'restored' | 'reloaded' | 'compacted';

/** Lifecycle tiers are intentionally bounded but large enough to teach, not hint cryptically. */
export const MANAGER_GUIDANCE_BOUNDS: Readonly<
  Record<ManagerGuidanceReason, ManagerGuidanceBounds>
> = {
  activated: { maxChars: 3_500, maxLineChars: 320, maxLines: 12 },
  compacted: { maxChars: 3_800, maxLineChars: 320, maxLines: 13 },
  reloaded: { maxChars: 2_800, maxLineChars: 320, maxLines: 10 },
  restored: { maxChars: 3_200, maxLineChars: 320, maxLines: 11 },
};

export const MANAGER_GUIDANCE_MAX_LINES = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxLines),
);
export const MANAGER_GUIDANCE_MAX_LINE_CHARS = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxLineChars),
);
export const MANAGER_GUIDANCE_MAX_CHARS = Math.max(
  ...Object.values(MANAGER_GUIDANCE_BOUNDS).map((bounds) => bounds.maxChars),
);

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/** Hard-bound reminder text even if future guidance lines acquire dynamic content. */
export function boundManagerGuidance(
  lines: ReadonlyArray<string>,
  bounds: ManagerGuidanceBounds = MANAGER_GUIDANCE_BOUNDS.activated,
): string {
  const boundedLines = lines
    .flatMap((line) => line.replace(/\r/g, '').split('\n'))
    .slice(0, bounds.maxLines)
    .map((line) => truncate(line, bounds.maxLineChars));
  return truncate(boundedLines.join('\n'), bounds.maxChars);
}
