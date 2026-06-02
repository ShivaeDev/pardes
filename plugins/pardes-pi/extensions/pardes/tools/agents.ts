import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  MANAGER_INPUT_BASELINE_BRANCH_MAX_LENGTH,
  MANAGER_INPUT_BASELINE_BRANCH_PATTERN,
  MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
  MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
  PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE,
} from '../manager/index.ts';
import {
  agentLeaseCleanupLines,
  auditAgentStatus,
  conciseAgentStatus,
  runtimeAgentStatus,
  stopAuditWarning,
} from './projections/agents.ts';
import { completeOrOmittedText } from './projections/core.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerAgentDomainTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      "Resolve a fresh origin baseline to an immutable commit, create a manager-namespaced Git worktree, and launch a persistent Pi RPC worker. Defaults to origin's configured default branch; use a branch override only intentionally. Requires an active Pardes manager.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.spawnAgent(params, ctx));
      return result.ok
        ? textResult(
            `Spawned worker ${result.value.id}${result.value.title ? ` “${result.value.title}”` : ''} (${result.value.status}).`,
            result.value,
          )
        : textResult(`Error: ${result.error}`);
    },
    label: 'Spawn Worker Agent',
    name: 'agent_spawn',
    parameters: Type.Object(
      {
        baselineBranch: Type.Optional(
          Type.String({
            description:
              "Intentional origin branch override. Defaults to origin's configured default branch.",
            maxLength: MANAGER_INPUT_BASELINE_BRANCH_MAX_LENGTH,
            minLength: 1,
            pattern: MANAGER_INPUT_BASELINE_BRANCH_PATTERN,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Optional Pi model override, such as openai-codex/gpt-5.4. Defaults to the manager session's selected model.",
            maxLength: MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
            minLength: 1,
          }),
        ),
        task: Type.String({
          description: 'Bounded worker briefing and completion criteria',
          maxLength: MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
          minLength: 1,
        }),
        thinkingLevel: Type.Optional(
          Type.Union(
            [
              Type.Literal('off'),
              Type.Literal('minimal'),
              Type.Literal('low'),
              Type.Literal('medium'),
              Type.Literal('high'),
              Type.Literal('xhigh'),
            ],
            {
              description:
                "Optional reasoning-level override. Defaults to the manager session's current thinking level.",
            },
          ),
        ),
        title: Type.Optional(
          Type.String({
            description: 'Optional short human-readable worker title',
            maxLength: 80,
            minLength: 1,
          }),
        ),
        workstreamId: managerId('Owning workstream id'),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'workstreamId', value: args.workstreamId },
      { name: 'title', value: args.title },
      { mode: 'length', name: 'task', value: args.task },
      { name: 'baselineBranch', value: args.baselineBranch },
      { name: 'model', value: args.model },
      { name: 'thinkingLevel', value: args.thinkingLevel },
    ],
    promptSnippet: 'Spawn an isolated persistent Pardes worker from a fresh origin baseline',
  });

  registerPardesTool(pi, {
    description:
      'Inspect one Pardes worker through a bounded projection. Defaults to a concise summary; use audit or runtime only when needed. Retrieve durable report details separately with report_get.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const mode = params.mode ?? 'summary';
      const result = await runTool(manager.agentStatus(params.agentId, ctx, mode === 'audit'));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      if (mode === 'audit') return textResult(auditAgentStatus(result.value));
      if (mode === 'runtime') return textResult(runtimeAgentStatus(result.value));
      return textResult(conciseAgentStatus(result.value));
    },
    label: 'Agent Status',
    name: 'agent_status',
    parameters: Type.Object(
      {
        agentId: managerId(),
        mode: Type.Optional(
          Type.Union([Type.Literal('summary'), Type.Literal('audit'), Type.Literal('runtime')], {
            description: 'Bounded projection. Defaults to summary.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'agentId', value: args.agentId },
      { name: 'mode', value: args.mode },
    ],
    promptSnippet:
      'Inspect one Pardes worker concisely, drilling into bounded audit or runtime state only as needed',
  });

  registerPardesTool(pi, {
    description: `Send guidance to a retained Pardes worker conversation. Defaults to routine auto-routing: prompt while idle, queued follow-up while active. Reserve explicit steer for urgent interruption; use prompt or followUp only as intentional overrides. When routing PR feedback, include this constraint: ${PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE}`,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requestedBehavior = params.behavior ?? 'auto';
      const result = await runTool(
        manager.sendAgent(params.agentId, params.message, requestedBehavior, ctx),
      );
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const routing =
        result.value.delivery.requestedBehavior === result.value.delivery.deliveredAs
          ? ''
          : ` (${result.value.delivery.requestedBehavior}-routed)`;
      return textResult(
        `Sent ${result.value.delivery.deliveredAs} message${routing} to ${params.agentId}.`,
        { agentId: params.agentId, delivery: result.value.delivery },
      );
    },
    label: 'Send Agent Message',
    name: 'agent_send',
    parameters: Type.Object(
      {
        agentId: managerId(),
        behavior: Type.Optional(
          Type.Union(
            [
              Type.Literal('auto'),
              Type.Literal('prompt'),
              Type.Literal('steer'),
              Type.Literal('followUp'),
            ],
            {
              description:
                'Defaults to auto: prompt when idle, queued follow-up when active. Reserve steer for explicit urgent interruption; prompt and followUp remain intentional overrides.',
            },
          ),
        ),
        message: Type.String({ maxLength: MANAGER_INPUT_LONG_TEXT_MAX_LENGTH, minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'agentId', value: args.agentId },
      { mode: 'length', name: 'message', value: args.message },
      { name: 'behavior', value: args.behavior },
    ],
    promptGuidelines: [PUBLISHED_REVIEW_FEEDBACK_ROUTING_GUIDANCE],
    promptSnippet:
      'Send routine auto-routed guidance to a retained Pardes worker; for published-review feedback require additive descendant commits only; steer only for urgent interruption',
  });

  registerPardesTool(pi, {
    description:
      'Request attached-idle manual compaction for one child conversation only. This is not manager plugin /reload and does not toggle automatic compaction.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.compactAgent(params.agentId, ctx));
      if (!result.ok) return textResult(`Error: ${result.error}`);
      const compacted = result.value;
      const outcome = compacted.failureSummary
        ? ` Bounded child outcome: ${completeOrOmittedText(compacted.failureSummary, 96)}`
        : '';
      return textResult(
        `Requested manual compaction for ${compacted.agentId} (${compacted.status}).${outcome}`,
        compacted,
      );
    },
    label: 'Compact Agent Conversation',
    name: 'agent_compact',
    parameters: Type.Object({ agentId: managerId() }, { additionalProperties: false }),
    preview: (args) => [{ name: 'agentId', value: args.agentId }],
    promptSnippet: 'Manually compact one attached-idle Pardes child conversation',
  });

  registerPardesTool(pi, {
    description:
      'Refresh one attached-idle child extension while preserving its managed worktree and retained conversation and sending no prompt. This is not manager plugin /reload and is not agent_revive or automatic revival.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.reloadAgent(params.agentId, ctx));
      return result.ok
        ? textResult(
            `Refreshed child extension for ${result.value.agentId} (${result.value.status}); retained conversation and managed worktree preserved; sent no prompt.`,
            result.value,
          )
        : textResult(`Error: ${result.error}`);
    },
    label: 'Refresh Agent Child Extension',
    name: 'agent_reload',
    parameters: Type.Object({ agentId: managerId() }, { additionalProperties: false }),
    preview: (args) => [{ name: 'agentId', value: args.agentId }],
    promptSnippet: 'Refresh one attached-idle Pardes child extension without sending a prompt',
  });

  registerPardesTool(pi, {
    description:
      'Relaunch a stopped or crashed Pardes worker in its preserved worktree and persisted Pi conversation, then send a new briefing.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.reviveAgent(params.agentId, params.message, ctx));
      return result.ok
        ? textResult(`Revived ${params.agentId} (${result.value.status}).`, result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Revive Agent',
    name: 'agent_revive',
    parameters: Type.Object(
      {
        agentId: managerId(),
        message: Type.String({
          description: 'New briefing delivered after the retained session resumes',
          maxLength: MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
          minLength: 1,
        }),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'agentId', value: args.agentId },
      { mode: 'length', name: 'message', value: args.message },
    ],
    promptSnippet: 'Revive a stopped Pardes worker with its retained conversation',
  });

  registerPardesTool(pi, {
    description:
      'Stop a persistent Pardes worker subprocess while preserving its managed worktree.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.stopAgent(params.agentId, ctx));
      return result.ok
        ? textResult(
            `Stopped ${params.agentId}; managed worktree preserved.${stopAuditWarning(result.value)}`,
            result.value,
          )
        : textResult(`Error: ${result.error}`);
    },
    label: 'Stop Agent',
    name: 'agent_stop',
    parameters: Type.Object({ agentId: managerId() }, { additionalProperties: false }),
    preview: (args) => [{ name: 'agentId', value: args.agentId }],
    promptSnippet: 'Stop a Pardes worker while preserving its Git worktree',
  });

  registerPardesTool(pi, {
    description:
      'Inspect or explicitly clean one stopped/crashed retained managed lease. Cleanup removes safe clean artifacts, preserves unmerged branch history by default, preserves Pi session metadata as history-only, and disables revival. Dirty discard and unmerged-history deletion require separate explicit force intent. Rejects attached workers and unresolved open review owners.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.cleanupAgentLease(params, ctx));
      return result.ok
        ? textResult(agentLeaseCleanupLines(result.value), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Inspect or Clean Retained Agent Lease',
    name: 'agent_lease_cleanup',
    parameters: Type.Object(
      {
        action: Type.Union([Type.Literal('inspect'), Type.Literal('cleanup')], {
          description: 'Inspect without mutation, or explicitly perform cleanup.',
        }),
        agentId: managerId(),
        forceDeleteUnmergedBranch: Type.Optional(
          Type.Boolean({
            description:
              'Explicitly delete unmerged managed branch history during cleanup. Never implied.',
          }),
        ),
        forceDiscardDirty: Type.Optional(
          Type.Boolean({
            description: 'Explicitly discard dirty worktree content during cleanup. Never implied.',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'agentId', value: args.agentId },
      { name: 'action', value: args.action },
      { name: 'forceDiscardDirty', value: args.forceDiscardDirty },
      { name: 'forceDeleteUnmergedBranch', value: args.forceDeleteUnmergedBranch },
    ],
    promptSnippet:
      'Inspect or explicitly clean one stopped Pardes managed lease with conservative Git retention',
  });
}
