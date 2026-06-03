import { describe, it, expect } from 'vitest';
import { flattenEpicPlanToPlanItems } from '../flatten.js';
import type { EpicPlan } from '../types.js';

const plan: EpicPlan = {
  epicId: 'epic-abc12345',
  rationale: 'r',
  children: [
    { id: 'c1', title: 'type', description: 'add type', files: ['shared.ts'], capabilityTags: ['types'],
      suggestedAssignee: 'shared-utils-engineer', estimatedCostUsd: 2, estimatedComplexity: 'low', predecessors: [], wave: 0 },
    { id: 'c2', title: 'api', description: 'use type', files: ['api.ts'], capabilityTags: ['route'],
      suggestedAssignee: 'fastify-v5-engineer', estimatedCostUsd: 3, estimatedComplexity: 'medium', predecessors: ['c1'], wave: 1 },
  ],
};

describe('flattenEpicPlanToPlanItems', () => {
  it('maps children to plan items carrying epic fields', () => {
    const items = flattenEpicPlanToPlanItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'c1', title: 'type', assignee: 'shared-utils-engineer', status: 'planned',
      parentEpicId: 'epic-abc12345', wave: 0, predecessors: [], tags: ['types'], files: ['shared.ts'],
    });
    expect(items[1]!.predecessors).toEqual(['c1']);
    expect(items[1]!.wave).toBe(1);
  });

  it('defaults wave to 0 when a child was not layered', () => {
    const unlayered: EpicPlan = { ...plan, children: [{ ...plan.children[0]!, wave: undefined }] };
    expect(flattenEpicPlanToPlanItems(unlayered)[0]!.wave).toBe(0);
  });
});
