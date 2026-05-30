// packages/core/src/autonomous/decompose/types.ts
//
// Epic-decomposer data model (spec 2026-05-30 §5, §6.2). Pure types + Zod
// schemas. An EpicObjective is the operator's input; an EpicPlan is the
// planner's structured output; an EpicChild is one wave-schedulable work item.

import { z } from 'zod';

export const EpicObjectiveSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    constraints: z.array(z.string()).optional(),
    createdAt: z.string(),
  })
  .strict();
export type EpicObjective = z.infer<typeof EpicObjectiveSchema>;

export const EpicChildSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    files: z.array(z.string()).default([]),
    capabilityTags: z.array(z.string()).default([]),
    suggestedAssignee: z.string(),
    estimatedCostUsd: z.number().min(0),
    estimatedComplexity: z.enum(['low', 'medium', 'high']),
    predecessors: z.array(z.string()).default([]),
    /** Assigned by wave-layering; absent until layered. */
    wave: z.number().int().min(0).optional(),
  })
  .strict();
export type EpicChild = z.infer<typeof EpicChildSchema>;

export const EpicPlanSchema = z
  .object({
    epicId: z.string(),
    rationale: z.string(),
    children: z.array(EpicChildSchema).min(1),
  })
  .strict();
export type EpicPlan = z.infer<typeof EpicPlanSchema>;

export interface ValidationReport {
  acyclic: boolean;
  cycle?: string[];
  missingPredecessors: Array<{ childId: string; missing: string[] }>;
  syntheticFileEdges: Array<{ from: string; to: string; sharedFiles: string[] }>;
  waveCount: number;
}
