import { Option } from 'effect';
import { type WorkerAssistantMessage, WorkerRpcWire } from './rpc/codecs.ts';

const MAX_RECENT_ACTIVITY_LINES = 5;
const MAX_RECENT_ACTIVITY_LINE_LENGTH = 240;

export interface WorkerActivityState {
  readonly recentActivityLines: ReadonlyArray<string>;
  readonly assistantActivityLine: string;
  readonly assistantActivityOpen: boolean;
  readonly assistantActivityTruncated: boolean;
}

export function createWorkerActivityState(): WorkerActivityState {
  return {
    assistantActivityLine: '',
    assistantActivityOpen: false,
    assistantActivityTruncated: false,
    recentActivityLines: [],
  };
}

export function normalizeActivityLine(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= MAX_RECENT_ACTIVITY_LINE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_RECENT_ACTIVITY_LINE_LENGTH - 1)}…`;
}

export function appendActivityLine(state: WorkerActivityState, line: string): WorkerActivityState {
  const normalized = normalizeActivityLine(line);
  if (!normalized) return state;
  return {
    ...state,
    recentActivityLines: [...state.recentActivityLines, normalized].slice(
      -MAX_RECENT_ACTIVITY_LINES,
    ),
  };
}

function activityArgs(args: unknown): Record<string, unknown> | undefined {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined;
}

function activityString(
  args: Record<string, unknown> | undefined,
  property: string,
  fallback: string,
): string {
  const value = args?.[property];
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function summarizeUnknownActivityValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === 'object') return '{…}';
  return undefined;
}

export function summarizeToolInvocation(toolName: string, args: unknown): string {
  const metadata = activityArgs(args);
  if (toolName === 'bash')
    return `› bash: ${activityString(metadata, 'command', '(command omitted)')}`;
  if (toolName === 'read') return `› read: ${activityString(metadata, 'path', '(path omitted)')}`;
  if (toolName === 'write') return `› write: ${activityString(metadata, 'path', '(path omitted)')}`;
  if (toolName === 'edit') return `› edit: ${activityString(metadata, 'path', '(path omitted)')}`;
  if (toolName === 'grep')
    return `› grep: ${activityString(metadata, 'pattern', '(pattern omitted)')} · ${activityString(metadata, 'path', '.')}`;
  if (toolName === 'find')
    return `› find: ${activityString(metadata, 'pattern', '(pattern omitted)')} · ${activityString(metadata, 'path', '.')}`;
  if (toolName === 'ls') return `› ls: ${activityString(metadata, 'path', '.')}`;
  if (toolName === 'report_to_manager') {
    const status = activityString(metadata, 'status', 'report');
    return `› report_to_manager: ${status} · ${activityString(metadata, 'summary', '(summary omitted)')}`;
  }
  if (toolName === 'ask_manager')
    return `› ask_manager: ${activityString(metadata, 'question', '(question omitted)')}`;
  const summary = Object.entries(metadata ?? {})
    .flatMap(([key, value]) => {
      const rendered = summarizeUnknownActivityValue(value);
      return rendered === undefined ? [] : [`${key}=${rendered}`];
    })
    .slice(0, 3)
    .join(' · ');
  return `› ${toolName}: ${summary || '(invoked)'}`;
}

export function visibleAssistantText(message: WorkerAssistantMessage): string | undefined {
  const text = message.content.flatMap((content) => {
    const decoded = WorkerRpcWire.decodeAssistantTextContent(content);
    return Option.isSome(decoded) ? [decoded.value.text] : [];
  });
  return text.length > 0 ? text.join('\n') : undefined;
}

export function closeAssistantActivity(state: WorkerActivityState): WorkerActivityState {
  return {
    ...state,
    assistantActivityLine: '',
    assistantActivityOpen: false,
    assistantActivityTruncated: false,
  };
}

export function appendAssistantActivity(
  state: WorkerActivityState,
  text: string,
): WorkerActivityState {
  let assistantActivityLine = state.assistantActivityLine;
  let assistantActivityTruncated = state.assistantActivityTruncated;
  if (!assistantActivityTruncated) {
    assistantActivityLine += text;
    const rawLimit = MAX_RECENT_ACTIVITY_LINE_LENGTH * 4;
    if (assistantActivityLine.length > rawLimit) {
      assistantActivityLine = assistantActivityLine.slice(0, rawLimit);
      assistantActivityTruncated = true;
    }
  }
  let normalized = normalizeActivityLine(assistantActivityLine);
  if (assistantActivityTruncated && !normalized.endsWith('…')) {
    normalized = `${normalized.slice(0, MAX_RECENT_ACTIVITY_LINE_LENGTH - 1)}…`;
  }
  const next = { ...state, assistantActivityLine, assistantActivityTruncated };
  if (!normalized) return next;
  if (state.assistantActivityOpen) {
    const recentActivityLines = [...state.recentActivityLines];
    recentActivityLines[recentActivityLines.length - 1] = normalized;
    return { ...next, recentActivityLines };
  }
  return { ...appendActivityLine(next, normalized), assistantActivityOpen: true };
}
