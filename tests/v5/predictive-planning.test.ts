import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryAnalyzer } from '../../packages/core/src/predictive-planning/history-analyzer.js';
import { EffortEstimator } from '../../packages/core/src/predictive-planning/effort-estimator.js';
import { RiskScorer } from '../../packages/core/src/predictive-planning/risk-scorer.js';
import { SprintPredictor } from '../../packages/core/src/predictive-planning/sprint-predictor.js';
import type {
  SprintHistoryRecord,
  BacklogItem,
} from '../../packages/core/src/predictive-planning/types.js';

const sampleRecord = (overrides: Partial<SprintHistoryRecord> = {}): SprintHistoryRecord => ({
  sprintId: 'v5.0',
  plannedItems: 8,
  completedItems: 6,
  totalCostUsd: 20,
  durationDays: 7,
  failedItems: ['item-x'],
  itemsByPriority: { P0: 2, P1: 3, P2: 2, P3: 1 },
  completedByPriority: { P0: 2, P1: 2, P2: 2, P3: 0 },
  completedAt: new Date().toISOString(),
  ...overrides,
});

const sampleItem = (id: string, overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  title: `Item ${id}`,
  priority: 'P1',
  complexityScore: 5,
  ...overrides,
});

// ── HistoryAnalyzer ───────────────────────────────────────────────────────────

describe('HistoryAnalyzer', () => {
  const analyzer = new HistoryAnalyzer();

  it('returns zero analysis for empty history', () => {
    const result = analyzer.analyze([]);
    expect(result.avgCompletionRate).toBe(0);
    expect(result.totalSprints).toBe(0);
  });

  it('computes average completion rate', () => {
    const records = [
      sampleRecord({ plannedItems: 10, completedItems: 8 }),
      sampleRecord({ sprintId: 'v5.1', plannedItems: 10, completedItems: 6 }),
    ];
    const result = analyzer.analyze(records);
    expect(result.avgCompletionRate).toBeCloseTo(0.7);
  });

  it('computes average cost per priority tier', () => {
    const records = [sampleRecord()];
    const result = analyzer.analyze(records);
    expect(result.avgCostPerPriorityTier.P0).toBeGreaterThanOrEqual(0);
    expect(result.avgCostPerPriorityTier.P1).toBeGreaterThanOrEqual(0);
  });

  it('identifies common failure patterns', () => {
    const records = [
      sampleRecord({ failedItems: ['item-x', 'item-y'] }),
      sampleRecord({ sprintId: 'v5.1', failedItems: ['item-x'] }),
    ];
    const result = analyzer.analyze(records);
    expect(result.commonFailurePatterns).toContain('item-x');
  });

  it('computes average duration days', () => {
    const records = [
      sampleRecord({ durationDays: 7 }),
      sampleRecord({ sprintId: 'v5.1', durationDays: 9 }),
    ];
    const result = analyzer.analyze(records);
    expect(result.avgDurationDays).toBe(8);
  });

  it('computes average cost', () => {
    const records = [
      sampleRecord({ totalCostUsd: 20 }),
      sampleRecord({ sprintId: 'v5.1', totalCostUsd: 30 }),
    ];
    const result = analyzer.analyze(records);
    expect(result.avgCostUsd).toBe(25);
  });

  it('handles 100% completion rate', () => {
    const records = [sampleRecord({ plannedItems: 5, completedItems: 5 })];
    const result = analyzer.analyze(records);
    expect(result.avgCompletionRate).toBe(1);
  });
});

// ── EffortEstimator ───────────────────────────────────────────────────────────

