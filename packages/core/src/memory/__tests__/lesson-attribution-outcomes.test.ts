// packages/core/src/memory/__tests__/lesson-attribution-outcomes.test.ts
//
// Unit tests for Phase 1 outcome-correlation helpers:
//   computeOutcomeConfidence, aggregateLessonOutcomes

import { describe, it, expect } from 'vitest';
import {
  computeOutcomeConfidence,
  aggregateLessonOutcomes,
  type LessonAttributionEntry,
} from '../lesson-attribution.js';
import { computeLessonId } from '../../team/engine/learnings/lesson-id.js';

// ---------------------------------------------------------------------------
// computeOutcomeConfidence
// ---------------------------------------------------------------------------

describe('computeOutcomeConfidence', () => {
  it('returns 0.5 with zero data (Beta(1,1) prior)', () => {
    expect(computeOutcomeConfidence(0, 0)).toBe(0.5);
  });

  it('approaches 0.95 clamp with many passes', () => {
    // passes=99, appearances=100 → (100/102) ≈ 0.98 → clamped to 0.95
    expect(computeOutcomeConfidence(99, 100)).toBe(0.95);
  });

  it('approaches 0.05 clamp with many failures', () => {
    // passes=0, appearances=100 → (1/102) ≈ 0.0098 → clamped to 0.05
    expect(computeOutcomeConfidence(0, 100)).toBe(0.05);
  });

  it('returns a value strictly between 0.05 and 0.95 for mixed outcomes', () => {
    const result = computeOutcomeConfidence(3, 6);
    expect(result).toBeGreaterThan(0.05);
    expect(result).toBeLessThan(0.95);
  });

  it('always stays within [0.05, 0.95]', () => {
    // Edge cases
    for (const [p, a] of [[0, 0], [0, 1], [1, 1], [5, 5], [0, 1000], [1000, 1000]] as const) {
      const conf = computeOutcomeConfidence(p, a);
      expect(conf).toBeGreaterThanOrEqual(0.05);
      expect(conf).toBeLessThanOrEqual(0.95);
    }
  });

  it('is monotonically increasing in passes for fixed appearances', () => {
    const appearances = 10;
    let prev = computeOutcomeConfidence(0, appearances);
    for (let p = 1; p <= appearances; p++) {
      const curr = computeOutcomeConfidence(p, appearances);
      expect(curr).toBeGreaterThanOrEqual(prev);
      prev = curr;
    }
  });
});

// ---------------------------------------------------------------------------
// aggregateLessonOutcomes
// ---------------------------------------------------------------------------

const LESSON_A = 'Use execFile not exec to prevent shell injection.';
const LESSON_B = 'Always validate inputs at the API boundary.';
const LESSON_A_ID = computeLessonId(LESSON_A);
const LESSON_B_ID = computeLessonId(LESSON_B);

function makeRow(
  overrides: Partial<LessonAttributionEntry> = {},
): LessonAttributionEntry {
  return {
    id: 'test-id',
    cycleId: 'cycle-1',
    itemId: 'item-1',
    agentId: 'coder',
    lessonId: LESSON_A_ID,
    lessonText: LESSON_A,
    scope: 'cycle',
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('aggregateLessonOutcomes', () => {
  it('returns empty map for empty input', () => {
    const result = aggregateLessonOutcomes([]);
    expect(result.size).toBe(0);
  });

  it('rows without gateVerdict do NOT count as appearances', () => {
    const rows = [
      makeRow({ lessonId: LESSON_A_ID }), // no gateVerdict
    ];
    const result = aggregateLessonOutcomes(rows);
    expect(result.size).toBe(0);
  });

  it('counts a single approved+verifyPassed row as 1 pass, 1 appearance', () => {
    const rows = [
      makeRow({ gateVerdict: 'approved', verifyPassed: true }),
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    expect(stats).toBeDefined();
    expect(stats!.appearances).toBe(1);
    expect(stats!.passes).toBe(1);
  });

  it('counts rejected row as 0 passes, 1 appearance', () => {
    const rows = [
      makeRow({ gateVerdict: 'rejected' }),
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    expect(stats).toBeDefined();
    expect(stats!.appearances).toBe(1);
    expect(stats!.passes).toBe(0);
  });

  it('approved with verifyPassed=false counts as 0 passes (NOT a pass)', () => {
    const rows = [
      makeRow({ gateVerdict: 'approved', verifyPassed: false }),
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    expect(stats).toBeDefined();
    expect(stats!.appearances).toBe(1);
    expect(stats!.passes).toBe(0);
  });

  it('approved without verifyPassed (undefined) counts as a pass', () => {
    // verifyPassed undefined means no verify data → NOT false → counts as pass
    const row = makeRow({ gateVerdict: 'approved' });
    // ensure verifyPassed is truly absent
    delete (row as Partial<LessonAttributionEntry>).verifyPassed;
    const result = aggregateLessonOutcomes([row]);
    const stats = result.get(LESSON_A_ID);
    expect(stats!.passes).toBe(1);
  });

  it('deduplicates duplicate (cycle,item,lesson) rows — only latest with verdict counts once', () => {
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z'; // later timestamp
    const rows = [
      makeRow({ ts: ts1, gateVerdict: 'approved', verifyPassed: true }),
      // Same (cycleId, itemId, lessonId) — should be deduped, latest wins
      makeRow({ ts: ts2, gateVerdict: 'rejected' }),
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    // Should be 1 appearance (deduped), and the LATEST row (rejected) wins
    expect(stats!.appearances).toBe(1);
    expect(stats!.passes).toBe(0); // latest was rejected
  });

  it('different (cycle,item,lesson) triplets count as separate appearances', () => {
    const rows = [
      makeRow({ cycleId: 'cycle-1', itemId: 'item-1', gateVerdict: 'approved', verifyPassed: true }),
      makeRow({ cycleId: 'cycle-2', itemId: 'item-1', gateVerdict: 'approved', verifyPassed: true }),
      makeRow({ cycleId: 'cycle-3', itemId: 'item-1', gateVerdict: 'rejected' }),
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    expect(stats!.appearances).toBe(3);
    expect(stats!.passes).toBe(2);
  });

  it('tracks multiple distinct lessonIds independently', () => {
    const rows = [
      makeRow({ lessonId: LESSON_A_ID, cycleId: 'c1', gateVerdict: 'approved', verifyPassed: true }),
      makeRow({ lessonId: LESSON_A_ID, cycleId: 'c2', gateVerdict: 'approved', verifyPassed: true }),
      makeRow({ lessonId: LESSON_B_ID, lessonText: LESSON_B, cycleId: 'c1', gateVerdict: 'rejected' }),
    ];
    const result = aggregateLessonOutcomes(rows);
    expect(result.get(LESSON_A_ID)!.appearances).toBe(2);
    expect(result.get(LESSON_A_ID)!.passes).toBe(2);
    expect(result.get(LESSON_B_ID)!.appearances).toBe(1);
    expect(result.get(LESSON_B_ID)!.passes).toBe(0);
  });

  it('handles rows with undefined gateVerdict mixed with verdict rows correctly', () => {
    const rows = [
      makeRow({ cycleId: 'c1' }), // no verdict — not counted
      makeRow({ cycleId: 'c2', gateVerdict: 'approved', verifyPassed: true }), // counts
    ];
    const result = aggregateLessonOutcomes(rows);
    const stats = result.get(LESSON_A_ID);
    expect(stats!.appearances).toBe(1);
    expect(stats!.passes).toBe(1);
  });
});
