import { Data, type Duration, Effect, Option, Schema } from 'effect';
import { decodeGitHubJson } from './codecs.ts';
import { type GitHubCommandError, GitHubResponseError } from './errors.ts';
import {
  GITHUB_HOSTED_METADATA_HOSTNAME,
  type GitHubHostedMetadataShape,
  type GitHubRateLimitHealth,
  type GitHubRepositoryIdentity,
  makeGitHubHostedMetadataAdapter,
} from './hosted-metadata.ts';
import {
  GitHubAdvertisedDefaultBranchGraphQLSchema,
  type GitHubHostedCheckContext,
  GitHubHostedChecksGraphQLSchema,
  GitHubIntegrationHealthAssociationSchema,
  GitHubPullRequestHealthMetadataSchema,
  MAX_GITHUB_HOSTED_CHECKS,
  MAX_GITHUB_INTEGRATION_HEALTH_PULL_REQUESTS,
} from './schemas.ts';
import {
  type GitHubCommandRunnerShape,
  makeExecFileGitHubCommandRunner,
  makeGitHubCli,
} from './transport.ts';

const ADVERTISED_DEFAULT_BRANCH_GRAPHQL_QUERY =
  'query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){defaultBranchRef{name target{oid}}} rateLimit{cost limit remaining resetAt}}';
const HOSTED_CHECKS_GRAPHQL_QUERY =
  'query($owner:String!,$repo:String!,$expression:String!,$limit:Int!){repository(owner:$owner,name:$repo){object(expression:$expression){... on Commit{oid statusCheckRollup{contexts(first:$limit){nodes{__typename ... on CheckRun{status conclusion checkSuite{workflowRun{workflow{databaseId}}}} ... on StatusContext{state}} pageInfo{hasNextPage}}}}}} rateLimit{cost limit remaining resetAt}}';
const PULL_REQUEST_HEALTH_JSON_FIELDS = 'number,headRefOid';
const FAILED_CHECK_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);
const PASSING_CHECK_CONCLUSIONS = new Set(['NEUTRAL', 'SKIPPED', 'SUCCESS']);
const PENDING_CHECK_STATUSES = new Set([
  'EXPECTED',
  'IN_PROGRESS',
  'PENDING',
  'QUEUED',
  'REQUESTED',
  'WAITING',
]);
const SAFE_PROJECTION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,100}$/;

type GitHubIntegrationHealthInspectError = GitHubCommandError | GitHubResponseError;
type CheckState = 'unknown' | 'pending' | 'passing' | 'failing';

export const GITHUB_INTEGRATION_HEALTH_MAX_PULL_REQUESTS =
  MAX_GITHUB_INTEGRATION_HEALTH_PULL_REQUESTS;
export const GITHUB_INTEGRATION_HEALTH_MAX_HOSTED_CHECKS = MAX_GITHUB_HOSTED_CHECKS;
export const DEFAULT_GITHUB_INTEGRATION_HEALTH_COMMAND_TIMEOUT: Duration.Input = '10 seconds';

export type GitHubIntegrationHealthIssue =
  | 'command_failed'
  | 'response_invalid'
  | 'timed_out'
  | 'default_branch_missing'
  | 'checks_ref_missing'
  | 'association_invalid'
  | 'unsupported_route';
export type GitHubHostedCheckCi = CheckState;
export type GitHubHostedCheckRelation = 'current' | 'stale';
export type GitHubHostedCheckCompleteness = 'complete' | 'partial';
export type GitHubHostedCheckCountAccuracy = 'exact' | 'lower_bound';
export type GitHubPullRequestHeadRelation = 'current' | 'diverged' | 'unavailable';

export type GitHubHostedChecksObservation =
  | {
      readonly availability: 'available';
      readonly headSha: string;
      readonly relation: GitHubHostedCheckRelation;
      readonly completeness: GitHubHostedCheckCompleteness;
      readonly ci: GitHubHostedCheckCi;
      readonly observedCheckCount: number;
      readonly observedFailingCheckCount: number;
      readonly countAccuracy: GitHubHostedCheckCountAccuracy;
    }
  | { readonly availability: 'none' }
  | { readonly availability: 'unavailable'; readonly issue: GitHubIntegrationHealthIssue };

export type GitHubDefaultBranchIntegrationHealth =
  | {
      readonly availability: 'available';
      readonly defaultBranch: string;
      readonly advertisedHeadSha: string;
      readonly hostedChecks: GitHubHostedChecksObservation;
    }
  | { readonly availability: 'unavailable'; readonly issue: GitHubIntegrationHealthIssue };

