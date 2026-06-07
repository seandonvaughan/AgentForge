import { z } from 'zod';

const NonNegativeNumberSchema = z.number().finite().min(0);

/**
 * Zod schema for one item row in a spend-report.json artifact.
 */
export const SpendReportPerItemSchema = z.object({
  itemId: z.string().min(1),
  title: z.string(),
  plannedUsd: NonNegativeNumberSchema.nullable(),
  actualUsd: NonNegativeNumberSchema,
  status: z.string().min(1),
}).strict();

/**
 * Zod schema for the cycle spend-report.json artifact.
 */
export const SpendReportSchema = z.object({
  schemaVersion: z.literal(1),
  cycleId: z.string().min(1),
  epicId: z.string().optional(),
  objective: z.string().optional(),
  budgetUsd: NonNegativeNumberSchema,
  totalUsd: NonNegativeNumberSchema,
  executionUsd: NonNegativeNumberSchema,
  overheadUsd: NonNegativeNumberSchema,
  utilization: NonNegativeNumberSchema,
  perItem: z.array(SpendReportPerItemSchema),
  generatedAt: z.string().datetime(),
}).strict();

/**
 * Runtime-validated item row from a spend-report.json artifact.
 */
export type SpendReportPerItem = z.infer<typeof SpendReportPerItemSchema>;

/**
 * Runtime-validated spend-report.json artifact.
 */
export type SpendReport = z.infer<typeof SpendReportSchema>;
