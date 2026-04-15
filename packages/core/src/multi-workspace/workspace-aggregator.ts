import type { WorkspaceSummary, MultiWorkspaceView, WorkspaceComparison } from './types.js';

/**
 * WorkspaceAggregator takes multiple workspace snapshots, produces a unified
 * view with totals, rankings, and comparison utilities.
 */
export class WorkspaceAggregator {
  /**
   * Aggregate multiple workspace summaries into a unified MultiWorkspaceView.
   */
  aggregate(summaries: WorkspaceSummary[]): MultiWorkspaceView {
    const combinedCostUsd = summaries.reduce((sum, ws) => sum + ws.totalCostUsd, 0);
    const combinedSessionCount = summaries.reduce((sum, ws) => sum + ws.sessionCount, 0);

    // Sort by cost descending for ranking
    const sorted = [...summaries].sort((a, b) => b.totalCostUsd - a.totalCostUsd);

    const costRanking = sorted.map((ws, idx) => ({
      workspaceId: ws.workspaceId,
      rank: idx + 1,
      costUsd: ws.totalCostUsd,
    }));

    const highestCostWorkspaceId = sorted[0]?.workspaceId ?? null;

    return {
      workspaces: summaries,
      combinedCostUsd,
      combinedSessionCount,
      highestCostWorkspaceId,
      costRanking,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Produce a side-by-side comparison of two workspace summaries.
   */
  compare(left: WorkspaceSummary, right: WorkspaceSummary): WorkspaceComparison {
    const costDiffUsd = left.totalCostUsd - right.totalCostUsd;
    const sessionCountDiff = left.sessionCount - right.sessionCount;

    let higherCost: 'left' | 'right' | 'equal';
    if (left.totalCostUsd > right.totalCostUsd) {
      higherCost = 'left';
    } else if (right.totalCostUsd > left.totalCostUsd) {
      higherCost = 'right';
    } else {
      higherCost = 'equal';
    }

    return { left, right, costDiffUsd, sessionCountDiff, higherCost };
  }
}