export interface GitHubPullRequestIntegrationHealthAssociation {
  readonly id: string;
  readonly url: string;
  readonly number?: number;
  readonly lastPushedHeadSha?: string;
  readonly headBranch?: string;
}

export interface GitHubPullRequestIntegrationHealth {
  readonly id: string;
  readonly number?: number;
  readonly auditedHeadSha?: string;
  readonly observedHeadSha?: string;
  readonly pullRequestHead: GitHubPullRequestHeadRelation;
  readonly hostedChecks: GitHubHostedChecksObservation;
  readonly sharedFailingWorkflowCount: number;
}

export interface GitHubIntegrationHealthInspection {
  readonly observation: 'opt_in_read_only_hosted_metadata';
  readonly defaultBranch: GitHubDefaultBranchIntegrationHealth;
  readonly pullRequests: ReadonlyArray<GitHubPullRequestIntegrationHealth>;
  readonly inspectedPullRequestCount: number;
  readonly omittedPullRequestCount: number;
  readonly bounds: {
    readonly maxPullRequests: number;
    readonly maxHostedChecksPerRef: number;
  };
  readonly rateLimit: GitHubRateLimitHealth;
}

export interface InspectGitHubIntegrationHealthInput {
  readonly cwd: string;
  readonly pullRequests: ReadonlyArray<GitHubPullRequestIntegrationHealthAssociation>;
}

export interface GitHubIntegrationHealthShape {
  /** Explicit network inspection only. This port is never used by background watchers or cheap summaries. */
  readonly inspect: (
    input: InspectGitHubIntegrationHealthInput,
  ) => Effect.Effect<GitHubIntegrationHealthInspection>;
}

interface InternalHostedChecksObservation {
  readonly projection: GitHubHostedChecksObservation;
  readonly failingWorkflowIds: ReadonlySet<number>;
}

interface InternalDefaultBranchIntegrationHealth {
  readonly projection: GitHubDefaultBranchIntegrationHealth;
  readonly failingWorkflowIds: ReadonlySet<number>;
}

class GitHubIntegrationHealthTimeoutError extends Data.TaggedError(
  'GitHubIntegrationHealthTimeoutError',
)<{
  readonly timeout: Duration.Input;
}> {}

type GitHubIntegrationHealthCommandError =
  | GitHubIntegrationHealthInspectError
  | GitHubIntegrationHealthTimeoutError;

function issue(error: GitHubIntegrationHealthCommandError): GitHubIntegrationHealthIssue {
  if (error._tag === 'GitHubIntegrationHealthTimeoutError') return 'timed_out';
  if (
    error._tag === 'GitHubResponseError' &&
    error.operation.startsWith('enforce fixed github.com route')
  )
    return 'unsupported_route';
  return error._tag === 'GitHubCommandError' ? 'command_failed' : 'response_invalid';
}

function unavailableHostedChecks(
  value: GitHubIntegrationHealthIssue,
): InternalHostedChecksObservation {
  return {
    failingWorkflowIds: new Set(),
    projection: { availability: 'unavailable', issue: value },
  };
}

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status !== 'COMPLETED') return PENDING_CHECK_STATUSES.has(status) ? 'pending' : 'unknown';
  if (conclusion !== null && FAILED_CHECK_CONCLUSIONS.has(conclusion)) return 'failing';
  if (conclusion !== null && PASSING_CHECK_CONCLUSIONS.has(conclusion)) return 'passing';
  return 'unknown';
}

function checkState(check: GitHubHostedCheckContext): CheckState {
  if (check.__typename === 'CheckRun') return checkRunState(check.status, check.conclusion);
  if (check.state === 'ERROR' || check.state === 'FAILURE') return 'failing';
  if (check.state === 'EXPECTED' || check.state === 'PENDING') return 'pending';
  return check.state === 'SUCCESS' ? 'passing' : 'unknown';
}

function hostedCheckCi(states: ReadonlyArray<CheckState>, partial: boolean): GitHubHostedCheckCi {
  if (states.includes('failing')) return 'failing';
  if (partial || states.includes('unknown')) return 'unknown';
  return states.includes('pending') ? 'pending' : 'passing';
}

function failingWorkflowIds(checks: ReadonlyArray<GitHubHostedCheckContext>): ReadonlySet<number> {
  return new Set(
    checks.flatMap((check) => {
      if (check.__typename !== 'CheckRun' || checkState(check) !== 'failing') return [];
      const workflowId = check.checkSuite.workflowRun?.workflow?.databaseId;
      return workflowId === null || workflowId === undefined ? [] : [workflowId];
    }),
  );
}

