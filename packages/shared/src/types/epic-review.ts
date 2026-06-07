/**
 * Possible verdicts recorded in `phases/epic-review.json`.
 */
export type EpicReviewVerdict = 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';

/**
 * A child plan item identified by the epic review as needing follow-up work.
 */
export interface EpicReviewFaultedItem {
  /** Plan item identifier from the cycle plan. */
  itemId: string;
  /** Human-readable reason the item is considered faulted. */
  reason: string;
  /** Repository-relative files involved in the finding. */
  files: string[];
}

/**
 * Shared JSON contract for `phases/epic-review.json` consumers.
 */
export interface EpicReview {
  /** Structured review verdict. */
  verdict: EpicReviewVerdict;
  /** Human-readable explanation for the verdict. */
  rationale: string;
  /** Plan items that must be fixed before approval. */
  faultedItems: EpicReviewFaultedItem[];
}
