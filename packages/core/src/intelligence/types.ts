export interface ProposalContext {
  agentId: string;
  currentTask?: string;
  recentSessions?: Array<{ task: string; outcome: 'success' | 'failure'; model: string }>;
  workspaceId?: string;
}

export interface AgentProposal {
  id: string;
  agentId: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  confidence: number;      // 0–1
  estimatedImpact: string;
  tags: string[];
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'in_progress' | 'completed';
}

export interface RoutingDecision {
  agentId: string;
  task: string;
  selectedModel: 'opus' | 'sonnet' | 'haiku';
  confidence: number;
  reasoning: string;
  fallbackModel?: 'opus' | 'sonnet' | 'haiku';
}

export type TaskComplexity = 'simple' | 'moderate' | 'complex' | 'strategic';

export interface EscalationEvent {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  task: string;
  reason: string;
  escalatedAt: string;
  resolvedAt?: string;
  resolution?: string;
  level: 1 | 2 | 3;  // 1=peer, 2=lead, 3=executive
}
