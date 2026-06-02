import { Schema } from 'effect';

export const PULL_REQUEST_TITLE_MAX_LENGTH = 256;
export const PULL_REQUEST_BODY_MAX_LENGTH = 10_000;
export const PULL_REQUEST_BRANCH_MAX_LENGTH = 255;
export const PULL_REQUEST_BRANCH_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._/-]*$';
export const PUBLISHED_REVIEW_BRANCH_PREFIX = 'pardes/review/';
export const READABLE_PUBLISHED_REVIEW_BRANCH_PREFIX = `${PUBLISHED_REVIEW_BRANCH_PREFIX}readable-`;
/** Retained source-compatible alias for the namespace used by schema-v1 opaque reservations. */
export const OPAQUE_PUBLISHED_REVIEW_BRANCH_PREFIX = PUBLISHED_REVIEW_BRANCH_PREFIX;
/** Schema-v1 reservations used an opaque UUID after the shared review namespace. */
export const OPAQUE_PUBLISHED_REVIEW_BRANCH_PATTERN =
  '^pardes/review/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const READABLE_PUBLISHED_REVIEW_BRANCH_PATTERN =
  '^pardes/review/readable-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/** Accepted so durable reservations written before readable refs became flat remain reusable. */
export const NESTED_READABLE_PUBLISHED_REVIEW_BRANCH_PATTERN =
  '^pardes/review/readable/[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const HUMAN_PUBLISHED_REVIEW_BRANCH_PATTERN =
  '^[a-z0-9]+(?:-[a-z0-9]+)*/pardes/[a-z0-9]+(?:-[a-z0-9]+)*$';
export const FLAT_FALLBACK_PUBLISHED_REVIEW_BRANCH_PATTERN =
  '^[a-z0-9]+(?:-[a-z0-9]+)*-pardes-[a-z0-9]+(?:-[a-z0-9]+)*$';
export const PULL_REQUEST_URL_MAX_LENGTH = 2_048;
export const MAX_GITHUB_STATUS_CHECKS = 200;
export const MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE = 100;
export const MAX_GITHUB_INTEGRATION_HEALTH_PULL_REQUESTS = 12;
export const MAX_GITHUB_HOSTED_CHECKS = 50;
export const GITHUB_DISCUSSION_BODY_MAX_LENGTH = 65_536;
export const GITHUB_DISCUSSION_AUTHOR_MAX_LENGTH = 100;
export const GITHUB_DISCUSSION_PREVIEW_MAX_LENGTH = 160;

export const GitHubDiscussionSurfaceSchema = Schema.Literals([
  'issue_comment',
  'review',
  'inline_review_comment',
]);
export type GitHubDiscussionSurface = typeof GitHubDiscussionSurfaceSchema.Type;
export const GitHubDiscussionPaginationGapsSchema = Schema.Array(
  GitHubDiscussionSurfaceSchema,
).check(Schema.isMaxLength(3));

const NonEmptyStringSchema = Schema.String.check(Schema.isMinLength(1));
const PositiveIntegerSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const BoundedDiscussionBodySchema = Schema.String.check(
  Schema.isMaxLength(GITHUB_DISCUSSION_BODY_MAX_LENGTH),
);
const GitHubDiscussionAuthorSchema = Schema.Union([
  Schema.Struct({
    login: NonEmptyStringSchema.check(Schema.isMaxLength(GITHUB_DISCUSSION_AUTHOR_MAX_LENGTH)),
  }),
  Schema.Null,
]);

export const PullRequestTitleSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(PULL_REQUEST_TITLE_MAX_LENGTH),
);
export const PullRequestBodySchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(PULL_REQUEST_BODY_MAX_LENGTH),
);
export const PullRequestBranchSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(PULL_REQUEST_BRANCH_MAX_LENGTH),
  Schema.isPattern(new RegExp(PULL_REQUEST_BRANCH_PATTERN)),
);
export const PullRequestUrlSchema = NonEmptyStringSchema.check(
  Schema.isMaxLength(PULL_REQUEST_URL_MAX_LENGTH),
  Schema.isPattern(/^https?:\/\/[^\s]+$/),
);

const FullCommitShaSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/));
const OpaquePublishedReviewBranchPattern = new RegExp(OPAQUE_PUBLISHED_REVIEW_BRANCH_PATTERN);
const ReadablePublishedReviewBranchPattern = new RegExp(READABLE_PUBLISHED_REVIEW_BRANCH_PATTERN);
const NestedReadablePublishedReviewBranchPattern = new RegExp(
  NESTED_READABLE_PUBLISHED_REVIEW_BRANCH_PATTERN,
);
const HumanPublishedReviewBranchPattern = new RegExp(HUMAN_PUBLISHED_REVIEW_BRANCH_PATTERN);
const FlatFallbackPublishedReviewBranchPattern = new RegExp(
  FLAT_FALLBACK_PUBLISHED_REVIEW_BRANCH_PATTERN,
);
export const OpaquePublishedReviewBranchSchema = PullRequestBranchSchema.check(
  Schema.isPattern(OpaquePublishedReviewBranchPattern),
);
export const ReadablePublishedReviewBranchSchema = Schema.Union([
  PullRequestBranchSchema.check(Schema.isPattern(ReadablePublishedReviewBranchPattern)),
  PullRequestBranchSchema.check(Schema.isPattern(NestedReadablePublishedReviewBranchPattern)),
]);
export const HumanPublishedReviewBranchSchema = Schema.Union([
  PullRequestBranchSchema.check(Schema.isPattern(HumanPublishedReviewBranchPattern)),
  PullRequestBranchSchema.check(Schema.isPattern(FlatFallbackPublishedReviewBranchPattern)),
]);
/** Human-owned refs, prior readable reservations, and schema-v1 opaque reservations are manager-owned. */
export const ManagedPublishedReviewBranchSchema = Schema.Union([
  HumanPublishedReviewBranchSchema,
  ReadablePublishedReviewBranchSchema,
  OpaquePublishedReviewBranchSchema,
]);
/** Accepted only for conservative compatibility with review gates published before managed publication refs. */
const LegacyPublishedReviewBranchSchema = PullRequestBranchSchema.check(
  Schema.isPattern(
    /^pardes\/(?![a-zA-Z0-9._-]*\.\.)(?![a-zA-Z0-9._-]*\.lock\/)[a-zA-Z0-9_-](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?\/(?![a-zA-Z0-9._-]*\.\.)(?![a-zA-Z0-9._-]*\.lock$)[a-zA-Z0-9_-](?:[a-zA-Z0-9._-]*[a-zA-Z0-9_-])?$/,
  ),
);
export const PersistedPublishedReviewBranchSchema = Schema.Union([
  ManagedPublishedReviewBranchSchema,
  LegacyPublishedReviewBranchSchema,
]);
const GitHubPullRequestStateSchema = Schema.Literals(['OPEN', 'CLOSED', 'MERGED']);

export function isOpaquePublishedReviewBranch(value: string): boolean {
  return OpaquePublishedReviewBranchPattern.test(value);
}

export function isHumanPublishedReviewBranch(value: string): boolean {
  return (
    HumanPublishedReviewBranchPattern.test(value) ||
    FlatFallbackPublishedReviewBranchPattern.test(value)
  );
}

export function isManagedPublishedReviewBranch(value: string): boolean {
  return (
    isOpaquePublishedReviewBranch(value) ||
    ReadablePublishedReviewBranchPattern.test(value) ||
    NestedReadablePublishedReviewBranchPattern.test(value) ||
    isHumanPublishedReviewBranch(value)
  );
}

export const PublishedReviewBranchCandidatesInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  disambiguator: NonEmptyStringSchema,
  fallbackDisambiguator: NonEmptyStringSchema,
  workstreamTitle: NonEmptyStringSchema,
});

export const ReservePublishedReviewBranchInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  headBranch: HumanPublishedReviewBranchSchema,
  headSha: FullCommitShaSchema,
  ownershipId: NonEmptyStringSchema,
});

export const ReleasePublishedReviewBranchClaimInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  headSha: FullCommitShaSchema,
  ownershipId: NonEmptyStringSchema,
});

