// packages/core/src/autonomous/types.ts
// Type definitions for the autonomous development cycle.
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md

import type { ModelTier } from '@agentforge/shared';

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
    maxExecutePhaseParallelism: number;
    maxItemRetries: number;
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
  retry: {
    /** Max automatic gate-rejection retries before requiring approval. */
    maxAutoRetries: number;
    /** After this many auto-retries, pause and require human approval to continue. */
    requireApprovalAfter: number;
    /** Whether to re-run only test→review→gate or the full execute→test→review→gate. */
    reExecuteOnRetry: boolean;
  };
  /**
   * When set, agents whose assigned tier exceeds this value are downgraded to
   * this tier. Useful for two cases:
   *   - Opus service degradation: set "sonnet" to keep cycles running.
   *   - Cost-reduced runs: set "sonnet" or "haiku" to cut spend on exploratory work.
   * Agents already at or below the cap are unaffected (no upward coercion).
   */
  modelCap?: ModelTier;
  /**
   * When set, every agent in the cycle runs at this effort level regardless of
   * its YAML configuration. Useful for high-stakes runs where you want maximum
   * reasoning depth on every step, or low-cost exploration runs.
   * Passed as --effort to the claude subprocess.
   */
  effortCap?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * When true (default), the claude CLI --fallback-model flag is appended to
   * every agent invocation. Ladder: opus → sonnet, sonnet → haiku.
   * Set to false to pin agents strictly to their assigned model tier.
   */
  fallbackEnabled?: boolean;
  /**
   * When true (default), automatically run the learning-curator + mutator
   * after gate approval so all agents that participated in this cycle absorb
   * the new lessons. Set to false to skip for smoke runs, tests, or when
   * Workstreams P+Q are not yet available.
   */
  autoReforge?: boolean;
  /**
   * PR creation mode for this cycle.
   *
   * - `'single'` (default): one squash-PR for the entire autonomous branch,
   *   opened at the end of the cycle via the existing PROpener flow.
   * - `'multi'`: one draft PR per coder-class agent, opened in real-time as
   *   each agent pushes its branch (via MergeQueue). The single-PR step is
   *   skipped when this mode is active.
   *
   * Backward-compatible: existing configs without this field behave as
   * `'single'`.
   */
  prMode?: 'single' | 'multi';
  /**
   * Only relevant when `prMode === 'multi'`.
   *
   * When `true`, `drainAndMerge()` is called at cycle end with
   * `autoMerge: true` — CI-green PRs are promoted to ready AND merged via
   * squash automatically.
   *
   * Defaults to `false` (safe: only promotes drafts to ready; actual merge
   * requires human review). This keeps the default path non-destructive so
   * operators are always in the merge-decision loop unless they explicitly
   * opt in.
   */
  autoMergePRs?: boolean;
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
  scoringFallback?: 'static' | 'effort-estimator';
  error?: string;
  gateVerdict?: 'APPROVE' | 'REJECT';
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
