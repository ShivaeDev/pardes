import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  REPORT_EXCERPT_MAX_CHARS,
  REPORT_EXCERPT_MAX_OFFSET,
  REPORT_HANDOFF_NOTE_MAX_CHARS,
  REPORT_ID_MAX_LENGTH,
  REPORT_ID_PATTERN,
  renderReportExcerpt,
  reportExcerptMetadata,
} from '../reporting/index.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerReportTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Read one known manager-scoped durable worker or advisory-verifier report by reportId. Returns one trust-labelled JSON-escaped bounded excerpt plus allowlisted pagination metadata; never lists, guesses, or bulk-loads artifacts.',
    async execute(_toolCallId, params) {
      const result = await runTool(manager.getReport(params));
      return result.ok
        ? textResult(renderReportExcerpt(result.value), reportExcerptMetadata(result.value))
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Durable Child Report Excerpt',
    name: 'report_get',
    parameters: Type.Object(
      {
        field: Type.Optional(
          Type.Union([Type.Literal('summary'), Type.Literal('details')], {
            description:
              'Optional artifact field. Defaults to details when present, otherwise summary.',
          }),
        ),
        maxChars: Type.Optional(
          Type.Integer({
            description: `Maximum raw characters returned in this bounded excerpt, hard-capped at ${REPORT_EXCERPT_MAX_CHARS}.`,
            maximum: REPORT_EXCERPT_MAX_CHARS,
            minimum: 1,
          }),
        ),
        offset: Type.Optional(
          Type.Integer({
            description: 'Character offset into the selected field. Defaults to 0.',
            maximum: REPORT_EXCERPT_MAX_OFFSET,
            minimum: 0,
          }),
        ),
        reportId: Type.String({
          description: 'Path-free report id copied from an inbox row or agent status projection',
          maxLength: REPORT_ID_MAX_LENGTH,
          minLength: 1,
          pattern: REPORT_ID_PATTERN,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'reportId', value: args.reportId },
      { name: 'field', value: args.field },
      { name: 'offset', value: args.offset },
      { name: 'maxChars', value: args.maxChars },
    ],
    promptSnippet:
      'Retrieve one bounded trust-labelled excerpt from a known durable Pardes child report',
  });

  registerPardesTool(pi, {
    description:
      'Deliberately hand one bounded excerpt from a state-known manager-scoped durable worker or advisory-verifier report to one retained idle manager-owned agent. Sends one provenance-labelled prompt that marks report data untrusted; children receive no arbitrary report retrieval capability.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.sendReportToAgent(params, ctx));
      return result.ok
        ? textResult(
            `Sent ${result.value.behavior} handoff of ${result.value.sourceRole} report ${result.value.reportId} ${result.value.field} excerpt at offset ${result.value.offset} to ${result.value.targetAgentId}; truncated:${result.value.hasMore}.`,
            result.value,
          )
        : textResult(`Error: ${result.error}`);
    },
    label: 'Send Durable Report Excerpt to Agent',
    name: 'agent_send_report',
    parameters: Type.Object(
      {
        agentId: managerId('Retained idle manager-owned target agent id'),
        field: Type.Optional(
          Type.Union([Type.Literal('summary'), Type.Literal('details')], {
            description:
              'Optional artifact field. Defaults to details when present, otherwise summary.',
          }),
        ),
        maxChars: Type.Optional(
          Type.Integer({
            description: `Maximum raw report characters handed off, hard-capped at ${REPORT_EXCERPT_MAX_CHARS}.`,
            maximum: REPORT_EXCERPT_MAX_CHARS,
            minimum: 1,
          }),
        ),
        message: Type.Optional(
          Type.String({
            description:
              'Optional bounded manager-authored context, separated from untrusted report data.',
            maxLength: REPORT_HANDOFF_NOTE_MAX_CHARS,
            minLength: 1,
          }),
        ),
        offset: Type.Optional(
          Type.Integer({
            description: 'Character offset into the selected field. Defaults to 0.',
            maximum: REPORT_EXCERPT_MAX_OFFSET,
            minimum: 0,
          }),
        ),
        reportId: Type.String({
          description: 'State-known manager-scoped durable report id',
          maxLength: REPORT_ID_MAX_LENGTH,
          minLength: 1,
          pattern: REPORT_ID_PATTERN,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'agentId', value: args.agentId },
      { name: 'reportId', value: args.reportId },
      { name: 'field', value: args.field },
      { name: 'offset', value: args.offset },
      { name: 'maxChars', value: args.maxChars },
      { mode: 'length', name: 'message', value: args.message },
    ],
    promptSnippet:
      'Hand one bounded untrusted-review-data excerpt from a known durable report to one retained idle Pardes agent',
  });
}
