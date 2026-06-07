import { z } from 'zod';

const NonNegativeNumberSchema = z.number().min(0);
const IsoDatetimeSchema = z.string().datetime({ offset: true });

/**
 * Zod schema for one actionable child item fault in an epic-review artifact.
 */
export const EpicReviewFaultedItemSchema = z
  .object({
    itemId: z.string().min(1),
    reason: z.string(),
    files: z.array(z.string()),
  })
  .strict();

/**
 * Zod schema for the verdict values persisted in `phases/epic-review.json`.
 */
export const EpicReviewVerdictSchema = z.enum(['APPROVE', 'REQUEST_CHANGES', 'TRIAGE']);

/**
 * Zod schema for the persisted `phases/epic-review.json` artifact.
 */
export const EpicReviewArtifactSchema = z
  .object({
    phase: z.literal('gate'),
    mode: z.literal('epic-review'),
    cycleId: z.string(),
    attempt: z.number().int().min(0),
    verdict: EpicReviewVerdictSchema,
    rationale: z.string(),
    faultedItems: z.array(EpicReviewFaultedItemSchema),
    schemaValidationOk: z.boolean(),
    triageUsed: z.boolean(),
    costUsd: NonNegativeNumberSchema,
    durationMs: NonNegativeNumberSchema,
    completedAt: IsoDatetimeSchema,
  })
  .passthrough();

/**
 * A single child plan item the epic reviewer marked as needing follow-up.
 */
export type EpicReviewFaultedItem = z.infer<typeof EpicReviewFaultedItemSchema>;

/**
 * Final epic-review verdict persisted to the cycle artifact.
 */
export type EpicReviewVerdict = z.infer<typeof EpicReviewVerdictSchema>;

/**
 * Runtime-validated shape of `phases/epic-review.json`.
 */
export type EpicReviewArtifact = z.infer<typeof EpicReviewArtifactSchema>;
