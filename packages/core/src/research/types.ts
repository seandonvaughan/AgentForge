export type ResearchRunMode = 'operator-seeded' | 'autonomous';
export type ResearchRunStatus = 'ideas-ready' | 'planned' | 'completed' | 'failed';
export type ResearchIdeaStatus = 'proposed' | 'approved' | 'rejected' | 'planned' | 'executed';
export type ResearchRisk = 'low' | 'medium' | 'high';

export interface ResearchIdea {
  ideaId: string;
  title: string;
  problem: string;
  hypothesis: string;
  expectedImpact: string;
  risk: ResearchRisk;
  suggestedAgents: string[];
  touchedAreas: string[];
  acceptanceChecks: string[];
  status: ResearchIdeaStatus;
  createdAt: string;
  updatedAt: string;
  approvalNote?: string;
}

export interface ResearchRun {
  runId: string;
  projectRoot: string;
  prompt: string;
  mode: ResearchRunMode;
  status: ResearchRunStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  sourceCycleId?: string;
  ideas: ResearchIdea[];
  plannedCycle?: ResearchPlannedCycle;
  error?: string;
}

export interface ResearchPlannedCycle {
  plannedAt: string;
  ideaIds: string[];
  title: string;
  comment: string;
  cycleRequest: {
    budgetUsd: number;
    maxItems: number;
    maxAgents: number;
    dryRun: boolean;
    branchPrefix: string;
    baseBranch: string;
    fastMode: boolean;
    modelCap?: 'opus' | 'sonnet' | 'haiku';
    effortCap?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    fallbackEnabled: boolean;
    tags: string[];
    comment: string;
  };
}

export interface ResearchEvent {
  type: string;
  at: string;
  runId: string;
  ideaId?: string;
  data?: Record<string, unknown>;
}
