// tests/dashboard/quality-page.test.ts
//
// Contract tests for /quality page logic (pure helpers, no rendering).
//
// Tests cover:
//  - scatterPoints derivation from by_agent aggregates
//  - skillLadderEntries derivation (delta = mean - baseline)
//  - driftPoints derivation (last 14 cycles, raw scores)
//  - driftSvgPath shape (returns empty string for < 2 points)
//  - empty-state: all derived values when aggregates is null
//  - error-state: graceful empty arrays

import { describe, it, expect } from 'vitest';

// ── Types (mirrored from the page) ────────────────────────────────────────────

interface AgentAggregate {
  agentId: string;
  meanQuality: number;
  totalCostUsd: number;
  sampleCount: number;
}

interface SkillAggregate {
  skillId: string;
  meanQuality: number;
  baselineMeanQuality: number;
  sampleCount: number;
}

interface CycleAggregate {
  cycleId: string;
  meanQuality: number;
  startedAt?: string;
}

interface AggregatesResponse {
  by_agent?: AgentAggregate[];
  by_skill?: SkillAggregate[];
  by_cycle?: CycleAggregate[];
}

// ── Pure helper mirrors ───────────────────────────────────────────────────────

function deriveScatterPoints(
  aggregates: AggregatesResponse | null,
): Array<{ agentId: string; costUsd: number; qualityScore: number }> {
  const byAgent = aggregates?.by_agent ?? [];
  return byAgent
    .filter(a => a.totalCostUsd > 0)
    .map(a => ({
      agentId: a.agentId,
      costUsd: a.totalCostUsd,
      qualityScore: a.meanQuality,
    }));
}

function deriveSkillLadder(
  aggregates: AggregatesResponse | null,
): Array<{ skillId: string; delta: number; sampleSize: number }> {
  const bySkill = aggregates?.by_skill ?? [];
  return bySkill.map(s => ({
    skillId: s.skillId,
    delta: s.meanQuality - s.baselineMeanQuality,
    sampleSize: s.sampleCount,
  }));
}

function deriveDriftPoints(aggregates: AggregatesResponse | null): number[] {
  const byCycle = aggregates?.by_cycle ?? [];
  return byCycle.slice(-14).map(c => c.meanQuality);
}

function deriveDriftSvgPath(points: number[], w: number, h: number): string {
  if (points.length < 2) return '';
  const mn = Math.min(...points);
  const mx = Math.max(...points);
  const range = mx - mn || 1;
  const pts = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - mn) / range) * (h - 8) - 4;
    return `${x},${y}`;
  });
  return pts.join(' ');
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENTS: AgentAggregate[] = [
  { agentId: 'coder',    meanQuality: 82.5, totalCostUsd: 0.45, sampleCount: 10 },
  { agentId: 'reviewer', meanQuality: 91.0, totalCostUsd: 0.12, sampleCount: 8 },
  { agentId: 'planner',  meanQuality: 74.0, totalCostUsd: 0,    sampleCount: 5 }, // zero cost — excluded
];

const SKILLS: SkillAggregate[] = [
  { skillId: 'feature-dev',  meanQuality: 88.0, baselineMeanQuality: 80.0, sampleCount: 12 },
  { skillId: 'code-review',  meanQuality: 75.0, baselineMeanQuality: 80.0, sampleCount: 7 },
  { skillId: 'test-driven',  meanQuality: 90.0, baselineMeanQuality: 80.0, sampleCount: 9 },
];

const CYCLES: CycleAggregate[] = Array.from({ length: 16 }, (_, i) => ({
  cycleId: `cycle-${String(i).padStart(3, '0')}`,
  meanQuality: 70 + i * 1.5,
}));

const FULL_AGGREGATES: AggregatesResponse = {
  by_agent: AGENTS,
  by_skill: SKILLS,
  by_cycle: CYCLES,
};

// ── Tests: scatterPoints ──────────────────────────────────────────────────────

