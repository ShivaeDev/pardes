import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ManagerController } from '../manager/index.ts';
import {
  MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
  MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH,
} from '../manager/index.ts';
import { verificationStatusLines } from './projections/verifications.ts';
import { managerId, registerPardesTool, runTool, textResult } from './registration.ts';

export function registerVerificationTools(pi: ExtensionAPI, manager: ManagerController): void {
  registerPardesTool(pi, {
    description:
      'Audit one source managed worker, refuse dirty or unverifiable state, capture its immutable head, create a fresh manager-namespaced detached review scratch checkout, and launch a retained advisory verifier. The verifier is instructed to inspect the whole requested risk surface, consolidate all currently known blockers, concerns, and notes in one bounded durable report, include bounded reproduction reasoning, distinguish confidence from completeness limitations, and avoid serial finding drip-feed when one pass can discover the findings. The verifier has Bash but no edit/write UI affordances; Bash can mutate files and same-user filesystem access is not isolation. Pardes never publishes verifier commits, this does not gate or publish a pull request, and the manager retains judgment.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.requestVerification(params, ctx));
      return result.ok
        ? textResult(verificationStatusLines(result.value, manager.snapshot()), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Request Advisory Verification',
    name: 'verification_request',
    parameters: Type.Object(
      {
        model: Type.Optional(
          Type.String({ maxLength: MANAGER_INPUT_SHORT_TEXT_MAX_LENGTH, minLength: 1 }),
        ),
        sourceAgentId: managerId('Source writing-worker identity'),
        task: Type.Optional(
          Type.String({
            description:
              'Optional bounded requested risk surface. The verifier still inspects that whole surface and relevant diff context before a terminal report.',
            maxLength: MANAGER_INPUT_LONG_TEXT_MAX_LENGTH,
            minLength: 1,
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Union([
            Type.Literal('off'),
            Type.Literal('minimal'),
            Type.Literal('low'),
            Type.Literal('medium'),
            Type.Literal('high'),
            Type.Literal('xhigh'),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    preview: (args) => [
      { name: 'sourceAgentId', value: args.sourceAgentId },
      { mode: 'length', name: 'task', value: args.task },
      { name: 'model', value: args.model },
      { name: 'thinkingLevel', value: args.thinkingLevel },
    ],
    promptSnippet:
      'Launch one independent comprehensive advisory verifier in disposable scratch space for a clean managed worker head',
  });

  registerPardesTool(pi, {
    description:
      "Recheck one retained verifier against its associated source worker's latest clean immutable HEAD. Requires the verifier runtime to be attached and idle, force-discards only disposable verifier-checkout mutations, preserves the verifier Pi conversation, marks prior evidence stale, appends an attempt, and relaunches that same verifier identity with the comprehensive one-pass reporting protocol. Refuses resolved terminal writer review loops: request a new verification instead, unless an associated review loop remains open. Never discards writer changes; retained advisory evidence remains subject to manager judgment.",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.refreshVerification(params, ctx));
      return result.ok
        ? textResult(verificationStatusLines(result.value, manager.snapshot()), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Refresh Advisory Verification',
    name: 'verification_refresh',
    parameters: Type.Object(
      { verificationId: managerId('Known advisory verification id') },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'verificationId', value: args.verificationId }],
    promptSnippet:
      "Refresh one idle retained advisory verifier against its source worker's latest clean HEAD",
  });

  registerPardesTool(pi, {
    description:
      'Retrieve one bounded advisory verification projection and re-check whether its captured evidence became stale because the source head, source cleanliness, or detached review checkout changed.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await runTool(manager.verificationStatus(params, ctx));
      return result.ok
        ? textResult(verificationStatusLines(result.value, manager.snapshot()), result.value)
        : textResult(`Error: ${result.error}`);
    },
    label: 'Get Advisory Verification Status',
    name: 'verification_status',
    parameters: Type.Object(
      { verificationId: managerId('Known advisory verification id') },
      { additionalProperties: false },
    ),
    preview: (args) => [{ name: 'verificationId', value: args.verificationId }],
    promptSnippet: 'Read one bounded advisory verification status and refresh evidence staleness',
  });
}
