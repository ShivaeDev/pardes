export const WORKER_TOOLS =
  'read,bash,edit,write,grep,find,ls,feedback,report_to_manager,ask_manager';
export const VERIFIER_TOOLS =
  'read,bash,grep,find,ls,feedback,verification_evidence,report_to_manager,ask_manager';

// Calibrated mirror of reporting write policy. Keep these literals inside the
// intentionally narrow immutable child-runtime snapshot and cover alignment in tests.
export const CHILD_REPORT_SUMMARY_MAX_CHARS = 4_000;
export const CHILD_REPORT_DETAILS_MAX_CHARS = 4 * 1_024 * 1_024;

// Calibrated mirror of manager durable-inbox detail policy. The worst-case
// JSON-escaped question plus context remains beneath the manager event cap.
export const CHILD_QUESTION_MAX_CHARS = 32 * 1_024;
export const CHILD_QUESTION_CONTEXT_MAX_CHARS = 128 * 1_024;

const FULL_COMMIT_SHA = /^[0-9a-f]{40,64}$/;

export interface WorkerChildProfile {
  readonly type: 'worker';
}

export interface VerifierChildProfile {
  readonly type: 'verifier';
  readonly reviewBaselineSha: string;
  readonly reviewedHeadSha: string;
}

export type ChildLaunchProfile = WorkerChildProfile | VerifierChildProfile;

export const WORKER_CHILD_PROFILE: WorkerChildProfile = { type: 'worker' };

export function verifierChildProfile(
  reviewBaselineSha: string,
  reviewedHeadSha: string,
): VerifierChildProfile {
  return { reviewBaselineSha, reviewedHeadSha, type: 'verifier' };
}

export function childProfileTools(profile: ChildLaunchProfile = WORKER_CHILD_PROFILE): string {
  return profile.type === 'verifier' ? VERIFIER_TOOLS : WORKER_TOOLS;
}

export function childProfileEnvironment(
  profile: ChildLaunchProfile = WORKER_CHILD_PROFILE,
): NodeJS.ProcessEnv {
  return profile.type === 'verifier'
    ? {
        PARDES_AGENT_PROFILE: 'verifier',
        PARDES_VERIFICATION_BASELINE_SHA: profile.reviewBaselineSha,
        PARDES_VERIFICATION_REVIEWED_SHA: profile.reviewedHeadSha,
      }
    : {
        PARDES_AGENT_PROFILE: 'worker',
        PARDES_VERIFICATION_BASELINE_SHA: undefined,
        PARDES_VERIFICATION_REVIEWED_SHA: undefined,
      };
}

function requireVerificationSha(name: string, value: string | undefined): string {
  if (!value || !FULL_COMMIT_SHA.test(value))
    throw new Error(`${name} is required for the Pardes verifier profile.`);
  return value;
}

export function childProfileFromEnvironment(environment: NodeJS.ProcessEnv): ChildLaunchProfile {
  const profile = environment.PARDES_AGENT_PROFILE ?? 'worker';
  if (profile === 'worker') return WORKER_CHILD_PROFILE;
  if (profile !== 'verifier') throw new Error(`Unknown Pardes child profile: ${profile}`);
  return verifierChildProfile(
    requireVerificationSha(
      'PARDES_VERIFICATION_BASELINE_SHA',
      environment.PARDES_VERIFICATION_BASELINE_SHA,
    ),
    requireVerificationSha(
      'PARDES_VERIFICATION_REVIEWED_SHA',
      environment.PARDES_VERIFICATION_REVIEWED_SHA,
    ),
  );
}
