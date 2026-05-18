import { z } from 'zod';

export const StepScoreSignalSchema = z.object({
  key: z.string(),
  value: z.number(),
  source: z.enum(['deterministic', 'llm-graded', 'heuristic']),
  weight: z.number().min(0).max(1),
  note: z.string().max(280).optional(),
});

export const StepScoreSchema = z.object({
  step_score_id: z.string().uuid(),
  cycle_id: z.string(),
  phase: z.enum(['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn']),
  item_id: z.string().nullable(),
  agent_id: z.string(),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  capability_tags: z.array(z.string()),
  skill_ids: z.array(z.string()),
  output_schema_id: z.string().nullable(),
  quality: z.number().min(0).max(1),
  rubric_version: z.string(),
  signals: z.array(StepScoreSignalSchema),
  cost_usd: z.number().min(0),
  latency_ms: z.number().int().min(0),
  tokens: z.object({
    input: z.number().int().min(0),
    output: z.number().int().min(0),
    cache_read: z.number().int().min(0).default(0),
    cache_write: z.number().int().min(0).default(0),
  }),
  llm_graded: z.boolean(),
  created_at: z.string().datetime(),
});

export type StepScore = z.infer<typeof StepScoreSchema>;
export type StepScoreSignal = z.infer<typeof StepScoreSignalSchema>;

export const ROUTING_UTILITY_WEIGHTS = { quality: 0.6, cost: 0.3, latency: 0.1 } as const;

export function computeUtility(s: Pick<StepScore, 'quality' | 'cost_usd' | 'latency_ms'>): number {
  const costNorm = Math.max(0, 1 - s.cost_usd / 0.50);
  const latencyNorm = Math.max(0, 1 - s.latency_ms / 120_000);
  return ROUTING_UTILITY_WEIGHTS.quality * s.quality +
         ROUTING_UTILITY_WEIGHTS.cost * costNorm +
         ROUTING_UTILITY_WEIGHTS.latency * latencyNorm;
}
