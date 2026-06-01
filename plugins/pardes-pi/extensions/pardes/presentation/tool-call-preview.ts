import type { Theme } from '@earendil-works/pi-coding-agent';
import { type Component, TruncatedText } from '@earendil-works/pi-tui';

export const PARDES_TOOL_CALL_PREVIEW_MAX_CHARS = 180;
export const PARDES_TOOL_CALL_VALUE_MAX_CHARS = 48;

type PreviewMode = 'value' | 'length' | 'redacted';

export interface PardesToolCallPreviewField {
  readonly name: string;
  readonly value: unknown;
  readonly mode?: PreviewMode;
}

function truncatePreview(text: string, maxChars: number): string {
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : `${characters.slice(0, maxChars - 1).join('')}…`;
}

function escapedString(value: string): string {
  const escaped = JSON.stringify(truncatePreview(value, PARDES_TOOL_CALL_VALUE_MAX_CHARS));
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

function previewValue({ value, mode = 'value' }: PardesToolCallPreviewField): string | undefined {
  if (value === undefined) return undefined;
  if (mode === 'redacted') return '<redacted>';
  if (mode === 'length') return valueLength(value);
  if (typeof value === 'string') return escapedString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  if (Array.isArray(value)) return `<${value.length} items>`;
  if (typeof value === 'object') return `<${Object.keys(value).length} fields>`;
  return escapedString(String(value));
}

export function pardesToolCallPreview(
  toolName: string,
  fields: ReadonlyArray<PardesToolCallPreviewField>,
): string {
  const renderedFields = fields.flatMap((field) => {
    const value = previewValue(field);
    return value === undefined ? [] : [`${field.name}=${value}`];
  });
  return truncatePreview(
    `${toolName}(${renderedFields.join(', ')})`,
    PARDES_TOOL_CALL_PREVIEW_MAX_CHARS,
  );
}

export function renderPardesToolCall(
  theme: Theme,
  toolName: string,
  fields: ReadonlyArray<PardesToolCallPreviewField>,
): Component {
  const preview = pardesToolCallPreview(toolName, fields);
  return new TruncatedText(
    `${theme.fg('toolTitle', theme.bold(toolName))}${theme.fg('muted', preview.slice(toolName.length))}`,
    0,
    0,
  );
}
