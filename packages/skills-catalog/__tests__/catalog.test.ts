/**
 * catalog.test.ts — unit tests for the fs-backed skills registry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadSkill, listSkills, _resetCache } from '../src/catalog.js';

beforeEach(() => {
  _resetCache();
});

describe('listSkills', () => {
  it('returns an array', () => {
    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
  });

  it('includes the bundled pilot skills', () => {
    const skills = listSkills();
    const ids = skills.map((s) => s.frontmatter.id);
    expect(ids).toContain('af-tdd');
    expect(ids).toContain('af-verify-before-done');
  });

  it('returns skills sorted by id', () => {
    const skills = listSkills();
    for (let i = 1; i < skills.length; i++) {
      const prev = skills[i - 1];
      const curr = skills[i];
      if (prev && curr) {
        expect(prev.frontmatter.id.localeCompare(curr.frontmatter.id)).toBeLessThanOrEqual(0);
      }
    }
  });
});

describe('loadSkill', () => {
  it('returns a Skill for a known id', () => {
    const skill = loadSkill('af-tdd');
    expect(skill).not.toBeNull();
    expect(skill?.frontmatter.id).toBe('af-tdd');
  });

  it('returns null for an unknown id', () => {
    const skill = loadSkill('does-not-exist-xxxxxxx');
    expect(skill).toBeNull();
  });

  it('skill body is non-empty', () => {
    const skill = loadSkill('af-tdd');
    expect(skill?.body.length).toBeGreaterThan(50);
  });

  it('frontmatter has required fields', () => {
    const skill = loadSkill('af-verify-before-done');
    expect(skill).not.toBeNull();
    const fm = skill!.frontmatter;
    expect(fm.id).toBe('af-verify-before-done');
    expect(typeof fm.version).toBe('string');
    expect(Array.isArray(fm.tags)).toBe(true);
    expect(Array.isArray(fm.applies_to)).toBe(true);
    expect(typeof fm.max_tokens).toBe('number');
  });

  it('caches results (same reference on repeated calls)', () => {
    const first = loadSkill('af-tdd');
    const second = loadSkill('af-tdd');
    // Same object reference — cache hit
    expect(first).toBe(second);
  });
});
