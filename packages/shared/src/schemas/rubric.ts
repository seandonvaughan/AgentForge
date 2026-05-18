import { z } from 'zod';

export const RubricCriterionSchema = z.object({
  key: z.string(),
  weight: z.number().min(0).max(1),
  source: z.enum(['deterministic', 'llm-graded']),
  applies_when: z.object({
    phase: z.array(z.string()).optional(),
    capability_tags: z.array(z.string()).optional(),
    skill_ids: z.array(z.string()).optional(),
  }).default({}),
});

export const RubricSchema = z.object({
  version: z.string(),
  criteria: z.array(RubricCriterionSchema),
});

export type Rubric = z.infer<typeof RubricSchema>;
