/**
 * Reward-sign guard: higher quality / lower cost / lower latency MUST raise a
 * model's selection odds, and adding more good outcomes must never demote it.
 * Guards against an inverted utility sign (ruflo's neural_train bug class).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptiveRouter } from '../../packages/core/src/intelligence/adaptive-routing.js';

let dir: string;
let ledger: string;

const AGENT = 'coder';
const TAG = 'feature';

function record(model: 'opus' | 'sonnet' | 'haiku', quality: number, cost_usd: number, latency_ms: number) {
  return JSON.stringify({ agent_id: AGENT, capability_tag: TAG, model, quality, cost_usd, latency_ms }) + '\n';
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adaptive-reward-sign-'));
  ledger = join(dir, 'step-scores.jsonl');
  let body = '';
  for (let i = 0; i < 3; i++) body += record('haiku', 0.95, 0.02, 2000);
  for (let i = 0; i < 3; i++) body += record('sonnet', 0.30, 0.45, 90000);
  writeFileSync(ledger, body);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshRouter(): AdaptiveRouter {
  return new AdaptiveRouter({ stepScoresPath: ledger, explorationEpsilon: 0, rng: () => 0.999 });
}

describe('AdaptiveRouter reward-sign', () => {
  it('prefers the high-quality / low-cost model', () => {
    const rec = freshRouter().recommendQualityAware({
      agentId: AGENT,
      capabilityTag: TAG,
      defaultModel: 'sonnet',
      candidateModels: ['haiku', 'sonnet'],
    });
    expect(rec.reason).toBe('pareto-utility');
    expect(rec.model).toBe('haiku');
  });

  it('adding more successful outcomes for the winner never demotes it', () => {
    for (let i = 0; i < 5; i++) appendFileSync(ledger, record('haiku', 0.97, 0.01, 1500));
    const rec = freshRouter().recommendQualityAware({
      agentId: AGENT,
      capabilityTag: TAG,
      defaultModel: 'sonnet',
      candidateModels: ['haiku', 'sonnet'],
    });
    expect(rec.model).toBe('haiku');
  });
});
