/** Multi-Workspace Dashboard types */

export interface WorkspaceSummary {
  /** Unique workspace identifier */
  workspaceId: string;
  /** Human-readable workspace name */
  name: string;
  /** Total cumulative cost in USD */
  totalCostUsd: number;
  /** Number of sessions recorded */
  sessionCount: number;
  /** Number of active agents */
  activeAgents: number;
  /** ISO timestamp of last activity */
  lastActivityAt: string;
}

export interface MultiWorkspaceView {
  /** All workspace summaries aggregated */
  workspaces: WorkspaceSummary[];
  /** Combined total cost across all workspaces */
  combinedCostUsd: number;
  /** Combined session count across all workspaces */
  combinedSessionCount: number;
  /** ID of the workspace with highest cost */
  highestCostWorkspaceId: string | null;
  /** Relative cost ranking: workspaceId → rank (1 = highest) */
  costRanking: Array<{ workspaceId: string; rank: number; costUsd: number }>;
  /** ISO timestamp when this view was generated */
  generatedAt: string;
}

export interface WorkspaceComparison {
  /** The two workspaces being compared */
  left: WorkspaceSummary;
  right: WorkspaceSummary;
  /** Difference in cost (left - right) */
  costDiffUsd: number;
  /** Difference in session count (left - right) */
  sessionCountDiff: number;
  /** Which workspace has higher cost: 'left' | 'right' | 'equal' */
  higherCost: 'left' | 'right' | 'equal';
}
