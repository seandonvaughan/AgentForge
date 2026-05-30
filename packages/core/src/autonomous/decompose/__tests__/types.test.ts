import { describe, it, expect } from 'vitest';
import { EpicChildSchema, EpicPlanSchema, EpicObjectiveSchema } from '../types.js';

describe('EpicChildSchema', () => {
  const valid = {
    id: 'child-1',
    title: 'Add shared type',
    description: 'create the RBAC type',
    files: ['packages/shared/src/rbac.ts'],
    capabilityTags: ['types'],
    suggestedAssignee: 'shared-utils-engineer',
    estimatedCostUsd: 5,
    estimatedComplexity: 'low',
    predecessors: [],
  };

  it('accepts a valid child', () => {
    expect(EpicChildSchema.parse(valid).id).toBe('child-1');
  });

  it('rejects an invalid complexity', () => {
    expect(() => EpicChildSchema.parse({ ...valid, estimatedComplexity: 'huge' })).toThrow();
  });

  it('rejects a negative cost', () => {
    expect(() => EpicChildSchema.parse({ ...valid, estimatedCostUsd: -1 })).toThrow();
  });

  it('defaults predecessors to [] when omitted', () => {
    const { predecessors, ...noPred } = valid;
    expect(EpicChildSchema.parse(noPred).predecessors).toEqual([]);
  });
});

describe('EpicPlanSchema', () => {
  it('parses a plan with children', () => {
    const plan = EpicPlanSchema.parse({
      epicId: 'epic-abc12345',
      rationale: 'split into type + consumer',
      children: [
        { id: 'c1', title: 't', description: 'd', files: ['a.ts'], capabilityTags: ['x'],
          suggestedAssignee: 'eng', estimatedCostUsd: 1, estimatedComplexity: 'low', predecessors: [] },
      ],
    });
    expect(plan.children).toHaveLength(1);
  });

  it('rejects an empty children array', () => {
    expect(() => EpicPlanSchema.parse({ epicId: 'epic-1', rationale: 'r', children: [] })).toThrow();
  });
});

describe('EpicObjectiveSchema', () => {
  it('parses an objective', () => {
    const o = EpicObjectiveSchema.parse({
      id: 'epic-abc12345', title: 'RBAC', description: 'add rbac', createdAt: '2026-05-30T00:00:00.000Z',
    });
    expect(o.constraints).toBeUndefined();
  });
});
