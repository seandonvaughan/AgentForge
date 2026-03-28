export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ExecutionLogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: 'agent' | 'proposal' | 'approval' | 'sprint' | 'evaluation' | 'system';
  message: string;
  data?: Record<string, unknown>;
  sprintVersion?: string;
  agentId?: string;
  costUsd?: number;
  durationMs?: number;
}

export interface SprintSummary {
  sprintVersion: string;
  plannedAt: string;
  completedAt?: string;
  itemsPlanned: number;
  itemsCompleted: number;
  itemsFailed: number;
  totalCostUsd: number;
  totalDurationMs: number;
  testCountBefore: number;
  testCountAfter: number;
  promoted: boolean;
  verdict: 'ship' | 'revert' | 'retry' | 'in_progress';
  highlights: string[];
}
