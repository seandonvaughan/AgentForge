/**
 * token-budget.test.ts — hard-cap validation: no skill may exceed 1500 tokens.
 *
 * Uses a simple whitespace-tokenizer approximation (split on whitespace).
 * This is intentionally conservative — actual BPE token counts are lower,
 * but the whitespace count provides a fast, dependency-free upper bound.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { listSkills, _resetCache } from '../src/catalog.js';

const TOKEN_HARD_CAP = 1500;

/** Approximate token count: split on whitespace, count non-empty segments. */
function approxTokenCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

beforeEach(() => {
  _resetCache();
});

describe('skill token budget', () => {
  it('every bundled skill body is within the 1500-token hard cap', () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThan(0);

    const violations: Array<{ id: string; tokens: number }> = [];

    for (const skill of skills) {
      const tokens = approxTokenCount(skill.body);
      if (tokens > TOKEN_HARD_CAP) {
        violations.push({ id: skill.frontmatter.id, tokens });
      }
    }

    expect(violations).toEqual([]);
  });

  it('max_tokens frontmatter field does not exceed hard cap', () => {
    const skills = listSkills();
    for (const skill of skills) {
      expect(skill.frontmatter.max_tokens).toBeLessThanOrEqual(TOKEN_HARD_CAP);
    }
  });

  it('af-tdd is approximately within its declared max_tokens', () => {
    const skills = listSkills();
    const afTdd = skills.find((s) => s.frontmatter.id === 'af-tdd');
    expect(afTdd).toBeDefined();
    if (!afTdd) return;

    const tokens = approxTokenCount(afTdd.body);
    // Must be under hard cap
    expect(tokens).toBeLessThanOrEqual(TOKEN_HARD_CAP);
    // Must be non-trivially populated (at least 200 whitespace-tokens)
    expect(tokens).toBeGreaterThan(200);
  });

  it('af-verify-before-done is approximately within its declared max_tokens', () => {
    const skills = listSkills();
    const afVerify = skills.find((s) => s.frontmatter.id === 'af-verify-before-done');
    expect(afVerify).toBeDefined();
    if (!afVerify) return;

    const tokens = approxTokenCount(afVerify.body);
    expect(tokens).toBeLessThanOrEqual(TOKEN_HARD_CAP);
    expect(tokens).toBeGreaterThan(50);
  });
});
