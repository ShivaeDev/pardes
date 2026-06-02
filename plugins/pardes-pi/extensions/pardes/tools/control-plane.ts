import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { type ManagerController, projectResolvedWorkCleanup } from '../manager/index.ts';
import { agentLines } from './projections/agents.ts';
import { resolvedWorkCleanupLines } from './projections/cleanup.ts';
import { summaryLines, workstreamLines } from './projections/control-plane.ts';
import { CONTROL_PLANE_MAX_ROWS } from './projections/core.ts';
import {
  inboxEventDetailLines,
  inboxEventDetailMetadata,
  inboxLines,
} from './projections/inbox.ts';
import {
  activationLines,
  githubIntegrationHealthLines,
  storageLines,
} from './projections/inspections.ts';
import { compositionLines, reviewLines } from './projections/reviews.ts';
import { verificationLines } from './projections/verifications.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerPardesStatusTool(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Read a bounded Pardes control-plane projection. Defaults to a cheap in-memory aggregate summary. Select activation for a fresh path-free shared-plugin safety inspection; select agents, workstreams, reviews, composition, verifications, inbox, or cleanup for compact state-only rows without raw state reads; select storage for an explicit read-only bounded artifact inspection; select github for an opt-in read-only bounded hosted-metadata network inspection without logs, fetch, or pull. Cleanup suggests explicit conservative operator actions but never mutates artifacts.',
    async execute(_toolCallId, params) {
      const state = manager.snapshot();
      if (!state) return textResult('Error: Pardes manager is inactive. Run /pardes start first.');
      const view = params.view ?? 'summary';
      if (view === 'activation') {
        const result = await runTool(manager.inspectActivationSafety());
        return result.ok
          ? textResult(activationLines(result.value))
          : textResult(`Error: ${result.error}`);
      }
      if (view === 'storage') {
        const result = await runTool(manager.inspectStorage());
        return result.ok
          ? textResult(storageLines(result.value, params.maxRows))
          : textResult(`Error: ${result.error}`);
      }
      if (view === 'github') {
        const result = await runTool(manager.inspectGitHubIntegrationHealth());
        return result.ok
          ? textResult(githubIntegrationHealthLines(result.value, params.maxRows))
          : textResult(`Error: ${result.error}`);
      }
      const runtimes = manager.runtimeSnapshots();
      if (view === 'agents')
        return textResult(
          agentLines(state, runtimes, params.agentFilter ?? 'active', params.maxRows),
        );
      if (view === 'workstreams')
        return textResult(
          workstreamLines(
            Object.values(state.workstreams),
            params.workstreamStatus ?? 'active',
            params.maxRows,
          ),
        );
      if (view === 'cleanup')
        return textResult(
          resolvedWorkCleanupLines(projectResolvedWorkCleanup(state, runtimes), params.maxRows),
        );
      if (view === 'reviews')
        return textResult(reviewLines(state, params.reviewFilter ?? 'open', params.maxRows));
      if (view === 'composition') return textResult(compositionLines(state, params.maxRows));
      if (view === 'verifications') return textResult(verificationLines(state, params.maxRows));
      if (view === 'inbox') return textResult(inboxLines(state, params.maxRows));
      return textResult(summaryLines(state, runtimes, manager.activationSafetySnapshot?.()));
    },
    label: 'Pardes Status',
    name: 'pardes_status',
    parameters: Type.Object(
      {
        agentFilter: Type.Optional(
          Type.Union([Type.Literal('active'), Type.Literal('warnings'), Type.Literal('all')], {
            description: 'Agent-view filter. Defaults to active workers.',
          }),
        ),
        maxRows: Type.Optional(
          Type.Integer({
            description: `Maximum returned rows, hard-capped at ${CONTROL_PLANE_MAX_ROWS}.`,
            maximum: CONTROL_PLANE_MAX_ROWS,
            minimum: 1,
          }),
        ),
        reviewFilter: Type.Optional(
          Type.Union([Type.Literal('open'), Type.Literal('attention'), Type.Literal('all')], {
            description: 'Reviews-view filter. Defaults to open review gates.',
          }),
        ),
        view: Type.Optional(
          Type.Union(
            [
              Type.Literal('summary'),
              Type.Literal('activation'),
              Type.Literal('agents'),
              Type.Literal('workstreams'),
              Type.Literal('reviews'),
              Type.Literal('composition'),
              Type.Literal('verifications'),
              Type.Literal('inbox'),
              Type.Literal('cleanup'),
              Type.Literal('storage'),
              Type.Literal('github'),
            ],
            { description: 'Bounded status projection. Defaults to summary.' },
          ),
        ),
        workstreamStatus: Type.Optional(
          Type.Union(
            [
              Type.Literal('planned'),
              Type.Literal('active'),
              Type.Literal('complete'),
              Type.Literal('cancelled'),
              Type.Literal('all'),
            ],
            {
              description:
                'Workstream-view filter. Defaults to active; request planned for backlog without completed history.',
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'view', value: args.view },
      { name: 'workstreamStatus', value: args.workstreamStatus },
      { name: 'agentFilter', value: args.agentFilter },
      { name: 'reviewFilter', value: args.reviewFilter },
      { name: 'maxRows', value: args.maxRows },
    ],
    promptSnippet:
      'Inspect concise bounded Pardes manager status before drilling into exceptional detail',
  });
}

export function registerInboxGetTool(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Read one known currently-pending durable Pardes inbox row by eventId. Returns a trust-labelled JSON-escaped bounded summary plus allowlisted metadata; never lists audit history, fetches external bodies, or routes external feedback.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.getInboxEvent(params, ctx));
      return result.ok
        ? textResult(inboxEventDetailLines(result.value), inboxEventDetailMetadata(result.value))
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Durable Inbox Event',
    name: 'inbox_get',
    parameters: Type.Object(
      {
        eventId: managerId('Path-free event id copied from pardes_status(view="inbox")'),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'eventId', value: args.eventId }],
    promptSnippet: 'Read one known durable Pardes attention row after compact inbox status',
  });
}

export function registerInboxAcknowledgeTool(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Acknowledge handled durable Pardes inbox rows through exactly one cursor. Defaults to the active delivered wake cursor. For autonomous handling before delivery, pass the exact inspected inbox event cursor. Never consumes a later queued suffix.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.acknowledgeInbox(ctx, params));
      return result.ok
        ? textResult(
            `Acknowledged ${result.value.acknowledgedCount} inbox event${result.value.acknowledgedCount === 1 ? '' : 's'}; ${result.value.pendingCount} pending; queued suffix:${result.value.queuedSuffixCount}.${result.value.deliveredCursorAgeMs === undefined ? '' : ` Delivered cursor age:${result.value.deliveredCursorAgeMs}ms.`}${result.value.staleCursor ? ' Cursor was stale; no rows were consumed.' : ''}`,
            result.value,
          )
        : textResult(`Error: ${result.error}`);
    },
    label: 'Acknowledge Inbox',
    name: 'inbox_acknowledge',
    parameters: Type.Object(
      {
        cursor: Type.Optional(
          managerId(
            'Optional exact event cursor copied from pardes_status(view="inbox"); omit to consume only the delivered wake cursor',
          ),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'cursor', value: args.cursor }],
    promptSnippet: 'Acknowledge handled Pardes inbox rows through one exact cursor',
  });
}
