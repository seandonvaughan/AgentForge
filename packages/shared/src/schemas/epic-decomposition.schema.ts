import { z } from 'zod';

/**
 * Runtime schema for one schedulable child item in an epic decomposition.
 */
export const EpicDecompositionChildSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string()),
    capabilityTags: z.array(z.string()),
    suggestedAssignee: z.string().min(1),
    estimatedCostUsd: z.number().min(0),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
    predecessors: z.array(z.string()),
    wave: z.number().int().min(0),
  })
  .strict();

/**
 * Runtime schema for the budget audit embedded in decomposition.json.
 */
export const EpicDecompositionBudgetReportSchema = z
  .object({
    budgetUsd: z.number().positive(),
    spendableUsd: z.number().min(0),
    sumUsd: z.number().min(0),
    lowerUsd: z.number().min(0),
    upperUsd: z.number().min(0),
    withinBand: z.boolean(),
  })
  .strict();

/**
 * Runtime schema for a synthetic file-overlap dependency edge.
 */
export const EpicDecompositionSyntheticFileEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    sharedFiles: z.array(z.string()),
  })
  .strict();

/**
 * Runtime schema for the validation report persisted with an epic decomposition.
 */
export const EpicDecompositionValidationReportSchema = z
  .object({
    acyclic: z.boolean(),
    cycle: z.array(z.string()).optional(),
    missingPredecessors: z.array(
      z
        .object({
          childId: z.string().min(1),
          missing: z.array(z.string()),
        })
        .strict(),
    ),
    syntheticFileEdges: z.array(EpicDecompositionSyntheticFileEdgeSchema),
    waveCount: z.number().int().min(0),
    budget: EpicDecompositionBudgetReportSchema.optional(),
  })
  .strict();

/**
 * Runtime schema validating the persisted .agentforge cycle decomposition.json artifact.
 */
export const EpicDecompositionSchema = z
  .object({
    epicId: z.string().min(1),
    rationale: z.string().min(1),
    children: z.array(EpicDecompositionChildSchema).min(1),
    validationReport: EpicDecompositionValidationReportSchema,
  })
  .strict();

/**
 * Parsed child item from a persisted epic decomposition artifact.
 */
export type EpicDecompositionChild = z.infer<typeof EpicDecompositionChildSchema>;

/**
 * Parsed budget audit from a persisted epic decomposition artifact.
 */
export type EpicDecompositionBudgetReport = z.infer<typeof EpicDecompositionBudgetReportSchema>;

/**
 * Parsed synthetic file-overlap dependency edge from a persisted epic decomposition artifact.
 */
export type EpicDecompositionSyntheticFileEdge = z.infer<
  typeof EpicDecompositionSyntheticFileEdgeSchema
>;

/**
 * Parsed validation report from a persisted epic decomposition artifact.
 */
export type EpicDecompositionValidationReport = z.infer<
  typeof EpicDecompositionValidationReportSchema
>;

/**
 * Parsed persisted .agentforge cycle decomposition.json artifact.
 */
export type EpicDecomposition = z.infer<typeof EpicDecompositionSchema>;