function projectHostedChecks(
  decoded: typeof GitHubHostedChecksGraphQLSchema.Type,
  referenceHeadSha: string,
): InternalHostedChecksObservation {
  const commit = decoded.data.repository.object;
  if (commit === null) return unavailableHostedChecks('checks_ref_missing');
  const rollup = commit.statusCheckRollup;
  if (rollup === null)
    return { failingWorkflowIds: new Set(), projection: { availability: 'none' } };
  const checks = rollup.contexts.nodes;
  const partial = rollup.contexts.pageInfo.hasNextPage;
  const states = checks.map(checkState);
  return {
    failingWorkflowIds: failingWorkflowIds(checks),
    projection: {
      availability: 'available',
      ci: hostedCheckCi(states, partial),
      completeness: partial ? 'partial' : 'complete',
      countAccuracy: partial ? 'lower_bound' : 'exact',
      headSha: commit.oid,
      observedCheckCount: checks.length,
      observedFailingCheckCount: states.filter((state) => state === 'failing').length,
      relation: commit.oid === referenceHeadSha ? 'current' : 'stale',
    },
  };
}

function sharedFailureCount(left: ReadonlySet<number>, right: ReadonlySet<number>): number {
  let count = 0;
  for (const workflowId of left) if (right.has(workflowId)) count += 1;
  return count;
}

function canHintSharedFailure(
  defaultBranch: GitHubDefaultBranchIntegrationHealth,
  pullRequest: GitHubPullRequestIntegrationHealth,
): boolean {
  return (
    defaultBranch.availability === 'available' &&
    defaultBranch.hostedChecks.availability === 'available' &&
    defaultBranch.hostedChecks.relation === 'current' &&
    defaultBranch.hostedChecks.completeness === 'complete' &&
    pullRequest.pullRequestHead === 'current' &&
    pullRequest.hostedChecks.availability === 'available' &&
    pullRequest.hostedChecks.relation === 'current' &&
    pullRequest.hostedChecks.completeness === 'complete'
  );
}

function safeProjectionId(value: string): string {
  return SAFE_PROJECTION_ID_PATTERN.test(value) ? value : 'redacted-review';
}

function unavailablePullRequest(
  rawAssociation: GitHubPullRequestIntegrationHealthAssociation,
  value: GitHubIntegrationHealthIssue,
): GitHubPullRequestIntegrationHealth {
  const association = Schema.decodeUnknownOption(GitHubIntegrationHealthAssociationSchema)(
    rawAssociation,
  );
  return {
    id: safeProjectionId(rawAssociation.id),
    ...(Option.isNone(association) || association.value.number === undefined
      ? {}
      : { number: association.value.number }),
    ...(Option.isNone(association) || association.value.lastPushedHeadSha === undefined
      ? {}
      : { auditedHeadSha: association.value.lastPushedHeadSha }),
    hostedChecks: { availability: 'unavailable', issue: value },
    pullRequestHead: 'unavailable',
    sharedFailingWorkflowCount: 0,
  };
}

