import type { BacklogItem, EffortEstimate, SprintHistoryRecord } from './types.js';
import type { HistoryAnalysis } from './history-analyzer.js';

export class EffortEstimator {
  estimate(item: BacklogItem, analysis: HistoryAnalysis): EffortEstimate {
    const complexityScore = item.complexityScore ?? 5;

    // Base hours from complexity (1-10 scale)
    const baseHours = complexityScore * 2;

    // Adjust by historical priority cost
    const historicalCost = analysis.avgCostPerPriorityTier[item.priority] ?? 0;
    const estimatedCostUsd = item.estimatedCostUsd ??
      (historicalCost > 0 ? historicalCost * (complexityScore / 5) : complexityScore * 0.5);

    // Confidence based on data availability
    const confidence = analysis.totalSprints === 0
      ? 0.3
      : Math.min(0.9, 0.4 + analysis.totalSprints * 0.05);

    // Adjust hours based on historical data
    const avgVelocity = analysis.avgCostUsd > 0
      ? analysis.avgDurationDays / Math.max(1, analysis.avgCostUsd / 10)
      : 1;
    const estimatedHours = baseHours * (1 / Math.max(0.5, avgVelocity));

    return {
      itemId: item.id,
      description: item.title,
      estimatedHours: Math.round(estimatedHours * 10) / 10,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
      complexityScore,
    };
  }

  estimateMany(items: BacklogItem[], history: SprintHistoryRecord[]): EffortEstimate[] {
    // Inline a simple analysis to avoid circular dep
    const totalSprints = history.length;
    const avgCostUsd = totalSprints > 0
      ? history.reduce((a, b) => a + b.totalCostUsd, 0) / totalSprints
      : 0;
    const avgDurationDays = totalSprints > 0
      ? history.reduce((a, b) => a + b.durationDays, 0) / totalSprints
      : 0;

    const mockAnalysis: HistoryAnalysis = {
      avgCompletionRate: 0,
      avgCostPerPriorityTier: { P0: 0, P1: 0, P2: 0, P3: 0 },
      commonFailurePatterns: [],
      avgDurationDays,
      totalSprints,
      avgCostUsd,
    };

    return items.map(item => this.estimate(item, mockAnalysis));
  }
}
