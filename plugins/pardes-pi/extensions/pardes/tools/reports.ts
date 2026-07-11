import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  REPORT_EXCERPT_MAX_CHARS,
  REPORT_EXCERPT_MAX_OFFSET,
  REPORT_HANDOFF_NOTE_MAX_CHARS,
  REPORT_ID_MAX_LENGTH,
  REPORT_ID_PATTERN,
} from '../reporting/index.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';
import { type ReportDeliveryCoordinator, registerReportDelivery } from './report-delivery.ts';

function prepareLegacyReportGetArguments(args: unknown): { readonly reportId: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return args as { readonly reportId: string };
  const {
    field: _field,
    maxChars: _maxChars,
    offset: _offset,
    ...current
  } = args as Record<string, unknown>;
  return current as { readonly reportId: string };
}

export function registerReportTools(
  pi: ExtensionAPI,
  manager: ManagerController,
): ReportDeliveryCoordinator {
  const delivery = registerReportDelivery(pi);
  registerPardesTool(pi, {
    description:
      'Retrieve one known manager-scoped durable worker or advisory-verifier report by reportId. Automatically selects the canonical full body (details when present, otherwise summary) and delivers every trust-labelled bounded part in separate settlement runs so compaction can occur; never choose fields, offsets, page sizes, or continuation calls, and never lists, guesses, or loads other artifacts.',
    async execute(toolCallId, params) {
      if (delivery.activeReportId)
        return textResult(
          `Error: Canonical report ${delivery.activeReportId} is still being delivered; wait for its final automatic part before retrieving another report.`,
        );
      const result = await runTool(manager.getReport(params));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      try {
        const scheduled = delivery.start(result.value, toolCallId);
        return textResult(scheduled.text, scheduled.metadata);
      } catch (error) {
        return textResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    label: 'Get Full Durable Child Report',
    name: 'report_get',
    parameters: Type.Object(
      {
        reportId: Type.String({
          description: 'Path-free report id copied from an inbox row or agent status projection',
          maxLength: REPORT_ID_MAX_LENGTH,
          minLength: 1,
          pattern: REPORT_ID_PATTERN,
        }),
      },
      { additionalProperties: false },
    ),
    prepareArguments: prepareLegacyReportGetArguments,
    preview: (args) => [{ name: 'reportId', value: args.reportId }],
    promptGuidelines: [
      'Call report_get once with only reportId; Pardes selects the canonical full body and delivers every bounded continuation automatically in separate settlement runs.',
    ],
    promptSnippet:
      'Retrieve the complete canonical trust-labelled body of one known durable Pardes child report by reportId',
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
  return delivery;
}
