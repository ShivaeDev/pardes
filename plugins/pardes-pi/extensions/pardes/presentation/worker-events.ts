import {
  type ExtensionAPI,
  getMarkdownTheme,
  type MessageRenderer,
} from '@earendil-works/pi-coding-agent';
import { Box, Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';

const WORKER_EVENT_TYPE = 'pardes-worker-event';
const LEGACY_BODY_PREFIX = '[Pardes worker event] ';
const MAX_BODY_CHARS = 1_200;
const MAX_METADATA_VALUE_CHARS = 96;

type HeaderColor = 'accent' | 'success' | 'warning' | 'error';

interface HeaderPresentation {
  readonly icon: string;
  readonly label: string;
  readonly color: HeaderColor;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function boundedText(value: unknown, limit = MAX_METADATA_VALUE_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function messageText(content: Parameters<MessageRenderer>[0]['content']): string {
  if (typeof content === 'string') return content;
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function markdownBody(content: Parameters<MessageRenderer>[0]['content']): string {
  const text = messageText(content);
  const withoutLegacyPrefix = text.startsWith(LEGACY_BODY_PREFIX)
    ? text.slice(LEGACY_BODY_PREFIX.length)
    : text;
  const trimmed = withoutLegacyPrefix.trim();
  if (!trimmed) return '_(no worker-event summary)_';
  return trimmed.length <= MAX_BODY_CHARS ? trimmed : `${trimmed.slice(0, MAX_BODY_CHARS - 1)}…`;
}

function headerPresentation(
  details: Readonly<Record<string, unknown>> | undefined,
): HeaderPresentation {
  const type = boundedText(details?.type);
  const status = boundedText(details?.status);

  if (type === 'manager_inbox_wake') return { color: 'warning', icon: '!', label: 'INBOX WAKE' };
  if (type === 'unexpected_exit') return { color: 'error', icon: '✗', label: 'CRASHED' };
  if (type === 'protocol_error') return { color: 'error', icon: '✗', label: 'PROTOCOL ERROR' };
  if (type === 'question') return { color: 'warning', icon: '?', label: 'QUESTION' };

  if (status === 'completed') return { color: 'success', icon: '✓', label: 'COMPLETED' };
  if (status === 'blocked') return { color: 'warning', icon: '!', label: 'BLOCKED' };
  if (status === 'idle') return { color: 'accent', icon: '○', label: 'IDLE' };
  if (status === 'progress') return { color: 'accent', icon: '…', label: 'PROGRESS' };
  if (status === 'crashed') return { color: 'error', icon: '✗', label: 'CRASHED' };
  return { color: 'accent', icon: '•', label: 'EVENT' };
}

function metadataLines(
  details: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<string> {
  if (!details) return [];
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    const text = boundedText(value);
    if (text) lines.push(`${label}: ${text}`);
  };

  add('event', details.type);
  add('agent', details.agentId);
  add('status', details.status);
  add('report', details.reportId);
  add('wake', details.wakeToken);
  add('cursor', details.cursor);
  if (typeof details.pendingCount === 'number' && Number.isFinite(details.pendingCount))
    lines.push(`pending: ${details.pendingCount}`);
  if (typeof details.queuedSuffixCount === 'number' && Number.isFinite(details.queuedSuffixCount))
    lines.push(`queued suffix: ${details.queuedSuffixCount}`);
  if (typeof details.exitCode === 'number' && Number.isFinite(details.exitCode))
    lines.push(`exit: ${details.exitCode}`);
  add('signal', details.signal);

  return lines;
}

export const renderWorkerEvent: MessageRenderer = (message, { expanded }, theme) => {
  const details = asRecord(message.details);
  const presentation = headerPresentation(details);
  const agentId = boundedText(details?.agentId);
  const label = details?.type === 'manager_inbox_wake' ? 'Pardes manager' : 'Pardes worker';
  const header = [
    `${theme.fg(presentation.color, presentation.icon)} ${theme.fg('customMessageLabel', theme.bold(label))}`,
    theme.fg(presentation.color, presentation.label),
    agentId ? theme.fg('muted', agentId) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');

  const body = new Markdown(markdownBody(message.content), 0, 0, getMarkdownTheme(), {
    color: (text) => theme.fg('customMessageText', text),
  });
  const content = new Container();
  content.addChild(new Text(header, 0, 0));
  content.addChild(new Spacer(1));
  content.addChild(body);

  const metadata = expanded ? metadataLines(details) : [];
  if (metadata.length > 0) {
    content.addChild(new Spacer(1));
    content.addChild(new Text(theme.fg('muted', 'Metadata'), 0, 0));
    content.addChild(
      new Text(theme.fg('dim', metadata.map((line) => `  ${line}`).join('\n')), 0, 0),
    );
  }

  const box = new Box(1, 1, (text) => theme.bg('customMessageBg', text));
  box.addChild(content);
  return box;
};

export function registerWorkerEventRenderer(
  pi: Pick<ExtensionAPI, 'registerMessageRenderer'>,
): void {
  pi.registerMessageRenderer(WORKER_EVENT_TYPE, renderWorkerEvent);
}