describe('deriveScatterPoints', () => {
  it('filters out agents with zero totalCostUsd', () => {
    const pts = deriveScatterPoints(FULL_AGGREGATES);
    expect(pts.every(p => p.costUsd > 0)).toBe(true);
  });

  it('maps agentId, costUsd, qualityScore correctly', () => {
    const pts = deriveScatterPoints(FULL_AGGREGATES);
    const coder = pts.find(p => p.agentId === 'coder');
    expect(coder).toBeDefined();
    expect(coder!.costUsd).toBe(0.45);
    expect(coder!.qualityScore).toBe(82.5);
  });

  it('returns empty array when aggregates is null', () => {
    expect(deriveScatterPoints(null)).toEqual([]);
  });

  it('returns empty array when by_agent is missing', () => {
    expect(deriveScatterPoints({})).toEqual([]);
  });

  it('count matches non-zero-cost agents', () => {
    const pts = deriveScatterPoints(FULL_AGGREGATES);
    expect(pts.length).toBe(2); // planner excluded
  });
});

// ── Tests: skillLadderEntries ─────────────────────────────────────────────────

describe('deriveSkillLadder', () => {
  it('computes delta as meanQuality minus baselineMeanQuality', () => {
    const entries = deriveSkillLadder(FULL_AGGREGATES);
    const fd = entries.find(e => e.skillId === 'feature-dev');
    expect(fd).toBeDefined();
    expect(fd!.delta).toBeCloseTo(8.0, 5);
  });

  it('negative delta for skills below baseline', () => {
    const entries = deriveSkillLadder(FULL_AGGREGATES);
    const cr = entries.find(e => e.skillId === 'code-review');
    expect(cr!.delta).toBeCloseTo(-5.0, 5);
  });

  it('carries sampleSize through', () => {
    const entries = deriveSkillLadder(FULL_AGGREGATES);
    const td = entries.find(e => e.skillId === 'test-driven');
    expect(td!.sampleSize).toBe(9);
  });

  it('returns empty array when aggregates is null', () => {
    expect(deriveSkillLadder(null)).toEqual([]);
  });
});

// ── Tests: driftPoints ────────────────────────────────────────────────────────

describe('deriveDriftPoints', () => {
  it('returns at most 14 points', () => {
    const pts = deriveDriftPoints(FULL_AGGREGATES);
    expect(pts.length).toBe(14);
  });

  it('takes the last 14 cycles', () => {
    const pts = deriveDriftPoints(FULL_AGGREGATES);
    // CYCLES has 16 entries, so skip first 2 (cycle-000, cycle-001)
    const expected = CYCLES.slice(-14).map(c => c.meanQuality);
    expect(pts).toEqual(expected);
  });

  it('returns empty array when aggregates is null', () => {
    expect(deriveDriftPoints(null)).toEqual([]);
  });

  it('returns all points when fewer than 14 cycles', () => {
    const agg: AggregatesResponse = {
      by_cycle: CYCLES.slice(0, 5),
    };
    const pts = deriveDriftPoints(agg);
    expect(pts.length).toBe(5);
  });
});

// ── Tests: driftSvgPath ───────────────────────────────────────────────────────

describe('deriveDriftSvgPath', () => {
  it('returns empty string for 0 points', () => {
    expect(deriveDriftSvgPath([], 320, 60)).toBe('');
  });

  it('returns empty string for 1 point', () => {
    expect(deriveDriftSvgPath([80], 320, 60)).toBe('');
  });

  it('returns a non-empty string for 2+ points', () => {
    const path = deriveDriftSvgPath([70, 80, 90], 320, 60);
    expect(path.length).toBeGreaterThan(0);
  });

  it('starts at x=0 for first point', () => {
    const path = deriveDriftSvgPath([70, 80, 90], 320, 60);
    expect(path.startsWith('0,')).toBe(true);
  });

  it('ends at x=w for last point', () => {
    const path = deriveDriftSvgPath([70, 80, 90], 320, 60);
    const parts = path.split(' ');
    expect(parts[parts.length - 1].startsWith('320,')).toBe(true);
  });

  it('handles flat data (all same value) without NaN', () => {
    const path = deriveDriftSvgPath([80, 80, 80], 320, 60);
    expect(path).not.toContain('NaN');
  });

  it('produces correct number of coordinate pairs', () => {
    const path = deriveDriftSvgPath([70, 75, 80, 85], 320, 60);
    const pairs = path.split(' ');
    expect(pairs.length).toBe(4);
  });
});
