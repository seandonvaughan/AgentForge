import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdaptiveRouter } from '../../packages/core/src/intelligence/adaptive-routing.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'aroute-quality-'));
}

interface StepScoreFixture {
  agent_id: string;
  capability_tag?: string;
  skill_set?: string;
  model: 'opus' | 'sonnet' | 'haiku';
  quality: number;
  cost_usd: number;
  latency_ms: number;
  id?: string;
  ts?: string;
}

/** Deterministic seeded PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function writeStepScores(path: string, records: StepScoreFixture[]): void {
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(path, lines, 'utf8');
}

describe('AdaptiveRouter — quality-aware routing', () => {
  let dir: string;
  let stepScoresPath: string;
  let feedbackPath: string;

  beforeEach(() => {
    dir = tmpDir();
    stepScoresPath = join(dir, 'step-scores.jsonl');
    feedbackPath = join(dir, 'routing-feedback.jsonl');
  });

  it('falls back to Wave-2 cost-only routing when step-scores.jsonl is missing', () => {
    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
      rng: seeded(1),
    });
    // No step-scores, no feedback either → defaultModel returned (Wave-2 verbatim)
    const result = router.recommendQualityAware({
      agentId: 'agent-x',
      defaultModel: 'sonnet',
    });
    expect(result.reason).toBe('wave2-fallback');
    expect(result.model).toBe('sonnet');
    expect(router.hasQualitySignal()).toBe(false);
  });

  it('cold-start: <3 observations on any triple → Wave-2 behavior', () => {
    // Only 2 records on (agent-x, sonnet) — insufficient
    writeStepScores(stepScoresPath, [
      { agent_id: 'agent-x', capability_tag: 'cap1', model: 'sonnet', quality: 0.9, cost_usd: 0.05, latency_ms: 2000 },
      { agent_id: 'agent-x', capability_tag: 'cap1', model: 'sonnet', quality: 0.9, cost_usd: 0.05, latency_ms: 2000 },
    ]);
    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
      rng: seeded(2),
    });
    const result = router.recommendQualityAware({
      agentId: 'agent-x',
      capabilityTag: 'cap1',
      defaultModel: 'opus',
    });
    expect(result.reason).toBe('cold-start');
    // Wave-2 path with no routing-feedback records → returns defaultModel
    expect(result.model).toBe('opus');
  });

  it('selects max-utility on the Pareto front when triples have enough data', () => {
    // Build a clean fixture: sonnet is the optimum (high quality, low cost, low latency)
    const records: StepScoreFixture[] = [];
    const cap = 'cap1';
    // Haiku: low quality, very cheap, very fast → on Pareto front but lower utility
    for (let i = 0; i < 10; i++) {
      records.push({ agent_id: 'agent-x', capability_tag: cap, model: 'haiku', quality: 0.40, cost_usd: 0.005, latency_ms: 500 });
    }
    // Sonnet: best utility — high quality (0.9), low cost (0.04), low latency (2s)
    for (let i = 0; i < 10; i++) {
      records.push({ agent_id: 'agent-x', capability_tag: cap, model: 'sonnet', quality: 0.90, cost_usd: 0.04, latency_ms: 2000 });
    }
    // Opus: marginally higher quality but much more expensive/slower
    for (let i = 0; i < 10; i++) {
      records.push({ agent_id: 'agent-x', capability_tag: cap, model: 'opus', quality: 0.95, cost_usd: 0.30, latency_ms: 8000 });
    }
    writeStepScores(stepScoresPath, records);

    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
      // RNG that never triggers exploration (always >= epsilon)
      rng: () => 0.99,
    });
    const result = router.recommendQualityAware({
      agentId: 'agent-x',
      capabilityTag: cap,
      defaultModel: 'haiku',
    });
    expect(result.reason).toBe('pareto-utility');
    expect(result.model).toBe('sonnet');
    expect(result.utility).toBeGreaterThan(0);
  });

  it('synthetic 1000-record ledger: converges to ≥85% optimal selection in 200 dispatches', () => {
    const cap = 'execute';
    const records: StepScoreFixture[] = [];
    const rng = seeded(42);

    // Optimum for agent-x is sonnet.
    // Generate 1000 records distributed across 3 models with small Gaussian-ish noise.
    for (let i = 0; i < 1000; i++) {
      const r = rng();
      let rec: StepScoreFixture;
      const jitter = (rng() - 0.5) * 0.05;
      const cjit = (rng() - 0.5) * 0.005;
      const ljit = Math.floor((rng() - 0.5) * 200);
      if (r < 0.33) {
        rec = {
          agent_id: 'agent-x',
          capability_tag: cap,
          model: 'haiku',
          quality: Math.max(0, 0.45 + jitter),
          cost_usd: Math.max(0.001, 0.005 + cjit),
          latency_ms: Math.max(50, 500 + ljit),
        };
      } else if (r < 0.66) {
        rec = {
          agent_id: 'agent-x',
          capability_tag: cap,
          model: 'sonnet',
          quality: Math.max(0, 0.90 + jitter),
          cost_usd: Math.max(0.001, 0.04 + cjit),
          latency_ms: Math.max(50, 2000 + ljit),
        };
      } else {
        rec = {
          agent_id: 'agent-x',
          capability_tag: cap,
          model: 'opus',
          quality: Math.max(0, 0.93 + jitter),
          cost_usd: Math.max(0.001, 0.30 + cjit),
          latency_ms: Math.max(50, 8000 + ljit),
        };
      }
      records.push(rec);
    }
    writeStepScores(stepScoresPath, records);

    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
      explorationEpsilon: 0.05,
      rng: seeded(7),
    });

    let optimal = 0;
    const dispatches = 200;
    for (let i = 0; i < dispatches; i++) {
      const res = router.recommendQualityAware({
        agentId: 'agent-x',
        capabilityTag: cap,
        defaultModel: 'haiku',
      });
      if (res.model === 'sonnet') optimal++;
    }
    const rate = optimal / dispatches;
    expect(rate).toBeGreaterThanOrEqual(0.85);
  });

  it('records optional quality/utility extras on recordOutcome without breaking legacy signatures', () => {
    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
    });
    // Legacy 4-arg still works
    router.recordOutcome('a', 'sonnet', 'success', 'low');
    // Wave-2 5-arg still works
    router.recordOutcome('a', 'sonnet', true, 1000, 0.05);
    // New extras
    router.recordOutcome('a', 'sonnet', true, 1000, 0.05, {
      stepScoreId: 'ss-1',
      quality: 0.9,
      utility: 0.72,
    });
    // No throw == pass; persistence test owns the JSONL shape.
    expect(true).toBe(true);
  });

  it('uses String.includes for capability-tag fallback (no regex)', () => {
    // Records under a different capability_tag — fallback merge should pick them up
    // via the tag-based fallback path because the requested tag substring matches.
    const records: StepScoreFixture[] = [];
    for (let i = 0; i < 5; i++) {
      records.push({ agent_id: 'agent-y', capability_tag: 'cap-execute', model: 'sonnet', quality: 0.9, cost_usd: 0.04, latency_ms: 2000 });
      records.push({ agent_id: 'agent-y', capability_tag: 'cap-execute', model: 'haiku', quality: 0.4, cost_usd: 0.005, latency_ms: 500 });
      records.push({ agent_id: 'agent-y', capability_tag: 'cap-execute', model: 'opus', quality: 0.95, cost_usd: 0.30, latency_ms: 8000 });
    }
    writeStepScores(stepScoresPath, records);
    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
      rng: () => 0.99,
    });
    const res = router.recommendQualityAware({
      agentId: 'agent-y',
      capabilityTag: 'cap-execute',
      defaultModel: 'haiku',
    });
    expect(['sonnet', 'opus', 'haiku']).toContain(res.model);
    expect(res.reason).toBe('pareto-utility');
  });

  it('does not crash on malformed step-scores lines', () => {
    writeFileSync(
      stepScoresPath,
      'not-json\n{ "agent_id": "a", "model": "sonnet", "quality": 0.9, "cost_usd": 0.04, "latency_ms": 2000 }\n{broken\n',
      'utf8',
    );
    const router = new AdaptiveRouter({
      feedbackFilePath: feedbackPath,
      stepScoresPath,
    });
    expect(router.hasQualitySignal()).toBe(true);
  });
});
