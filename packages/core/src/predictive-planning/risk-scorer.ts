import type { BacklogItem, RiskScore, RiskFactor } from './types.js';

export class RiskScorer {
  score(items: BacklogItem[], budgetUsd?: number): RiskScore {
    const factors: RiskFactor[] = [];
    let totalScore = 0;

    // Factor 1: High complexity concentration
    const highComplexity = items.filter(i => i.complexityScore >= 8);
    const complexityRatio = items.length > 0 ? highComplexity.length / items.length : 0;
    if (complexityRatio > 0.5) {
      const impact = Math.round(complexityRatio * 30);
      factors.push({
        name: 'high_complexity_concentration',
        impact,
        description: `${Math.round(complexityRatio * 100)}% of items have high complexity (>=8)`,
      });
      totalScore += impact;
    }

    // Factor 2: Dependency conflicts
    const allIds = new Set(items.map(i => i.id));
    const missingDeps: string[] = [];
    for (const item of items) {
      for (const dep of item.dependencies ?? []) {
        if (!allIds.has(dep)) {
          missingDeps.push(dep);
        }
      }
    }
    if (missingDeps.length > 0) {
      const impact = Math.min(40, missingDeps.length * 10);
      factors.push({
        name: 'dependency_conflicts',
        impact,
        description: `${missingDeps.length} missing dependencies: ${missingDeps.slice(0, 3).join(', ')}`,
      });
      totalScore += impact;
    }

    // Factor 3: Budget overrun risk
    if (budgetUsd !== undefined) {
      const estimatedCost = items.reduce((sum, i) => sum + (i.estimatedCostUsd ?? i.complexityScore * 0.5), 0);
      if (estimatedCost > budgetUsd) {
        const overrunRatio = estimatedCost / budgetUsd;
        const impact = Math.min(30, Math.round((overrunRatio - 1) * 30));
        factors.push({
          name: 'budget_overrun',
          impact,
          description: `Estimated cost $${estimatedCost.toFixed(2)} exceeds budget $${budgetUsd.toFixed(2)}`,
        });
        totalScore += impact;
      }
    }

    // Factor 4: Too many P0 items
    const p0Count = items.filter(i => i.priority === 'P0').length;
    if (p0Count > 5) {
      const impact = Math.min(20, (p0Count - 5) * 4);
      factors.push({
        name: 'p0_overload',
        impact,
        description: `${p0Count} P0 items risks focus dilution`,
      });
      totalScore += impact;
    }

    totalScore = Math.min(100, totalScore);

    let level: RiskScore['level'];
    if (totalScore < 20) level = 'low';
    else if (totalScore < 40) level = 'medium';
    else if (totalScore < 70) level = 'high';
    else level = 'critical';

    return { score: totalScore, level, factors };
  }
}
