import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Effect } from 'effect';
import { Type } from 'typebox';
import { type FeedbackProvenance, type FeedbackRole, PARDES_VERSION } from './schemas.ts';
import { submitFeedback } from './store.ts';

export const FEEDBACK_TOOL_DESCRIPTION =
  'If anything is frustrating, confusing, broken, annoying, or wasteful, write it here.';

export const FEEDBACK_PROMPT_GUIDANCE = `${FEEDBACK_TOOL_DESCRIPTION} Describe it in your own bounded words; do not dump logs, files, environment values, or secrets.`;

export const feedbackToolParameters = Type.Object(
  {
    text: Type.String({
      description:
        'Free-form description of anything frustrating, confusing, broken, annoying, or wasteful.',
      minLength: 1,
    }),
  },
  { additionalProperties: false },
);

export interface FeedbackSource {
  readonly agentId?: string;
  readonly managerId?: string;
  readonly repositoryKey?: string;
  readonly role: FeedbackRole;
  readonly verificationId?: string;
  readonly workstreamId?: string;
}

function boundedIdentity(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const bounded = value.slice(0, 512);
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

export function feedbackProvenance(
  source: FeedbackSource,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): FeedbackProvenance {
  const sessionId = boundedIdentity(ctx.sessionManager.getSessionId());
  const agentId = boundedIdentity(source.agentId);
  const managerId = boundedIdentity(source.managerId);
  const repositoryKey = boundedIdentity(source.repositoryKey);
  const verificationId = boundedIdentity(source.verificationId);
  const workstreamId = boundedIdentity(source.workstreamId);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(managerId === undefined ? {} : { managerId }),
    pardesVersion: PARDES_VERSION,
    ...(repositoryKey === undefined ? {} : { repositoryKey }),
    role: source.role,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(verificationId === undefined ? {} : { verificationId }),
    ...(workstreamId === undefined ? {} : { workstreamId }),
  };
}

export async function executeFeedbackTool(
  text: string,
  source: FeedbackSource,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): Promise<{ readonly id: string }> {
  const submission = await Effect.runPromise(submitFeedback(text, feedbackProvenance(source, ctx)));
  return { id: submission.id };
}

/** Read only Pardes-owned provenance variables set explicitly by the parent manager process. */
export function childFeedbackSourceFromEnvironment(
  environment: NodeJS.ProcessEnv,
  role: Exclude<FeedbackRole, 'manager'>,
): FeedbackSource {
  const agentId = environment.PARDES_FEEDBACK_AGENT_ID;
  const managerId = environment.PARDES_FEEDBACK_MANAGER_ID;
  const repositoryKey = environment.PARDES_FEEDBACK_REPOSITORY_KEY;
  const verificationId = environment.PARDES_FEEDBACK_VERIFICATION_ID;
  const workstreamId = environment.PARDES_FEEDBACK_WORKSTREAM_ID;
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(managerId === undefined ? {} : { managerId }),
    ...(repositoryKey === undefined ? {} : { repositoryKey }),
    role,
    ...(verificationId === undefined ? {} : { verificationId }),
    ...(workstreamId === undefined ? {} : { workstreamId }),
  };
}
