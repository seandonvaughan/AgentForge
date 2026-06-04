import { describe, expect, it } from 'vitest';
import type { Skill } from '@agentforge/skills-catalog';
import { resolveAgentSkills } from '../skill-resolver.js';

const mandatorySkill: Skill = {
  frontmatter: {
    id: 'af-tdd',
    version: '1.0.0',
    tags: ['testing'],
    applies_to: ['test'],
    mandatory_for: ['test-engineer'],
    max_tokens: 1000,
    requires_tools: ['Read'],
  },
  body: 'Use TDD.',
  filePath: '/skills/af-tdd.md',
};

const loadSkill = (id: string): Skill | null => (id === 'af-tdd' ? mandatorySkill : null);
const listAllSkills = (): Skill[] => [mandatorySkill];

describe('resolveAgentSkills mandatory_for', () => {
  it('injects a mandatory skill for a matching agent with no skill_ids', () => {
    const result = resolveAgentSkills(
      { skill_ids: undefined },
      loadSkill,
      'test-engineer',
      listAllSkills,
    );

    expect(result.skillIds).toContain('af-tdd');
    expect(result.resolvedSkills).toHaveLength(1);
    expect(result.resolvedSkills[0]?.id).toBe('af-tdd');
    expect(result.missingSkillIds).toEqual([]);
    expect(result.requiredTools).toEqual(['Read']);
  });

  it('does not duplicate a mandatory skill already requested by skill_ids', () => {
    const result = resolveAgentSkills(
      { skill_ids: ['af-tdd'] },
      loadSkill,
      'test-engineer',
      listAllSkills,
    );

    expect(result.resolvedSkills).toHaveLength(1);
  });

  it('does not inject mandatory skills for another agent', () => {
    const result = resolveAgentSkills(
      { skill_ids: undefined },
      loadSkill,
      'other-agent',
      listAllSkills,
    );

    expect(result.resolvedSkills).toEqual([]);
  });
});
