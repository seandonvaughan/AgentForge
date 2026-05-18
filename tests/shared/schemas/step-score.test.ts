import { describe, it, expect } from 'vitest';
import { StepScoreSchema, computeUtility, ROUTING_UTILITY_WEIGHTS } from '../../../packages/shared/src/schemas/step-score.js';

const GOOD_RECORD = {
  step_score_id: '123e4567-e89b-12d3-a456-426614174000',
  cycle_id: 'cycle-1',
  phase: 'execute' as const,
  item_id: null,
  agent_id: 'agent-coder',
  model: 'sonnet' as const,
  capability_tags: ['typescript', 'testing'],
  skill_ids: [],
  output_schema_id: null,
  quality: 0.85,
  rubric_version: '1.0.0',
  signals: [
    { key: 'test_pass_rate', value: 0.95, source: 'deterministic' as const, weight: 0.5 },
  ],
  cost_usd: 0.05,
  latency_ms: 3000,
  tokens: { input: 1000, output: 500, cache_read: 200, cache_write: 0 },
  llm_graded: false,
  created_at: '2026-05-18T00:00:00.000Z',
};

describe('StepScoreSchema', () => {
  it('parses a good record', () => {
    const result = StepScoreSchema.safeParse(GOOD_RECORD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quality).toBe(0.85);
      expect(result.data.tokens.cache_read).toBe(200);
      expect(result.data.tokens.cache_write).toBe(0);
    }
  });

  it('applies default 0 for cache_read and cache_write when omitted', () => {
    const withoutCache = {
      ...GOOD_RECORD,
      tokens: { input: 100, output: 50 },
    };
    const result = StepScoreSchema.safeParse(withoutCache);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tokens.cache_read).toBe(0);
      expect(result.data.tokens.cache_write).toBe(0);
    }
  });

  it('rejects a record with quality > 1', () => {
    const bad = { ...GOOD_RECORD, quality: 1.5 };
    const result = StepScoreSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects a record with invalid phase', () => {
    const bad = { ...GOOD_RECORD, phase: 'invalid-phase' };
    const result = StepScoreSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects a record with invalid UUID', () => {
    const bad = { ...GOOD_RECORD, step_score_id: 'not-a-uuid' };
    const result = StepScoreSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('computeUtility', () => {
  it('returns high value when quality=1, cost=0, latency=0', () => {
    const u = computeUtility({ quality: 1, cost_usd: 0, latency_ms: 0 });
    // quality contrib: 0.6*1=0.6, cost contrib: 0.3*1=0.3, latency contrib: 0.1*1=0.1 => 1.0
    expect(u).toBeCloseTo(1.0, 5);
  });

  it('returns ~0 when quality=0, cost=$0.50, latency=120s', () => {
    const u = computeUtility({ quality: 0, cost_usd: 0.50, latency_ms: 120_000 });
    // quality contrib: 0, cost contrib: 0.3*(1-1)=0, latency contrib: 0.1*(1-1)=0 => 0
    expect(u).toBeCloseTo(0, 5);
  });

  it('uses correct ROUTING_UTILITY_WEIGHTS constants', () => {
    expect(ROUTING_UTILITY_WEIGHTS.quality).toBe(0.6);
    expect(ROUTING_UTILITY_WEIGHTS.cost).toBe(0.3);
    expect(ROUTING_UTILITY_WEIGHTS.latency).toBe(0.1);
  });

  it('clamps negative normalized values to 0', () => {
    // cost > $0.50 → costNorm should be clamped to 0
    const u = computeUtility({ quality: 0.5, cost_usd: 1.0, latency_ms: 0 });
    const expected = 0.6 * 0.5 + 0.3 * 0 + 0.1 * 1;
    expect(u).toBeCloseTo(expected, 5);
  });
});
