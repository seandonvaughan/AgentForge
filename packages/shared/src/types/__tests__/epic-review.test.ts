import { describe, expect, it } from 'vitest';
import type { EpicReview } from '../epic-review.js';

describe('EpicReview', () => {
  it('matches a request-changes epic-review.json shape', () => {
    const review = {
      verdict: 'REQUEST_CHANGES',
      rationale: 'Item child-15 still returns untyped JSON.',
      faultedItems: [
        {
          itemId: 'child-15',
          reason: 'Server route needs the shared epic review contract.',
          files: ['packages/server/src/routes/v5/epic-review.ts'],
        },
      ],
    } satisfies EpicReview;

    expect(review).toEqual({
      verdict: 'REQUEST_CHANGES',
      rationale: 'Item child-15 still returns untyped JSON.',
      faultedItems: [
        {
          itemId: 'child-15',
          reason: 'Server route needs the shared epic review contract.',
          files: ['packages/server/src/routes/v5/epic-review.ts'],
        },
      ],
    });
  });

  it('matches an approved epic-review.json shape with no faulted items', () => {
    const review = {
      verdict: 'APPROVE',
      rationale: 'Epic review passed.',
      faultedItems: [],
    } satisfies EpicReview;

    expect(review.faultedItems).toHaveLength(0);
  });
});
