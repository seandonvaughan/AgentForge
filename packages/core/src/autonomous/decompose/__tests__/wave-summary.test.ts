import { describe, it, expect } from 'vitest';
import { summarizeWavePlan } from '../wave-summary.js';
import type { EpicPlan } from '../types.js';

// Minimal helper to build an EpicChild with a given wave value (or absent wave)
function child(
  id: string,
  wave?: number,
): EpicPlan['children'][number] {
  return {
    id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    files: [],
    capabilityTags: [],
    suggestedAssignee: 'test-agent',
    estimatedCostUsd: 1,
    estimatedComplexity: 'low',
    predecessors: [],
    ...(typeof wave === 'number' ? { wave } : {}),
  };
}

describe('summarizeWavePlan', () => {
  it('returns exact counts for waves [0,0,1,2,2,2]', () => {
    const plan: EpicPlan = {
      epicId: 'epic-1',
      rationale: 'test',
      children: [
        child('a', 0),
        child('b', 0),
        child('c', 1),
        child('d', 2),
        child('e', 2),
        child('f', 2),
      ],
    };

    const summary = summarizeWavePlan(plan);

    expect(summary.totalItems).toBe(6);
    expect(summary.waveCount).toBe(3);
    expect(summary.itemsPerWave).toEqual([2, 1, 3]);
    expect(summary.maxWaveWidth).toBe(3);
  });

  it('treats a child with NO wave field as wave 0', () => {
    const plan: EpicPlan = {
      epicId: 'epic-2',
      rationale: 'test',
      children: [
        child('x'),      // no wave → treated as 0
        child('y', 1),
      ],
    };

    const summary = summarizeWavePlan(plan);

    expect(summary.totalItems).toBe(2);
    expect(summary.waveCount).toBe(2);
    expect(summary.itemsPerWave).toEqual([1, 1]);
    expect(summary.maxWaveWidth).toBe(1);
  });

  it('returns all-zero result with itemsPerWave===[] for an empty plan', () => {
    // EpicPlanSchema requires children.min(1), so we bypass the validator here
    // and pass a structurally empty plan directly to the pure function.
    const plan = {
      epicId: 'epic-empty',
      rationale: 'test',
      children: [],
    } as unknown as EpicPlan;

    const summary = summarizeWavePlan(plan);

    expect(summary.totalItems).toBe(0);
    expect(summary.waveCount).toBe(0);
    expect(summary.itemsPerWave).toEqual([]);
    expect(summary.maxWaveWidth).toBe(0);

    // Extra guard: no NaN anywhere
    for (const v of Object.values(summary)) {
      if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
    }
    for (const v of summary.itemsPerWave) {
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('handles a single-item plan (one wave, width 1)', () => {
    const plan: EpicPlan = {
      epicId: 'epic-3',
      rationale: 'test',
      children: [child('solo', 0)],
    };

    const summary = summarizeWavePlan(plan);

    expect(summary.totalItems).toBe(1);
    expect(summary.waveCount).toBe(1);
    expect(summary.itemsPerWave).toEqual([1]);
    expect(summary.maxWaveWidth).toBe(1);
  });

  it('fills gaps in wave numbering with 0', () => {
    // Waves 0 and 2 exist, wave 1 is absent → itemsPerWave[1] === 0
    const plan: EpicPlan = {
      epicId: 'epic-4',
      rationale: 'test',
      children: [child('a', 0), child('b', 2)],
    };

    const summary = summarizeWavePlan(plan);

    expect(summary.totalItems).toBe(2);
    expect(summary.waveCount).toBe(2); // only 2 distinct wave values
    expect(summary.itemsPerWave).toEqual([1, 0, 1]); // gap filled with 0
    expect(summary.maxWaveWidth).toBe(1);
  });
});
