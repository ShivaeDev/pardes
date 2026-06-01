import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type ManagerPresentation, makeManagerPresentation } from './pi-dashboard.ts';
import { registerWorkerEventRenderer } from './worker-events.ts';

export {
  ATTENTION_HANDOFF_FEEDBACK_MAX_CHARS,
  ATTENTION_HANDOFF_PROMPT_MAX_CHARS,
  inputPardesAttentionFeedback,
  sanitizeAttentionHandoffPrompt,
} from './attention-dialog.ts';
export type { BridgeMonitorWorker, TerminalTextLayout } from './bridge-monitor.ts';
export { attachedBridgeMonitorWorkers, renderBridgeMonitorLines } from './bridge-monitor.ts';
export {
  compactWidgetLines,
  dashboardLines,
  dashboardSummary,
  renderCompactWidgetLines,
  renderDashboardLines,
} from './dashboard.ts';
export type { ManagerContextUsage, ManagerContextUsageSnapshot } from './manager-context.ts';
export {
  MANAGER_CONTEXT_INLINE_MAX_LENGTH,
  managerContextSummary,
  normalizeManagerContextUsage,
  renderManagerContextUsage,
} from './manager-context.ts';
export type { DashboardPalette } from './palette.ts';
export type { ManagerPresentation } from './pi-dashboard.ts';
export { makeManagerPresentation } from './pi-dashboard.ts';
export {
  QUESTION_CUSTOM_ANSWER_MAX_CHARS,
  QUESTION_CUSTOM_LABEL,
  QUESTION_OPTION_DESCRIPTION_MAX_CHARS,
  QUESTION_OPTION_LABEL_MAX_CHARS,
  QUESTION_OPTIONS_MAX_ITEMS,
  QUESTION_PROMPT_MAX_CHARS,
  sanitizeQuestionCustomAnswer,
  sanitizeQuestionOptionLabel,
  selectPardesQuestionOption,
} from './question-dialog.ts';
export { bridgeMonitorLines, TUI_TERMINAL_TEXT_LAYOUT } from './terminal-layout.ts';
export {
  PARDES_TOOL_CALL_PREVIEW_MAX_CHARS,
  PARDES_TOOL_CALL_VALUE_MAX_CHARS,
  type PardesToolCallPreviewField,
  pardesToolCallPreview,
  renderPardesToolCall,
} from './tool-call-preview.ts';

export function registerManagerPresentation(
  pi: Pick<ExtensionAPI, 'registerMessageRenderer'>,
): ManagerPresentation {
  registerWorkerEventRenderer(pi);
  return makeManagerPresentation();
}
