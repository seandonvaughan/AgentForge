/**
 * Coverage for sanitizePrTitle — extracted from CycleRunner so the gh CLI
 * crash on cycle b8755f16 cannot recur silently.
 *
 * The original failure produced:
 *   gh pr create --title autonomous(v6.7.0): All three items are well within the $50 cycle budg
 * which (a) had unquoted parens, (b) was truncated mid-word at "budg".
 */
import { describe, it, expect } from 'vitest';
import { sanitizePrTitle } from '../../../packages/core/src/autonomous/cycle-runner.js';

describe('sanitizePrTitle', () => {
  it('passes a short summary through with the autonomous prefix', () => {
    const out = sanitizePrTitle('6.7.0', 'fix readme typo');
    expect(out).toBe('autonomous v6.7.0: fix readme typo');
  });

  it('strips parens (gh CLI parses unquoted parens as option groups)', () => {
    const out = sanitizePrTitle('6.7.0', 'fix bug (regression from PR #42)');
    expect(out).not.toContain('(');
    expect(out).not.toContain(')');
    expect(out).toContain('fix bug regression from PR #42');
  });

  it('collapses newlines in the summary into single spaces', () => {
    const out = sanitizePrTitle('6.7.0', 'first line\nsecond line\n\nthird');
    expect(out).toContain('first line second line third');
    expect(out).not.toContain('\n');
  });

  it('truncates at a word boundary, not mid-word, with ellipsis', () => {
    const longSummary =
      'All three items are well within the $50 cycle budget at a combined estimated cost of two dollars';
    const out = sanitizePrTitle('6.7.0', longSummary);
    expect(out.length).toBeLessThanOrEqual(70); // prefix + room + ellipsis
    expect(out.endsWith('…')).toBe(true);
    // Critical: must not end mid-word like "budg" — verify by reconstructing
    // the original word boundary. The char immediately following our cut
    // point in the source must be a space (or the cut hit end-of-string),
    // proving we sliced on a real word boundary not mid-word.
    const beforeEllipsis = out.slice(0, -1);
    const tail = beforeEllipsis.slice(beforeEllipsis.lastIndexOf(' ') + 1);
    // The tail (last word in the truncated title) must appear as a complete
    // word in the original summary, surrounded by spaces or end-of-string.
    const wordRegex = new RegExp(`(^|\\s)${tail}(\\s|$)`);
    expect(longSummary).toMatch(wordRegex);
  });

  it('handles the exact failing summary from cycle b8755f16', () => {
    const original =
      'All three items are well within the $50 cycle budget at a combined estimated cost of $2.50.';
    const out = sanitizePrTitle('6.7.0', original);
    // Must not contain parens, must not be truncated mid-word
    expect(out).not.toContain('(');
    expect(out).not.toContain(')');
    expect(out).not.toMatch(/budg$/);
    // Must start with the right prefix
    expect(out.startsWith('autonomous v6.7.0:')).toBe(true);
  });

  it('falls back to a hard cut when the first 20 chars contain no space', () => {
    // Pathological summary: one giant word with no spaces
    const out = sanitizePrTitle('6.7.0', 'X'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(70);
    expect(out.endsWith('…')).toBe(true);
  });
});
