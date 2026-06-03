// packages/core/src/team/engine/learnings/__tests__/lesson-id.test.ts

import { describe, it, expect } from 'vitest';
import { computeLessonId } from '../lesson-id.js';

describe('computeLessonId', () => {
  it('is byte-identical across repeated calls', () => {
    const text = 'Use execFile instead of exec to prevent shell injection.';
    const id1 = computeLessonId(text);
    const id2 = computeLessonId(text);
    expect(id1).toBe(id2);
  });

  it('is byte-identical across casing variants', () => {
    const lower = 'use execfile instead of exec to prevent shell injection.';
    const upper = 'USE EXECFILE INSTEAD OF EXEC TO PREVENT SHELL INJECTION.';
    const mixed = 'Use ExecFile Instead Of Exec To Prevent Shell Injection.';
    expect(computeLessonId(lower)).toBe(computeLessonId(upper));
    expect(computeLessonId(lower)).toBe(computeLessonId(mixed));
  });

  it('is byte-identical across whitespace variants (leading/trailing/extra spaces)', () => {
    const base = 'use execfile instead of exec';
    const withSpaces = '  use  execfile  instead  of  exec  ';
    const withTab = '\tuse execfile instead of exec\n';
    expect(computeLessonId(base)).toBe(computeLessonId(withSpaces));
    expect(computeLessonId(base)).toBe(computeLessonId(withTab));
  });

  it('is byte-identical when a trailing period is added or removed', () => {
    const withPeriod = 'Always use js-yaml dump for YAML serialization.';
    const withoutPeriod = 'Always use js-yaml dump for YAML serialization';
    // The normalisation strips punctuation so these should map to the same hash.
    expect(computeLessonId(withPeriod)).toBe(computeLessonId(withoutPeriod));
  });

  it('produces different 12-char hash prefixes for two clearly different lessons', () => {
    const lessonA = 'Use execFile not exec for subprocess calls to avoid shell injection.';
    const lessonB = 'Always add tests before modifying existing functionality.';
    const idA = computeLessonId(lessonA);
    const idB = computeLessonId(lessonB);
    // IDs should differ
    expect(idA).not.toBe(idB);
    // Extract the 12-char hash prefix (everything before the first '-' after pos 12)
    const hashA = idA.slice(0, 12);
    const hashB = idB.slice(0, 12);
    expect(hashA).not.toBe(hashB);
  });

  it('returns a string with the expected format: 12 hex chars + dash + slug', () => {
    const id = computeLessonId('Never use regex on user-controlled input for substring matching.');
    // Format: exactly 12 hex chars, then dash, then slug chars
    expect(id).toMatch(/^[0-9a-f]{12}-[a-z0-9-]+$/);
  });

  it('handles an empty string gracefully (falls back to "lesson" slug)', () => {
    const id = computeLessonId('');
    expect(id).toMatch(/^[0-9a-f]{12}-lesson$/);
  });
});
