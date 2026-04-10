// packages/core/src/autonomous/phase-handlers/sprint-utils.ts
//
// Shared utility functions used by multiple phase handlers.
// Lives here (not in review-phase.ts or gate-phase.ts) to prevent the
// circular import that would arise from gate-phase importing from
// review-phase while review-phase imports from gate-phase.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the sprint JSON and collect all unique item-level domain tags across all
 * items in the sprint. Returns an empty array when the sprint file is absent
 * or unreadable — failure must never block any phase handler from completing.
 *
 * These domain tags are appended to memory entries written by the review and
 * gate phase handlers so that the execute-phase memory injector can find
 * findings from prior cycles that are relevant to the current item's domain
 * tags.
 *
 * Without this, review/gate findings carry only structural tags
 * (review/finding/critical) that never overlap with sprint item domain tags
 * (memory/execute/backend/...), silently breaking the cross-cycle feedback loop.
 */
export function collectSprintItemTags(projectRoot: string, sprintVersion: string): string[] {
  try {
    const sprintPath = join(projectRoot, '.agentforge', 'sprints', `v${sprintVersion}.json`);
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
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
    // Sprint file absent or unreadable — return empty so the caller still
    // writes the structural tags and doesn't lose the finding.
    return [];
  }
}
