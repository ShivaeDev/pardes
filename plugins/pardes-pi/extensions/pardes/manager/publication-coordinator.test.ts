import { describe, expect, test } from 'vitest';
import { isManagedPublishedReviewBranch, PULL_REQUEST_BRANCH_MAX_LENGTH } from '../github/index.ts';
import {
  PUBLISHED_REVIEW_BRANCH_SLUG_MAX_LENGTH,
  readablePublishedReviewBranch,
} from './publication-coordinator.ts';

const RESERVATION_ID = '11111111-1111-4111-8111-111111111111';

describe('published review branch names', () => {
  test('projects readable Git-safe workstream and task slugs with a stable uniqueness suffix', () => {
    const branch = readablePublishedReviewBranch(
      ' Résumé / Release 🚀 ',
      `Implement the bounded publication slice ${'x'.repeat(100)}`,
      RESERVATION_ID,
    );

    expect(branch).toBe(
      `pardes/review/readable-resume-release-${`implement-the-bounded-publication-slice-${'x'.repeat(24)}`}-${RESERVATION_ID}`,
    );
    expect(branch.length).toBeLessThanOrEqual(PULL_REQUEST_BRANCH_MAX_LENGTH);
    expect(isManagedPublishedReviewBranch(branch)).toBe(true);
  });

  test('uses readable fallbacks when names contain no Git-safe ASCII and bounds both slugs', () => {
    const branch = readablePublishedReviewBranch('🚀', ' '.repeat(300), RESERVATION_ID);

    expect(branch).toBe(`pardes/review/readable-workstream-task-${RESERVATION_ID}`);
    expect(PUBLISHED_REVIEW_BRANCH_SLUG_MAX_LENGTH).toBe(64);
    expect(isManagedPublishedReviewBranch(branch)).toBe(true);
  });

  test('keeps readable refs structurally disjoint from coexisting opaque and fixed-root leaves', () => {
    const opaque = `pardes/review/${RESERVATION_ID}`;
    const fixedRoot = 'pardes/review/readable';
    const readable = readablePublishedReviewBranch(RESERVATION_ID, 'Task', RESERVATION_ID);

    expect(readable).toBe(`pardes/review/readable-${RESERVATION_ID}-task-${RESERVATION_ID}`);
    expect(readable.startsWith(`${opaque}/`)).toBe(false);
    expect(readable.startsWith(`${fixedRoot}/`)).toBe(false);
    expect(isManagedPublishedReviewBranch(opaque)).toBe(true);
    expect(isManagedPublishedReviewBranch(readable)).toBe(true);
  });

  test('recognizes already-persisted nested readable reservations for stable reuse', () => {
    expect(
      isManagedPublishedReviewBranch(`pardes/review/readable/workstream/task-${RESERVATION_ID}`),
    ).toBe(true);
  });

  test('rejects a malformed uniqueness suffix before formatting a reservation', () => {
    expect(() => readablePublishedReviewBranch('workstream', 'task', '../unsafe')).toThrow(
      'Published review branch reservation ID must be a UUID.',
    );
  });
});
