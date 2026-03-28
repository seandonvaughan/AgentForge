import { nowIso } from '@agentforge/shared';
import type { SprintSummary } from './types.js';

export class SprintReporter {
  private summaries: Map<string, SprintSummary> = new Map();

  startSprint(sprintVersion: string, itemsPlanned: number, testCountBefore: number): SprintSummary {
    const summary: SprintSummary = {
      sprintVersion,
      plannedAt: nowIso(),
      itemsPlanned,
      itemsCompleted: 0,
      itemsFailed: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      testCountBefore,
      testCountAfter: testCountBefore,
      promoted: false,
      verdict: 'in_progress',
      highlights: [],
    };
    this.summaries.set(sprintVersion, summary);
    return summary;
  }

  completeSprint(
    sprintVersion: string,
    updates: Partial<Omit<SprintSummary, 'sprintVersion' | 'plannedAt'>>,
  ): SprintSummary | null {
    const summary = this.summaries.get(sprintVersion);
    if (!summary) return null;
    Object.assign(summary, { ...updates, completedAt: nowIso() });
    return summary;
  }

  get(sprintVersion: string): SprintSummary | null {
    return this.summaries.get(sprintVersion) ?? null;
  }

  list(): SprintSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.plannedAt.localeCompare(a.plannedAt));
  }
}
