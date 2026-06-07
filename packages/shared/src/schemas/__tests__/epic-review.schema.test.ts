import { describe, expect, it } from 'vitest';
import { EpicReviewArtifactSchema } from '../epic-review.schema.js';

const VALID_APPROVE_ARTIFACT = {
  phase: 'gate',
  mode: 'epic-review',
  cycleId: 'cycle-2026-06-06',
  attempt: 0,
  verdict: 'APPROVE',
  rationale: 'The epic satisfies the objective.',
  faultedItems: [],
  schemaValidationOk: true,
  triageUsed: false,
  costUsd: 0.42,
  durationMs: 12_345,
  completedAt: '2026-06-06T12:34:56.000Z',
};

describe('EpicReviewArtifactSchema', () => {
  it('accepts a valid APPROVE artifact', () => {
    const result = EpicReviewArtifactSchema.safeParse(VALID_APPROVE_ARTIFACT);

    expect(result.success).toBe(true);
  });

  it('accepts a valid REQUEST_CHANGES artifact with faulted items', () => {
    const result = EpicReviewArtifactSchema.safeParse({
      ...VALID_APPROVE_ARTIFACT,
      verdict: 'REQUEST_CHANGES',
      rationale: 'One child item is incomplete.',
      faultedItems: [
        {
          itemId: 'child-15',
          reason: 'The route does not validate epic-review.json before returning it.',
          files: ['packages/server/src/routes/v5/cycles.ts'],
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a valid TRIAGE artifact', () => {
    const result = EpicReviewArtifactSchema.safeParse({
      ...VALID_APPROVE_ARTIFACT,
      verdict: 'TRIAGE',
      rationale: 'Reviewer output was unparseable; verify remains authoritative.',
      schemaValidationOk: false,
      triageUsed: true,
    });

    expect(result.success).toBe(true);
  });

  it('preserves unknown top-level fields for forward-compatible consumers', () => {
    const result = EpicReviewArtifactSchema.safeParse({
      ...VALID_APPROVE_ARTIFACT,
      reviewerModel: 'opus',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).reviewerModel).toBe('opus');
    }
  });

  it('rejects malformed samples', () => {
    const malformedSamples: unknown[] = [
      { ...VALID_APPROVE_ARTIFACT, phase: 'review' },
      { ...VALID_APPROVE_ARTIFACT, mode: 'gate' },
      { ...VALID_APPROVE_ARTIFACT, verdict: 'REJECT' },
      { ...VALID_APPROVE_ARTIFACT, attempt: -1 },
      { ...VALID_APPROVE_ARTIFACT, schemaValidationOk: 'true' },
      { ...VALID_APPROVE_ARTIFACT, costUsd: -0.01 },
      { ...VALID_APPROVE_ARTIFACT, durationMs: -1 },
      { ...VALID_APPROVE_ARTIFACT, completedAt: 'not-a-date' },
      { ...VALID_APPROVE_ARTIFACT, faultedItems: null },
      {
        ...VALID_APPROVE_ARTIFACT,
        faultedItems: [{ itemId: 'child-15', reason: 'Missing files field.' }],
      },
      {
        ...VALID_APPROVE_ARTIFACT,
        faultedItems: [{ itemId: '', reason: 'Blank id.', files: [] }],
      },
      {
        ...VALID_APPROVE_ARTIFACT,
        faultedItems: [{ itemId: 'child-15', reason: 'Bad file entry.', files: [42] }],
      },
      {
        ...VALID_APPROVE_ARTIFACT,
        faultedItems: [
          { itemId: 'child-15', reason: 'Unexpected nested field.', files: [], extra: true },
        ],
      },
    ];

    for (const sample of malformedSamples) {
      expect(EpicReviewArtifactSchema.safeParse(sample).success).toBe(false);
    }
  });
});