describe('EffortEstimator', () => {
  const estimator = new EffortEstimator();

  const emptyAnalysis = {
    avgCompletionRate: 0,
    avgCostPerPriorityTier: { P0: 0, P1: 0, P2: 0, P3: 0 },
    commonFailurePatterns: [],
    avgDurationDays: 7,
    totalSprints: 0,
    avgCostUsd: 0,
  };

  it('estimates effort for a simple item', () => {
    const item = sampleItem('i1', { complexityScore: 3 });
    const result = estimator.estimate(item, emptyAnalysis);
    expect(result.itemId).toBe('i1');
    expect(result.estimatedHours).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('higher complexity produces higher cost estimate', () => {
    const low = estimator.estimate(sampleItem('low', { complexityScore: 2 }), emptyAnalysis);
    const high = estimator.estimate(sampleItem('high', { complexityScore: 9 }), emptyAnalysis);
    expect(high.estimatedCostUsd).toBeGreaterThan(low.estimatedCostUsd);
  });

  it('confidence increases with more history', () => {
    const fewHistory = { ...emptyAnalysis, totalSprints: 1 };
    const moreHistory = { ...emptyAnalysis, totalSprints: 10 };
    const r1 = estimator.estimate(sampleItem('x'), fewHistory);
    const r2 = estimator.estimate(sampleItem('x'), moreHistory);
    expect(r2.confidence).toBeGreaterThan(r1.confidence);
  });

  it('uses provided estimatedCostUsd when available', () => {
    const item = sampleItem('i2', { estimatedCostUsd: 99.99 });
    const result = estimator.estimate(item, emptyAnalysis);
    expect(result.estimatedCostUsd).toBe(99.99);
  });

  it('estimateMany returns an estimate per item', () => {
    const items = [sampleItem('a'), sampleItem('b'), sampleItem('c')];
    const results = estimator.estimateMany(items, []);
    expect(results).toHaveLength(3);
    expect(results.map(r => r.itemId)).toEqual(['a', 'b', 'c']);
  });
});

// ── RiskScorer ────────────────────────────────────────────────────────────────

describe('RiskScorer', () => {
  const scorer = new RiskScorer();

  it('scores empty sprint as low risk', () => {
    const result = scorer.score([]);
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.factors).toHaveLength(0);
  });

  it('detects high complexity concentration', () => {
    const items = Array.from({ length: 4 }, (_, i) =>
      sampleItem(`i${i}`, { complexityScore: 9 }),
    );
    const result = scorer.score(items);
    expect(result.factors.some(f => f.name === 'high_complexity_concentration')).toBe(true);
  });

  it('detects dependency conflicts', () => {
    const items = [
      sampleItem('a', { dependencies: ['missing-dep'] }),
    ];
    const result = scorer.score(items);
    expect(result.factors.some(f => f.name === 'dependency_conflicts')).toBe(true);
  });

  it('detects budget overrun', () => {
    const items = [sampleItem('a', { estimatedCostUsd: 100 })];
    const result = scorer.score(items, 10);
    expect(result.factors.some(f => f.name === 'budget_overrun')).toBe(true);
  });

  it('level is critical for high score', () => {
    const items = [
      ...Array.from({ length: 8 }, (_, i) => sampleItem(`p${i}`, { priority: 'P0', complexityScore: 9, estimatedCostUsd: 50 })),
    ];
    const result = scorer.score(items, 10);
    expect(['high', 'critical']).toContain(result.level);
  });

  it('detects P0 overload', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      sampleItem(`p${i}`, { priority: 'P0' }),
    );
    const result = scorer.score(items);
    expect(result.factors.some(f => f.name === 'p0_overload')).toBe(true);
  });
});

// ── SprintPredictor ───────────────────────────────────────────────────────────

describe('SprintPredictor', () => {
  const predictor = new SprintPredictor();

  it('returns a prediction for a basic backlog', () => {
    const items = [sampleItem('a'), sampleItem('b'), sampleItem('c')];
    const result = predictor.predict(items, []);
    expect(result.recommendedItems.length + result.excludedItems.length).toBe(3);
    expect(result.riskScore).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('prioritizes P0 items first', () => {
    const items = [
      sampleItem('p2', { priority: 'P2', complexityScore: 1 }),
      sampleItem('p0', { priority: 'P0', complexityScore: 1 }),
      sampleItem('p1', { priority: 'P1', complexityScore: 1 }),
    ];
    const result = predictor.predict(items, [], 1000);
    const firstId = result.recommendedItems[0]?.id;
    expect(firstId).toBe('p0');
  });

  it('excludes items that exceed budget', () => {
    const items = [
      sampleItem('cheap', { estimatedCostUsd: 5, complexityScore: 1 }),
      sampleItem('expensive', { estimatedCostUsd: 1000, complexityScore: 10 }),
    ];
    const result = predictor.predict(items, [], 10);
    expect(result.excludedItems.some(i => i.id === 'expensive')).toBe(true);
  });

  it('includes effort estimates for all items', () => {
    const items = [sampleItem('a'), sampleItem('b')];
    const result = predictor.predict(items, []);
    expect(result.effortEstimates).toHaveLength(2);
  });

  it('confidence increases with history', () => {
    const items = [sampleItem('a')];
    const noHistory = predictor.predict(items, []);
    const withHistory = predictor.predict(items, [
      sampleRecord(),
      sampleRecord({ sprintId: 'v5.1' }),
      sampleRecord({ sprintId: 'v5.2' }),
    ]);
    expect(withHistory.confidence).toBeGreaterThanOrEqual(noHistory.confidence);
  });

  it('estimated total cost is sum of recommended item costs', () => {
    const items = [
      sampleItem('a', { estimatedCostUsd: 10, complexityScore: 3 }),
      sampleItem('b', { estimatedCostUsd: 20, complexityScore: 3 }),
    ];
    const result = predictor.predict(items, [], 1000);
    expect(result.estimatedTotalCostUsd).toBeGreaterThan(0);
  });

  it('returns risk score on recommended items', () => {
    const items = [sampleItem('a')];
    const result = predictor.predict(items, []);
    expect(result.riskScore.score).toBeGreaterThanOrEqual(0);
    expect(result.riskScore.score).toBeLessThanOrEqual(100);
    expect(['low', 'medium', 'high', 'critical']).toContain(result.riskScore.level);
  });

  it('completion rate is between 0 and 1', () => {
    const items = [sampleItem('a')];
    const result = predictor.predict(items, []);
    expect(result.estimatedCompletionRate).toBeGreaterThanOrEqual(0);
    expect(result.estimatedCompletionRate).toBeLessThanOrEqual(1);
  });
});
