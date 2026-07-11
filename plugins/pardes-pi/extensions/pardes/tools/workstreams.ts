import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
  MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
} from '../manager/index.ts';
import { workstreamLines } from './projections/control-plane.ts';
import { CONTROL_PLANE_MAX_ROWS } from './projections/core.ts';
import { json, managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerWorkstreamDomainTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Create a manager-scoped Pardes workstream for an engineering objective. Requires an active Pardes manager.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.createWorkstream(params, ctx));
      return result.ok
        ? textResult(`Created workstream ${result.value.id}.`, result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Create Workstream',
    name: 'workstream_create',
    parameters: Type.Object(
      {
        objective: Type.String({
          description: 'Concrete engineering objective and success criteria',
          maxLength: MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
          minLength: 1,
        }),
        title: Type.String({
          description: 'Short human-readable title',
          maxLength: MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'title', value: args.title },
      { mode: 'length', name: 'objective', value: args.objective },
    ],
    promptSnippet: 'Create a structured Pardes workstream for a coding objective',
  });

  registerPardesTool(pi, {
    description:
      'List a bounded compact projection of manager-scoped workstreams. Defaults to active work; request planned for backlog or all for bounded history.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.listWorkstreams(ctx));
      return result.ok
        ? textResult(workstreamLines(result.value, params.status ?? 'active', params.maxRows))
        : textResult(`Error: ${result.error}`);
    },
    label: 'List Workstreams',
    name: 'workstream_list',
    parameters: Type.Object(
      {
        maxRows: Type.Optional(
          Type.Integer({
            description: `Maximum returned rows, hard-capped at ${CONTROL_PLANE_MAX_ROWS} before reserved structural omission metadata.`,
            maximum: CONTROL_PLANE_MAX_ROWS,
            minimum: 1,
          }),
        ),
        status: Type.Optional(
          Type.Union(
            [
              Type.Literal('planned'),
              Type.Literal('active'),
              Type.Literal('complete'),
              Type.Literal('cancelled'),
              Type.Literal('all'),
            ],
            {
              description: 'Status filter. Defaults to active to avoid completed-history flooding.',
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'status', value: args.status },
      { name: 'maxRows', value: args.maxRows },
    ],
    promptSnippet: 'List bounded active Pardes workstreams or request the planned backlog',
  });

  registerPardesTool(pi, {
    description: 'Get one structured Pardes workstream by id. Requires an active Pardes manager.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.getWorkstream(params.workstreamId, ctx));
      return result.ok
        ? textResult(json(result.value), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Workstream',
    name: 'workstream_get',
    parameters: Type.Object(
      { workstreamId: managerId('Workstream id returned by workstream_create or workstream_list') },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'workstreamId', value: args.workstreamId }],
    promptSnippet: 'Inspect one Pardes workstream by id',
  });

  registerPardesTool(pi, {
    description:
      'Complete a Pardes workstream and safely stop its idle attached children while preserving worktrees, branch history, sessions, reports, and review gates. In the narrow terminal-report-to-idle race, stores one bounded generation-owned intent and completes automatically only after authoritative idle edges. Fails closed without interrupting genuinely busy/nonterminal children or unresolved open-review owners.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.completeWorkstream(params.workstreamId, ctx));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const completionIntent =
        'completionIntent' in result.value ? result.value.completionIntent : undefined;
      return completionIntent
        ? textResult(
            `Deferred workstream ${result.value.id} completion until ${completionIntent.pendingAgents.length} generation-owned terminal child${completionIntent.pendingAgents.length === 1 ? '' : 'ren'} reaches an authoritative idle edge.`,
            result.value,
          )
        : textResult(`Completed workstream ${result.value.id}.`, result.value);
    },
    label: 'Complete Workstream',
    name: 'workstream_complete',
    parameters: Type.Object(
      { workstreamId: managerId('Finished workstream id') },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'workstreamId', value: args.workstreamId }],
    promptSnippet: 'Complete a finished Pardes workstream and safely retain its child artifacts',
  });
}
