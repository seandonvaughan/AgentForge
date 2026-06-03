// packages/core/src/memory/__tests__/lesson-attribution.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendLessonAttributions,
  readLessonAttributions,
  type LessonAttributionEntry,
} from '../lesson-attribution.js';
import { computeLessonId } from '../../team/engine/learnings/lesson-id.js';

const LESSON_TEXT_A = 'Use execFile not exec to prevent shell injection.';
const LESSON_TEXT_B = 'Always use js-yaml dump for YAML serialization.';
const LESSON_TEXT_C = 'Add tests before modifying existing functionality.';

function makeRow(
  overrides: Partial<Omit<LessonAttributionEntry, 'id' | 'ts'>> = {},
): Omit<LessonAttributionEntry, 'id' | 'ts'> {
  return {
    cycleId: 'cycle-abc',
    itemId: 'item-1',
    agentId: 'coder-agent',
    lessonId: computeLessonId(LESSON_TEXT_A),
    lessonText: LESSON_TEXT_A,
    scope: 'cycle',
    ...overrides,
  };
}

describe('appendLessonAttributions / readLessonAttributions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-lesson-attr-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends 3 rows then re-reads exactly 3 valid entries', () => {
    const rows = [
      makeRow({ lessonId: computeLessonId(LESSON_TEXT_A), lessonText: LESSON_TEXT_A }),
      makeRow({ itemId: 'item-2', lessonId: computeLessonId(LESSON_TEXT_B), lessonText: LESSON_TEXT_B }),
      makeRow({ itemId: 'item-3', lessonId: computeLessonId(LESSON_TEXT_C), lessonText: LESSON_TEXT_C }),
    ];
    appendLessonAttributions(tmpDir, rows);

    const entries = readLessonAttributions(tmpDir);
    expect(entries).toHaveLength(3);
  });

  it('each entry has stable lessonIds matching computeLessonId output', () => {
    const rows = [
      makeRow({ lessonId: computeLessonId(LESSON_TEXT_A), lessonText: LESSON_TEXT_A }),
      makeRow({ itemId: 'item-2', lessonId: computeLessonId(LESSON_TEXT_B), lessonText: LESSON_TEXT_B }),
    ];
    appendLessonAttributions(tmpDir, rows);

    const entries = readLessonAttributions(tmpDir);
    expect(entries[0]?.lessonId).toBe(computeLessonId(LESSON_TEXT_A));
    expect(entries[1]?.lessonId).toBe(computeLessonId(LESSON_TEXT_B));
  });

  it('every line in the JSONL file is valid JSON', () => {
    appendLessonAttributions(tmpDir, [
      makeRow({ lessonId: computeLessonId(LESSON_TEXT_A), lessonText: LESSON_TEXT_A }),
    ]);
    const filePath = join(tmpDir, '.agentforge', 'memory', 'lesson-attribution.jsonl');
    const lines = readFileSync(filePath, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('stamps id (UUID) and ts (ISO) on each appended row', () => {
    appendLessonAttributions(tmpDir, [makeRow()]);
    const entries = readLessonAttributions(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.id).toBeTruthy();
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
    expect(entry.ts).toBeTruthy();
    expect(() => new Date(entry.ts)).not.toThrow();
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
  });

  it('preserves optional gateVerdict and verifyPassed fields when provided', () => {
    const rowWithGate = {
      ...makeRow(),
      gateVerdict: 'approved' as const,
    };
    const rowWithVerify = {
      ...makeRow({ itemId: 'item-2' }),
      verifyPassed: true,
    };
    appendLessonAttributions(tmpDir, [rowWithGate, rowWithVerify]);

    const entries = readLessonAttributions(tmpDir);
    expect(entries[0]?.gateVerdict).toBe('approved');
    expect(entries[1]?.verifyPassed).toBe(true);
  });

  it('does NOT set gateVerdict or verifyPassed when omitted (no undefined values)', () => {
    appendLessonAttributions(tmpDir, [makeRow()]);
    const entries = readLessonAttributions(tmpDir);
    const entry = entries[0]!;
    expect('gateVerdict' in entry).toBe(false);
    expect('verifyPassed' in entry).toBe(false);
  });

  it('returns empty array when no file exists', () => {
    const entries = readLessonAttributions(tmpDir);
    expect(entries).toEqual([]);
  });

  it('appends in multiple calls — all rows accumulate', () => {
    appendLessonAttributions(tmpDir, [makeRow()]);
    appendLessonAttributions(tmpDir, [makeRow({ itemId: 'item-2' })]);
    const entries = readLessonAttributions(tmpDir);
    expect(entries).toHaveLength(2);
  });

  it('skips malformed lines without crashing', () => {
    // Write a valid row first
    appendLessonAttributions(tmpDir, [makeRow()]);

    // Inject a malformed line into the file
    const filePath = join(tmpDir, '.agentforge', 'memory', 'lesson-attribution.jsonl');
    appendFileSync(filePath, 'NOT_VALID_JSON\n', 'utf8');

    // Write a second valid row
    appendLessonAttributions(tmpDir, [makeRow({ itemId: 'item-2' })]);

    const entries = readLessonAttributions(tmpDir);
    // Only the 2 valid rows should be returned
    expect(entries).toHaveLength(2);
  });

  it('is non-fatal when projectRoot is read-only (swallows error)', () => {
    // Write to a nonexistent deeply nested path — should not throw
    expect(() =>
      appendLessonAttributions('/nonexistent-path-that-cannot-be-created/abc', [makeRow()]),
    ).not.toThrow();
  });

  it('the lock file is absent after a successful write', () => {
    appendLessonAttributions(tmpDir, [makeRow()]);
    const lockPath = join(tmpDir, '.agentforge', 'memory', 'lesson-attribution.jsonl.lock');
    expect(existsSync(lockPath)).toBe(false);
  });
});