export const PublishPullRequestInputSchema = Schema.Struct({
  baseBranch: PullRequestBranchSchema,
  body: PullRequestBodySchema,
  cwd: NonEmptyStringSchema,
  headBranch: PersistedPublishedReviewBranchSchema,
  headSha: FullCommitShaSchema,
  legacyExistingPullRequestNumber: Schema.optionalKey(PositiveIntegerSchema),
  openInBrowser: Schema.optionalKey(Schema.Boolean),
  title: PullRequestTitleSchema,
});

export const SyncExistingPullRequestInputSchema = Schema.Struct({
  cwd: NonEmptyStringSchema,
  headBranch: PersistedPublishedReviewBranchSchema,
  headSha: FullCommitShaSchema,
  pullRequestNumber: PositiveIntegerSchema,
});

export const GitHubOpenGateListSchema = Schema.Array(
  Schema.Struct({
    baseRefName: PullRequestBranchSchema,
    headRefName: PullRequestBranchSchema,
    number: PositiveIntegerSchema,
  }),
);

export const GitHubSyncExistingPullRequestSchema = Schema.Struct({
  headRefName: PullRequestBranchSchema,
  number: PositiveIntegerSchema,
  state: GitHubPullRequestStateSchema,
});

export const GitHubPublicationMetadataSchema = Schema.Struct({
  baseRefName: PullRequestBranchSchema,
  headRefName: PullRequestBranchSchema,
  headRefOid: FullCommitShaSchema,
  isDraft: Schema.Boolean,
  number: PositiveIntegerSchema,
  state: GitHubPullRequestStateSchema,
  url: PullRequestUrlSchema,
});

export const GitHubPushedHeadMetadataSchema = Schema.Struct({
  headRefName: PullRequestBranchSchema,
  headRefOid: FullCommitShaSchema,
  number: PositiveIntegerSchema,
});

export const PullRequestAssociationSchema = Schema.Struct({
  id: NonEmptyStringSchema,
  lastPushedHeadSha: Schema.optionalKey(FullCommitShaSchema),
  number: Schema.optionalKey(PositiveIntegerSchema),
  url: PullRequestUrlSchema,
});

/** Opt-in integration-health association. Persisted review branches remain argv-safe metadata. */
export const GitHubIntegrationHealthAssociationSchema = Schema.Struct({
  headBranch: Schema.optionalKey(PersistedPublishedReviewBranchSchema),
  id: NonEmptyStringSchema,
  lastPushedHeadSha: Schema.optionalKey(FullCommitShaSchema),
  number: Schema.optionalKey(PositiveIntegerSchema),
  url: PullRequestUrlSchema,
});

export const GitHubAdvertisedDefaultBranchGraphQLSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      defaultBranchRef: Schema.Union([
        Schema.Struct({
          name: PullRequestBranchSchema,
          target: Schema.Struct({ oid: FullCommitShaSchema }),
        }),
        Schema.Null,
      ]),
    }),
  }),
});

export const GitHubPullRequestHealthMetadataSchema = Schema.Struct({
  headRefOid: FullCommitShaSchema,
  number: PositiveIntegerSchema,
});

const BoundedHostedCheckMetadata = NonEmptyStringSchema.check(Schema.isMaxLength(100));
const NullableWorkflowSchema = Schema.Union([
  Schema.Struct({ databaseId: Schema.Union([PositiveIntegerSchema, Schema.Null]) }),
  Schema.Null,
]);
const GitHubHostedCheckRunSchema = Schema.Struct({
  __typename: Schema.Literal('CheckRun'),
  checkSuite: Schema.Struct({
    workflowRun: Schema.Union([Schema.Struct({ workflow: NullableWorkflowSchema }), Schema.Null]),
  }),
  conclusion: Schema.Union([BoundedHostedCheckMetadata, Schema.Null]),
  status: BoundedHostedCheckMetadata,
});
const GitHubHostedStatusContextSchema = Schema.Struct({
  __typename: Schema.Literal('StatusContext'),
  state: BoundedHostedCheckMetadata,
});
export const GitHubHostedCheckContextSchema = Schema.Union([
  GitHubHostedCheckRunSchema,
  GitHubHostedStatusContextSchema,
]);
export type GitHubHostedCheckContext = typeof GitHubHostedCheckContextSchema.Type;
export const GitHubHostedChecksGraphQLSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      object: Schema.Union([
        Schema.Struct({
          oid: FullCommitShaSchema,
          statusCheckRollup: Schema.Union([
            Schema.Struct({
              contexts: Schema.Struct({
                nodes: Schema.Array(GitHubHostedCheckContextSchema).check(
                  Schema.isMaxLength(MAX_GITHUB_HOSTED_CHECKS),
                ),
                pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
              }),
            }),
            Schema.Null,
          ]),
        }),
        Schema.Null,
      ]),
    }),
  }),
});

