// packages/core/src/autonomous/types.ts
// Type definitions for the autonomous development cycle.
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md

export enum CycleStage {
  PLAN = 'plan',
  STAGE = 'stage',
  RUN = 'run',
  VERIFY = 'verify',
  COMMIT = 'commit',
  REVIEW = 'review',
  KILLED = 'killed',
  FAILED = 'failed',
  COMPLETED = 'completed',
}

export type KillReason =
  | 'budget'
  | 'duration'
  | 'regression'
  | 'testFloor'
  | 'buildFailure'
  | 'typeCheckFailure'
  | 'consecutiveFailures'
  | 'manualStop'
  | 'manualStopFile';

export interface KillSwitchTrip {
  reason: KillReason;
  detail: string;
  triggeredAt: string;
  stageAtTrip: CycleStage;
}

export interface CycleConfig {
  budget: {
    perCycleUsd: number;
    perItemUsd: number;
    perAgentUsd: number;
    allowOverageApproval: boolean;
  };
  limits: {
    maxItemsPerSprint: number;
    maxDurationMinutes: number;
    maxConsecutiveFailures: number;
    maxExecutePhaseFailureRate: number;
  };
  quality: {
    testPassRateFloor: number;
    allowRegression: boolean;
    requireBuildSuccess: boolean;
    requireTypeCheckSuccess: boolean;
  };
  git: {
    branchPrefix: string;
    baseBranch: string;
    refuseCommitToBaseBranch: boolean;
    includeDiagnosticBranchOnFailure: boolean;
    maxFilesPerCommit: number;
  };
  pr: {
    draft: boolean;
    assignReviewer: string | null;
    labelPrefix: string;
    labels: string[];
    titleTemplate: string;
  };
  sourcing: {
    lookbackDays: number;
    minProposalConfidence: number;
    includeTodoMarkers: boolean;
    todoMarkerPattern: string;
  };
  testing: {
    command: string;
    timeoutMinutes: number;
    reporter: string;
    saveRawLog: boolean;
    buildCommand: string;
    typeCheckCommand: string;
  };
  scoring: {
    agentId: string;
    maxRetries: number;
    fallbackToStatic: boolean;
  };
  logging: {
    logDir: string;
    retainCycles: number;
  };
  safety: {
    stopFilePath: string;
    secretScanEnabled: boolean;
    verifyCleanWorkingTreeBeforeStart: boolean;
    workingTreeWhitelist: string[];
  };
}

export interface FailedTest {
  file: string;
  suite: string;
  name: string;
  error: string;
  snippet: string;
}

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
  durationMs: number;
  failedTests: FailedTest[];
  newFailures: string[];
  rawOutputPath: string;
  exitCode: number;
}

export interface RankedItem {
  itemId: string;
  title: string;
  rank: number;
  score: number;
  confidence: number;
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
  rationale: string;
  dependencies: string[];
  suggestedAssignee: string;
  suggestedTags: string[];
  withinBudget: boolean;
}

export interface ScoringResult {
  rankings: RankedItem[];
  totalEstimatedCostUsd: number;
  budgetOverflowUsd: number;
  summary: string;
  warnings: string[];
}

export interface CycleResult {
  cycleId: string;
  sprintVersion: string;
  stage: CycleStage;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cost: {
    totalUsd: number;
    budgetUsd: number;
    byAgent: Record<string, number>;
    byPhase: Record<string, number>;
  };
  tests: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    passRate: number;
    newFailures: string[];
  };
  git: {
    branch: string;
    commitSha: string | null;
    filesChanged: string[];
  };
  pr: {
    url: string | null;
    number: number | null;
    draft: boolean;
  };
  killSwitch?: KillSwitchTrip;
  scoringFallback?: 'static';
  error?: string;
}

export class CycleKilledError extends Error {
  constructor(public readonly trip: KillSwitchTrip) {
    super(`Cycle killed: ${trip.reason} — ${trip.detail}`);
    this.name = 'CycleKilledError';
  }
}

export class PhaseFailedError extends Error {
  constructor(public readonly phase: string, public readonly reason: string) {
    super(`Phase ${phase} failed: ${reason}`);
    this.name = 'PhaseFailedError';
  }
}
