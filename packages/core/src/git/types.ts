export type BranchStatus = 'active' | 'review' | 'merged' | 'conflict' | 'stale';

export interface AgentBranch {
  id: string;
  name: string;          // e.g. agent/coder/task-abc123
  agentId: string;
  taskId: string;
  targetBranch: string;  // usually 'main'
  status: BranchStatus;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  conflictInfo?: string;
  reviewStatus?: 'pending' | 'approved' | 'changes_requested' | 'rejected';
  reviewedBy?: string;
}

export interface MergeQueueItem {
  id: string;
  branchId: string;
  branchName: string;
  agentId: string;
  priority: 'P0' | 'P1' | 'P2';
  status: 'pending' | 'in_progress' | 'merged' | 'blocked' | 'conflict';
  queuedAt: string;
  mergedAt?: string;
  blockReason?: string;
}

export interface BranchReport {
  total: number;
  active: number;
  review: number;
  merged: number;
  conflict: number;
  stale: number;
  mergeQueue: number;
  timestamp: string;
}
