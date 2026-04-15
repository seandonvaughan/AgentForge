import type { BacklogItem, SprintHistoryRecord, PlanPrediction } from './types.js';
import { HistoryAnalyzer } from './history-analyzer.js';
import { EffortEstimator } from './effort-estimator.js';
import { RiskScorer } from './risk-scorer.js';

export class SprintPredictor {
  private historyAnalyzer = new HistoryAnalyzer();
  private effortEstimator = new EffortEstimator();
  private riskScorer = new RiskScorer();

  predict(
    backlogItems: BacklogItem[],
    history: SprintHistoryRecord[],
    budgetUsd?: number,
  ): PlanPrediction {
    const analysis = this.historyAnalyzer.analyze(history);

    // Sort by priority order
    const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sorted = [...backlogItems].sort(
      (a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9),
    );

    // Estimate effort for all items
    const effortEstimates = sorted.map(item => this.effortEstimator.estimate(item, analysis));

    // Build recommended set within budget
    const recommendedItems: BacklogItem[] = [];
    let cumulativeCost = 0;
    const effectiveBudget = budgetUsd ?? (analysis.avgCostUsd * 1.2 || Infinity);

    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      const estimate = effortEstimates[i];
      if (!item || !estimate) continue;

      if (cumulativeCost + estimate.estimatedCostUsd <= effectiveBudget) {
        recommendedItems.push(item);
        cumulativeCost += estimate.estimatedCostUsd;
      }
    }

    const excludedItems = sorted.filter(i => !recommendedItems.includes(i));

    // Risk score on recommended set
    const riskScore = this.riskScorer.score(recommendedItems, budgetUsd);

    // Predicted completion rate
    const estimatedCompletionRate = analysis.avgCompletionRate > 0
      ? Math.min(1, analysis.avgCompletionRate * (1 - riskScore.score / 200))
      : 0.8;

    // Confidence
    const confidence = analysis.totalSprints === 0
      ? 0.4
      : Math.min(0.95, 0.5 + analysis.totalSprints * 0.03);

    return {
      recommendedItems,
      excludedItems,
      estimatedTotalCostUsd: Math.round(cumulativeCost * 100) / 100,
      estimatedCompletionRate: Math.round(estimatedCompletionRate * 100) / 100,
      riskScore,
      confidence: Math.round(confidence * 100) / 100,
      effortEstimates,
    };
  }
}
