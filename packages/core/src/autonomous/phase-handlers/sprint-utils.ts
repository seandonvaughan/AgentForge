// packages/core/src/autonomous/phase-handlers/sprint-utils.ts
//
// Shared utility functions used by multiple phase handlers.
// Lives here (not in review-phase.ts or gate-phase.ts) to prevent the
// circular import that would arise from gate-phase importing from
// review-phase while review-phase imports from gate-phase.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve the path to the sprint/plan file for the current phase context.
 *
 * New cycles (with a cycleId) write plan.json directly into the cycle
 * directory — cycles/{cycleId}/plan.json. Legacy cycles (no cycleId, or
 * running against a pre-migration archive) fall back to the historical
 * .agentforge/sprints/v{N}.json location.
 */
export function sprintPlanPath(
  projectRoot: string,
  sprintVersion: string,
  cycleId?: string,
): string {
  if (cycleId) {
    return join(projectRoot, '.agentforge', 'cycles', cycleId, 'plan.json');
  }
  return join(projectRoot, '.agentforge', 'sprints', `v${sprintVersion}.json`);
}

/**
 * Read the sprint/plan JSON and collect all unique item-level domain tags
 * across all items. Returns an empty array when the file is absent or
 * unreadable — failure must never block any phase handler from completing.
 *
 * Checks cycles/{cycleId}/plan.json first (new path), then falls back to
 * .agentforge/sprints/v{N}.json (legacy archive). The legacy file uses a
 * { sprints: [{ items: [] }] } wrapper; plan.json is a flat SprintPlan.
 *
 * These domain tags are appended to memory entries written by the review and
 * gate phase handlers so that the execute-phase memory injector can find
 * findings from prior cycles that are relevant to the current item's domain
 * tags.
 */
export function collectSprintItemTags(
  projectRoot: string,
  sprintVersion: string,
  cycleId?: string,
): string[] {
  try {
    const planPath = sprintPlanPath(projectRoot, sprintVersion, cycleId);
    const raw = readFileSync(planPath, 'utf8');
    const parsed = JSON.parse(raw);
    // plan.json is flat; legacy sprints file may have a { sprints: [] } wrapper
    const sprintObj: { items?: Array<{ tags?: string[] }> } | null =
      parsed.items ? parsed : (parsed.sprints?.[0] ?? null);
    const items = sprintObj?.items ?? [];
    const tagSet = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags ?? []) {
        tagSet.add(tag.toLowerCase());
      }
    }
    return Array.from(tagSet);
  } catch {
    // File absent or unreadable — return empty so the caller still
    // writes the structural tags and doesn't lose the finding.
    return [];
  }
}
