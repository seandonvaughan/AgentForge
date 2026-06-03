// packages/core/src/autonomous/decompose/flatten.ts
//
// Flatten a wave-layered EpicPlan into plan.json item objects. The shape
// matches SprintPlanItem (sprint-generator.ts) including the epic fields
// added in PR-0 (parentEpicId/wave/predecessors). (spec 2026-05-30 §6.4)

import type { EpicPlan } from './types.js';

export interface FlattenedPlanItem {
  id: string;
  title: string;
  description: string;
  priority: 'P1';
  assignee: string;
  status: 'planned';
  estimatedCostUsd: number;
  tags: string[];
  files: string[];
  parentEpicId: string;
  wave: number;
  predecessors: string[];
}

export function flattenEpicPlanToPlanItems(plan: EpicPlan): FlattenedPlanItem[] {
  return plan.children.map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    priority: 'P1',
    assignee: c.suggestedAssignee,
    status: 'planned',
    estimatedCostUsd: c.estimatedCostUsd,
    tags: [...c.capabilityTags],
    files: [...c.files],
    parentEpicId: plan.epicId,
    wave: c.wave ?? 0,
    predecessors: [...c.predecessors],
  }));
}