const GitHubCheckRunSchema = Schema.Struct({
  conclusion: Schema.Union([
    Schema.Literals([
      '',
      'ACTION_REQUIRED',
      'CANCELLED',
      'FAILURE',
      'NEUTRAL',
      'SKIPPED',
      'STALE',
      'STARTUP_FAILURE',
      'SUCCESS',
      'TIMED_OUT',
    ]),
    Schema.Null,
  ]),
  status: Schema.Literals([
    'COMPLETED',
    'EXPECTED',
    'IN_PROGRESS',
    'PENDING',
    'QUEUED',
    'REQUESTED',
    'WAITING',
  ]),
});

const GitHubStatusContextSchema = Schema.Struct({
  state: Schema.Literals(['ERROR', 'EXPECTED', 'FAILURE', 'PENDING', 'SUCCESS']),
});

export const GitHubPullRequestObservationSchema = Schema.Struct({
  headRefOid: FullCommitShaSchema,
  mergeable: Schema.Literals(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  number: PositiveIntegerSchema,
  reviewDecision: Schema.Union([
    Schema.Literals(['', 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
    Schema.Null,
  ]),
  state: GitHubPullRequestStateSchema,
  statusCheckRollup: Schema.Array(
    Schema.Union([GitHubCheckRunSchema, GitHubStatusContextSchema]),
  ).check(Schema.isMaxLength(MAX_GITHUB_STATUS_CHECKS)),
});

export type GitHubPullRequestObservation = typeof GitHubPullRequestObservationSchema.Type;

const GitHubDiscussionNodeSchema = Schema.Struct({
  author: GitHubDiscussionAuthorSchema,
  body: BoundedDiscussionBodySchema,
  databaseId: PositiveIntegerSchema,
});

const GitHubReviewNodeSchema = Schema.Struct({
  author: GitHubDiscussionAuthorSchema,
  body: BoundedDiscussionBodySchema,
  databaseId: PositiveIntegerSchema,
  submittedAt: Schema.Union([NonEmptyStringSchema, Schema.Null]),
});

/** Bounded GraphQL response for issue-style PR comments and review submissions. */
export const GitHubPullRequestDiscussionGraphQLSchema = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.Struct({
        comments: Schema.Struct({
          nodes: Schema.Array(GitHubDiscussionNodeSchema).check(
            Schema.isMaxLength(MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE),
          ),
          pageInfo: Schema.Struct({ hasPreviousPage: Schema.Boolean }),
        }),
        reviews: Schema.Struct({
          nodes: Schema.Array(GitHubReviewNodeSchema).check(
            Schema.isMaxLength(MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE),
          ),
          pageInfo: Schema.Struct({ hasPreviousPage: Schema.Boolean }),
        }),
      }),
    }),
  }),
});

/** Bounded REST response for inline pull-request review comments. */
export const GitHubInlineReviewCommentsSchema = Schema.Array(
  Schema.Struct({
    body: BoundedDiscussionBodySchema,
    id: PositiveIntegerSchema,
    user: GitHubDiscussionAuthorSchema,
  }),
).check(Schema.isMaxLength(MAX_GITHUB_DISCUSSION_ITEMS_PER_SURFACE));

/** Additive schema-v1 watcher high-water marks. Bodies never enter this cursor. */
export const GitHubDiscussionCursorSchema = Schema.Struct({
  inlineReviewCommentId: Schema.optionalKey(PositiveIntegerSchema),
  issueCommentId: Schema.optionalKey(PositiveIntegerSchema),
  reviewId: Schema.optionalKey(PositiveIntegerSchema),
});
export type GitHubDiscussionCursor = typeof GitHubDiscussionCursorSchema.Type;