export function makeGitHubIntegrationHealthService(
  options: {
    readonly runner?: GitHubCommandRunnerShape;
    readonly commandTimeout?: Duration.Input;
    readonly hostedMetadata?: GitHubHostedMetadataShape;
  } = {},
): GitHubIntegrationHealthShape {
  const runner = options.runner ?? makeExecFileGitHubCommandRunner();
  const cli = makeGitHubCli(runner);
  const hostedMetadata = options.hostedMetadata ?? makeGitHubHostedMetadataAdapter({ runner });
  const commandTimeout =
    options.commandTimeout ?? DEFAULT_GITHUB_INTEGRATION_HEALTH_COMMAND_TIMEOUT;
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    cli.run(cwd, args).pipe(
      Effect.timeoutOption(commandTimeout),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new GitHubIntegrationHealthTimeoutError({ timeout: commandTimeout })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const reserveHealthGraphQLRequest = (cwd: string, route: GitHubRepositoryIdentity) =>
    hostedMetadata
      .reserveGraphQLRequest()
      .pipe(
        Effect.catchTag('GitHubResponseError', (error) =>
          error.operation === 'reserve hosted GitHub request'
            ? hostedMetadata
                .recoverRequestCapacity(cwd, route)
                .pipe(Effect.andThen(hostedMetadata.reserveGraphQLRequest()))
            : Effect.fail(error),
        ),
      );

  const hostedChecks = Effect.fnUntraced(function* (
    cwd: string,
    expression: string,
    referenceHeadSha: string,
    route: GitHubRepositoryIdentity,
  ) {
    const decoded = yield* Effect.acquireUseRelease(
      reserveHealthGraphQLRequest(cwd, route),
      (reservation) =>
        Effect.gen(function* () {
          yield* hostedMetadata.launchGraphQLRequest(reservation.id);
          const response = yield* run(cwd, [
            'api',
            'graphql',
            '--hostname',
            GITHUB_HOSTED_METADATA_HOSTNAME,
            '--raw-field',
            `query=${HOSTED_CHECKS_GRAPHQL_QUERY}`,
            '--field',
            `owner=${route.owner}`,
            '--field',
            `repo=${route.repo}`,
            '--field',
            `expression=${expression}`,
            '--field',
            `limit=${MAX_GITHUB_HOSTED_CHECKS}`,
          ]);
          return yield* hostedMetadata.decodeGraphQL(
            'inspect hosted checks',
            GitHubHostedChecksGraphQLSchema,
            response.stdout,
            reservation.id,
          );
        }),
      (reservation) => hostedMetadata.finalizeGraphQLRequest(reservation.id),
    );
    return projectHostedChecks(decoded, referenceHeadSha);
  });

  const observeHostedChecks = (
    cwd: string,
    expression: string,
    referenceHeadSha: string,
    route: GitHubRepositoryIdentity,
  ) =>
    hostedChecks(cwd, expression, referenceHeadSha, route).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(unavailableHostedChecks(issue(error))),
        onSuccess: Effect.succeed,
      }),
    );

  const inspectDefaultBranch = Effect.fnUntraced(function* (
    cwd: string,
    route: GitHubRepositoryIdentity,
  ) {
    const decoded = yield* Effect.acquireUseRelease(
      reserveHealthGraphQLRequest(cwd, route),
      (reservation) =>
        Effect.gen(function* () {
          yield* hostedMetadata.launchGraphQLRequest(reservation.id);
          const response = yield* run(cwd, [
            'api',
            'graphql',
            '--hostname',
            GITHUB_HOSTED_METADATA_HOSTNAME,
            '--raw-field',
            `query=${ADVERTISED_DEFAULT_BRANCH_GRAPHQL_QUERY}`,
            '--field',
            `owner=${route.owner}`,
            '--field',
            `repo=${route.repo}`,
          ]);
          return yield* hostedMetadata.decodeGraphQL(
            'inspect advertised default branch head',
            GitHubAdvertisedDefaultBranchGraphQLSchema,
            response.stdout,
            reservation.id,
          );
        }),
      (reservation) => hostedMetadata.finalizeGraphQLRequest(reservation.id),
    );
    const defaultBranch = decoded.data.repository.defaultBranchRef;
    if (defaultBranch === null) {
      return {
        failingWorkflowIds: new Set<number>(),
        projection: { availability: 'unavailable', issue: 'default_branch_missing' },
      } satisfies InternalDefaultBranchIntegrationHealth;
    }
    const checks = yield* observeHostedChecks(
      cwd,
      defaultBranch.name,
      defaultBranch.target.oid,
      route,
    );
    return {
      failingWorkflowIds: checks.failingWorkflowIds,
      projection: {
        advertisedHeadSha: defaultBranch.target.oid,
        availability: 'available',
        defaultBranch: defaultBranch.name,
        hostedChecks: checks.projection,
      },
    } satisfies InternalDefaultBranchIntegrationHealth;
  });

  const observeDefaultBranch = (cwd: string, route: GitHubRepositoryIdentity) =>
    inspectDefaultBranch(cwd, route).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.succeed({
            failingWorkflowIds: new Set<number>(),
            projection: { availability: 'unavailable', issue: issue(error) },
          } satisfies InternalDefaultBranchIntegrationHealth),
        onSuccess: Effect.succeed,
      }),
    );

  const inspectPullRequest = Effect.fnUntraced(function* (
    cwd: string,
    rawAssociation: GitHubPullRequestIntegrationHealthAssociation,
    defaultBranch: InternalDefaultBranchIntegrationHealth,
    route: GitHubRepositoryIdentity,
  ) {
    const associationOption = Schema.decodeUnknownOption(GitHubIntegrationHealthAssociationSchema)(
      rawAssociation,
    );
    if (Option.isNone(associationOption))
      return unavailablePullRequest(rawAssociation, 'association_invalid');
    const association = associationOption.value;
    const identifier =
      association.number === undefined ? association.url : String(association.number);
    const viewed = yield* hostedMetadata.accountOpaqueRequest(
      'graphql',
      run(cwd, [
        'pr',
        'view',
        identifier,
        '--json',
        PULL_REQUEST_HEALTH_JSON_FIELDS,
        '--repo',
        route.slug,
      ]),
    );
    const pullRequest = yield* decodeGitHubJson(
      'inspect pull request hosted head',
      GitHubPullRequestHealthMetadataSchema,
      viewed.stdout,
    );
    if (association.number !== undefined && pullRequest.number !== association.number) {
      return yield* new GitHubResponseError({
        cause: { expected: association.number, received: pullRequest.number },
        operation: 'verify inspected pull request number',
      });
    }
    const pullRequestHead =
      association.lastPushedHeadSha === undefined
        ? ('unavailable' as const)
        : association.lastPushedHeadSha === pullRequest.headRefOid
          ? ('current' as const)
          : ('diverged' as const);
    const checks = yield* observeHostedChecks(
      cwd,
      association.headBranch ?? pullRequest.headRefOid,
      pullRequest.headRefOid,
      route,
    );
    const projected = {
      id: safeProjectionId(association.id),
      ...(association.number === undefined ? {} : { number: association.number }),
      ...(association.lastPushedHeadSha === undefined
        ? {}
        : { auditedHeadSha: association.lastPushedHeadSha }),
      hostedChecks: checks.projection,
      observedHeadSha: pullRequest.headRefOid,
      pullRequestHead,
      sharedFailingWorkflowCount: 0,
    } satisfies GitHubPullRequestIntegrationHealth;
    return canHintSharedFailure(defaultBranch.projection, projected)
      ? {
          ...projected,
          sharedFailingWorkflowCount: sharedFailureCount(
            defaultBranch.failingWorkflowIds,
            checks.failingWorkflowIds,
          ),
        }
      : projected;
  });

  const observePullRequest = (
    cwd: string,
    association: GitHubPullRequestIntegrationHealthAssociation,
    defaultBranch: InternalDefaultBranchIntegrationHealth,
    route: GitHubRepositoryIdentity,
  ) =>
    inspectPullRequest(cwd, association, defaultBranch, route).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(unavailablePullRequest(association, issue(error))),
        onSuccess: Effect.succeed,
      }),
    );

  const inspect: GitHubIntegrationHealthShape['inspect'] = Effect.fnUntraced(function* (input) {
    const selectedPullRequests = input.pullRequests.slice(
      0,
      MAX_GITHUB_INTEGRATION_HEALTH_PULL_REQUESTS,
    );
    const routeResult =
      input.cwd.trim().length === 0
        ? ({ _tag: 'Failure', issue: 'command_failed' } as const)
        : yield* hostedMetadata
            .fixedRoute(
              input.cwd,
              selectedPullRequests.map(({ url }) => url),
            )
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'Failure' as const, issue: issue(error) }),
                onSuccess: (route) => ({ _tag: 'Success' as const, route }),
              }),
            );
    const defaultBranch =
      routeResult._tag === 'Failure'
        ? ({
            failingWorkflowIds: new Set<number>(),
            projection: { availability: 'unavailable', issue: routeResult.issue },
          } satisfies InternalDefaultBranchIntegrationHealth)
        : yield* observeDefaultBranch(input.cwd, routeResult.route);
    const pullRequests =
      routeResult._tag === 'Failure'
        ? selectedPullRequests.map((association) =>
            unavailablePullRequest(association, routeResult.issue),
          )
        : yield* Effect.forEach(selectedPullRequests, (association) =>
            observePullRequest(input.cwd, association, defaultBranch, routeResult.route),
          );
    const rateLimit = yield* hostedMetadata.snapshot();
    return {
      bounds: {
        maxHostedChecksPerRef: MAX_GITHUB_HOSTED_CHECKS,
        maxPullRequests: MAX_GITHUB_INTEGRATION_HEALTH_PULL_REQUESTS,
      },
      defaultBranch: defaultBranch.projection,
      inspectedPullRequestCount: pullRequests.length,
      observation: 'opt_in_read_only_hosted_metadata',
      omittedPullRequestCount: Math.max(0, input.pullRequests.length - selectedPullRequests.length),
      pullRequests,
      rateLimit,
    };
  });

  return { inspect };
}
