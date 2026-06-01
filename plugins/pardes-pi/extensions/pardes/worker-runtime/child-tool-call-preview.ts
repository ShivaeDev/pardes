import type { Theme } from '@earendil-works/pi-coding-agent';
import { TruncatedText } from '@earendil-works/pi-tui';

const CHILD_TOOL_CALL_PREVIEW_MAX_CHARS = 180;
const CHILD_TOOL_CALL_VALUE_MAX_CHARS = 48;

interface ChildToolCallPreviewField {
  readonly name: string;
  readonly value: unknown;
  readonly mode?: 'value' | 'length';
}

function truncatePreview(text: string, maxChars: number): string {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join('')}…`;
}

function escapedString(value: string): string {
  const escaped = JSON.stringify(truncatePreview(value, CHILD_TOOL_CALL_VALUE_MAX_CHARS));
  return escaped.replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function valueLength(value: unknown): string {
  if (typeof value === 'string') return `<${value.length} chars>`;
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (value !== null && typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return `<${String(value).length} chars>`;
}

function previewValue({ value, mode = 'value' }: ChildToolCallPreviewField): string | undefined {
  if (value === undefined) return undefined;
  if (mode === 'length') return valueLength(value);
  if (typeof value === 'string') return escapedString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return escapedString(String(value));
}

export function renderChildToolCall(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<ChildToolCallPreviewField>,
): TruncatedText {
  const renderedFields = fields.flatMap((field) => {
    const value = previewValue(field);
    return value === undefined ? [] : [`${field.name}=${value}`];
  });
  const preview = truncatePreview(
    `${toolName}(${renderedFields.join(', ')})`,
    CHILD_TOOL_CALL_PREVIEW_MAX_CHARS,
  );
  return new TruncatedText(
    `${theme.fg('toolTitle', theme.bold(toolName))}${theme.fg('muted', preview.slice(toolName.length))}`,
    0,
    0,
  );
}
