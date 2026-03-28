import type { SprintHistoryRecord, PriorityTier } from './types.js';

export interface HistoryAnalysis {
  avgCompletionRate: number;
  avgCostPerPriorityTier: Record<PriorityTier, number>;
  commonFailurePatterns: string[];
  avgDurationDays: number;
  totalSprints: number;
  avgCostUsd: number;
}

export class HistoryAnalyzer {
  analyze(records: SprintHistoryRecord[]): HistoryAnalysis {
    if (records.length === 0) {
      return {
        avgCompletionRate: 0,
        avgCostPerPriorityTier: { P0: 0, P1: 0, P2: 0, P3: 0 },
        commonFailurePatterns: [],
        avgDurationDays: 0,
        totalSprints: 0,
        avgCostUsd: 0,
      };
    }

    // Completion rate
    const completionRates = records.map(r =>
      r.plannedItems > 0 ? r.completedItems / r.plannedItems : 0,
    );
    const avgCompletionRate = completionRates.reduce((a, b) => a + b, 0) / records.length;

    // Cost per priority tier
    const tierCosts: Record<PriorityTier, number[]> = { P0: [], P1: [], P2: [], P3: [] };
    for (const record of records) {
      for (const tier of ['P0', 'P1', 'P2', 'P3'] as PriorityTier[]) {
        const completed = record.completedByPriority[tier] ?? 0;
        if (completed > 0) {
          const share = completed / record.completedItems;
          tierCosts[tier].push((share * record.totalCostUsd) / completed);
        }
      }
    }

    const avgCostPerPriorityTier = {} as Record<PriorityTier, number>;
    for (const tier of ['P0', 'P1', 'P2', 'P3'] as PriorityTier[]) {
      const arr = tierCosts[tier];
      avgCostPerPriorityTier[tier] = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    }

    // Failure patterns — top repeated failed items
    const failureCount: Record<string, number> = {};
    for (const record of records) {
      for (const item of record.failedItems) {
        failureCount[item] = (failureCount[item] ?? 0) + 1;
      }
    }
    const commonFailurePatterns = Object.entries(failureCount)
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([item]) => item);

    const avgDurationDays = records.reduce((a, b) => a + b.durationDays, 0) / records.length;
    const avgCostUsd = records.reduce((a, b) => a + b.totalCostUsd, 0) / records.length;

    return {
      avgCompletionRate,
      avgCostPerPriorityTier,
      commonFailurePatterns,
      avgDurationDays,
      totalSprints: records.length,
      avgCostUsd,
    };
  }
}
