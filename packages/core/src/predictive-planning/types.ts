export type PriorityTier = 'P0' | 'P1' | 'P2' | 'P3';

export interface SprintHistoryRecord {
  sprintId: string;
  plannedItems: number;
  completedItems: number;
  totalCostUsd: number;
  durationDays: number;
  failedItems: string[];
  itemsByPriority: Record<PriorityTier, number>;
  completedByPriority: Record<PriorityTier, number>;
  completedAt: string;
}

export interface EffortEstimate {
  itemId: string;
  description: string;
  estimatedHours: number;
  estimatedCostUsd: number;
  confidence: number;
  complexityScore: number;
}

export interface RiskScore {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: RiskFactor[];
}

export interface RiskFactor {
  name: string;
  impact: number;
  description: string;
}

export interface BacklogItem {
  id: string;
  title: string;
  priority: PriorityTier;
  complexityScore: number;
  dependencies?: string[];
  estimatedCostUsd?: number;
}

export interface PlanPrediction {
  recommendedItems: BacklogItem[];
  excludedItems: BacklogItem[];
  estimatedTotalCostUsd: number;
  estimatedCompletionRate: number;
  riskScore: RiskScore;
  confidence: number;
  effortEstimates: EffortEstimate[];
}
