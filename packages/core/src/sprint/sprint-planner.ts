import { generateId, nowIso } from '@agentforge/shared';
import type { BacklogItem, SprintPlan } from './types.js';

/** Determines how many items to pull per priority in a sprint. */
const PRIORITY_SLOTS = { P0: 3, P1: 4, P2: 2 };

export class SprintPlanner {
  private backlog: BacklogItem[] = [];

  /** Add items to the backlog. */
  seed(items: BacklogItem[]): void {
    this.backlog.push(...items);
  }

  /** Get the current backlog. */
  getBacklog(): BacklogItem[] {
    return [...this.backlog];
  }

  /** Remove a backlog item by ID (after it ships). */
  remove(id: string): void {
    this.backlog = this.backlog.filter(item => item.id !== id);
  }

  /**
   * Generate the next sprint plan from the backlog.
   * Pulls P0 items first, then P1, then P2 up to slot limits.
   */
  plan(nextVersion: string, budgetUsd = 5.00): SprintPlan {
    const selected: BacklogItem[] = [];
    const remaining = [...this.backlog];

    for (const priority of ['P0', 'P1', 'P2'] as const) {
      const slots = PRIORITY_SLOTS[priority];
      const candidates = remaining.filter(i => i.priority === priority);
      const picked = candidates.slice(0, slots);
      selected.push(...picked);
      picked.forEach(p => remaining.splice(remaining.indexOf(p), 1));
    }

    return {
      version: nextVersion,
      name: `v${nextVersion} — Autonomous Sprint`,
      plannedAt: nowIso(),
      budgetUsd,
      source: 'autonomous',
      items: selected.map(item => ({
        id: item.id,
        priority: item.priority,
        title: item.title,
        description: item.description,
        status: 'pending',
      })),
    };
  }
}
