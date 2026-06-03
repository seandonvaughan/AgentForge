import { describe, expect, it } from 'vitest';
import { buildOutcomeRows } from '../learnings.js';

type AttributionEntry = Parameters<typeof buildOutcomeRows>[0][number];

function makeEntry(
  lessonId: string,
  cycleIndex: number,
  gateVerdict: AttributionEntry['gateVerdict'],
  verifyPassed?: boolean,
): AttributionEntry {
  return {
    id: `${lessonId}-${cycleIndex}`,
    cycleId: `cycle-${cycleIndex}`,
    itemId: `item-${cycleIndex}`,
    agentId: 'cli-engineer',
    lessonId,
    lessonText: `Lesson text for ${lessonId}`,
    ...(gateVerdict !== undefined ? { gateVerdict } : {}),
    ...(verifyPassed !== undefined ? { verifyPassed } : {}),
    scope: 'cycle',
    ts: `2026-01-0${cycleIndex}T00:00:00.000Z`,
  };
}

describe('buildOutcomeRows', () => {
  it('sorts lessons by computed outcome confidence from attribution outcomes', () => {
    const rows = buildOutcomeRows([
      makeEntry('lesson-a', 1, 'approved', true),
      makeEntry('lesson-a', 2, 'approved', true),
      makeEntry('lesson-a', 3, 'approved', true),
      makeEntry('lesson-b', 4, 'rejected'),
      makeEntry('lesson-b', 5, 'rejected'),
      makeEntry('lesson-b', 6, 'rejected'),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.lessonId).toBe('lesson-a');
    expect(rows[1]?.lessonId).toBe('lesson-b');
    expect(rows[0]?.outcomeConfidence).toBeGreaterThan(rows[1]?.outcomeConfidence ?? 0);
    expect(rows[0]?.passes).toBe(3);
    expect(rows[1]?.passes).toBe(0);
    expect(rows[0]?.appearances).toBe(3);
    expect(rows[1]?.appearances).toBe(3);
  });

  it('returns an empty array for empty input', () => {
    expect(buildOutcomeRows([])).toEqual([]);
  });
});
