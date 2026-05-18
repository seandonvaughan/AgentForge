// tests/dashboard/quality-tile.test.ts
//
// Contract tests for QualityTile logic (pure helpers, no rendering).
//
// Tests cover:
//  - meanQuality derivation
//  - sampleRate / llmGradedCount
//  - bestEntry / worstEntry selection
//  - ringColor thresholds
//  - fmtScore formatting
//  - empty state when scores is []
//  - single-score case (best === worst)

import { describe, it, expect } from 'vitest';

// ── Types (mirrored from QualityTile) ─────────────────────────────────────────

interface StepScore {
  agentId: string;
  itemId?: string;
  qualityScore: number;
  llmGraded: boolean;
}

// ── Pure helper mirrors ───────────────────────────────────────────────────────

function deriveMeanQuality(scores: StepScore[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((s, r) => s + r.qualityScore, 0) / scores.length;
}

function deriveLlmGradedCount(scores: StepScore[]): number {
  return scores.filter(s => s.llmGraded).length;
}

function deriveSampleRate(scores: StepScore[]): number {
  if (scores.length === 0) return 0;
  return (deriveLlmGradedCount(scores) / scores.length) * 100;
}

function deriveBestEntry(scores: StepScore[]): StepScore | null {
  if (scores.length === 0) return null;
  return scores.reduce((best, s) => s.qualityScore > best.qualityScore ? s : best, scores[0]);
}

function deriveWorstEntry(scores: StepScore[]): StepScore | null {
  if (scores.length === 0) return null;
  return scores.reduce((worst, s) => s.qualityScore < worst.qualityScore ? s : worst, scores[0]);
}

function deriveRingColor(meanQuality: number): string {
  if (meanQuality >= 80) return 'var(--af-success)';
  if (meanQuality >= 60) return 'var(--af-warning)';
  return 'var(--af-danger, #e05353)';
}

function fmtScore(v: number): string {
  return v.toFixed(1);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SCORES: StepScore[] = [
  { agentId: 'coder',    itemId: 'item-01', qualityScore: 92.5, llmGraded: true },
  { agentId: 'reviewer', itemId: 'item-02', qualityScore: 78.0, llmGraded: true },
  { agentId: 'planner',  itemId: 'item-03', qualityScore: 55.0, llmGraded: false },
  { agentId: 'tester',   itemId: 'item-04', qualityScore: 88.0, llmGraded: true },
];

// ── Tests: meanQuality ────────────────────────────────────────────────────────

describe('deriveMeanQuality', () => {
  it('computes correct mean', () => {
    const expected = (92.5 + 78.0 + 55.0 + 88.0) / 4;
    expect(deriveMeanQuality(SCORES)).toBeCloseTo(expected, 5);
  });

  it('returns 0 for empty array', () => {
    expect(deriveMeanQuality([])).toBe(0);
  });

  it('returns the single value for one-element array', () => {
    expect(deriveMeanQuality([SCORES[0]])).toBe(92.5);
  });
});

// ── Tests: llmGradedCount / sampleRate ───────────────────────────────────────

describe('deriveLlmGradedCount', () => {
  it('counts only llmGraded:true entries', () => {
    expect(deriveLlmGradedCount(SCORES)).toBe(3);
  });

  it('returns 0 for empty array', () => {
    expect(deriveLlmGradedCount([])).toBe(0);
  });
});

describe('deriveSampleRate', () => {
  it('computes percentage of llm-graded scores', () => {
    expect(deriveSampleRate(SCORES)).toBeCloseTo(75, 1);
  });

  it('returns 0 for empty array', () => {
    expect(deriveSampleRate([])).toBe(0);
  });

  it('returns 100 when all entries are llm-graded', () => {
    const all: StepScore[] = SCORES.map(s => ({ ...s, llmGraded: true }));
    expect(deriveSampleRate(all)).toBeCloseTo(100, 1);
  });
});

// ── Tests: bestEntry / worstEntry ─────────────────────────────────────────────

describe('deriveBestEntry', () => {
  it('returns the entry with the highest qualityScore', () => {
    const best = deriveBestEntry(SCORES);
    expect(best?.agentId).toBe('coder');
    expect(best?.qualityScore).toBe(92.5);
  });

  it('returns null for empty scores', () => {
    expect(deriveBestEntry([])).toBeNull();
  });

  it('returns the sole entry for single-element array', () => {
    const best = deriveBestEntry([SCORES[2]]);
    expect(best?.agentId).toBe('planner');
  });
});

describe('deriveWorstEntry', () => {
  it('returns the entry with the lowest qualityScore', () => {
    const worst = deriveWorstEntry(SCORES);
    expect(worst?.agentId).toBe('planner');
    expect(worst?.qualityScore).toBe(55.0);
  });

  it('returns null for empty scores', () => {
    expect(deriveWorstEntry([])).toBeNull();
  });
});

// ── Tests: ringColor thresholds ───────────────────────────────────────────────

describe('deriveRingColor', () => {
  it('returns success color at >= 80', () => {
    expect(deriveRingColor(80)).toBe('var(--af-success)');
    expect(deriveRingColor(95)).toBe('var(--af-success)');
    expect(deriveRingColor(100)).toBe('var(--af-success)');
  });

  it('returns warning color at 60-79', () => {
    expect(deriveRingColor(60)).toBe('var(--af-warning)');
    expect(deriveRingColor(70)).toBe('var(--af-warning)');
    expect(deriveRingColor(79)).toBe('var(--af-warning)');
  });

  it('returns danger color below 60', () => {
    expect(deriveRingColor(0)).toContain('danger');
    expect(deriveRingColor(59)).toContain('danger');
  });
});

// ── Tests: fmtScore ───────────────────────────────────────────────────────────

describe('fmtScore', () => {
  it('formats to one decimal place', () => {
    expect(fmtScore(92.5)).toBe('92.5');
    expect(fmtScore(78.0)).toBe('78.0');
    expect(fmtScore(0)).toBe('0.0');
    expect(fmtScore(100)).toBe('100.0');
  });
});

// ── Tests: edge cases ─────────────────────────────────────────────────────────

describe('QualityTile — single score', () => {
  const single: StepScore[] = [
    { agentId: 'solo', itemId: 'item-x', qualityScore: 88.0, llmGraded: true },
  ];

  it('best and worst return the same entry', () => {
    const best = deriveBestEntry(single);
    const worst = deriveWorstEntry(single);
    expect(best?.agentId).toBe(worst?.agentId);
  });

  it('sampleRate is 100% when only entry is llm-graded', () => {
    expect(deriveSampleRate(single)).toBe(100);
  });
});

describe('QualityTile — none llm-graded', () => {
  const ungraded: StepScore[] = SCORES.map(s => ({ ...s, llmGraded: false }));

  it('sampleRate is 0 when no entry is llm-graded', () => {
    expect(deriveSampleRate(ungraded)).toBe(0);
  });
});
