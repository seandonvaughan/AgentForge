// packages/core/src/autonomous/index.ts
// Barrel export for the autonomous development cycle module.

export * from './types.js';
export {
  extractBreakdownFromAgentRun,
  mergeBreakdowns,
} from './cost-breakdown.js';
export type {
  CostBreakdown as AutonomousCostBreakdown,
  AgentRun as AutonomousAgentRun,
} from './cost-breakdown.js';
export * from './version-bumper.js';
export * from './config-loader.js';
export * from './cycle-logger.js';
export * from './cycle-health.js';
export * from './pr-body-renderer.js';
export * from './kill-switch.js';
export * from './preview-cycle.js';
export { ProposalToBacklog } from './proposal-to-backlog.js';
export type { ProposalAdapter } from './proposal-to-backlog.js';
export type { BacklogItem as AutonomousBacklogItem } from './proposal-to-backlog.js';
export { SprintGenerator } from './sprint-generator.js';
export type {
  SprintPlan as AutonomousSprintPlan,
  SprintPlanItem as AutonomousSprintPlanItem,
} from './sprint-generator.js';
export * from './budget-approval.js';
export * from './scoring-pipeline.js';
export * from './phase-scheduler.js';
export {
  CycleRunner,
  collectFilesFromAgentBranches,
  sanitizePrTitle,
  parseCommandArgs,
  readCheckpoint,
} from './cycle-runner.js';
export type { CycleRunnerOptions } from './cycle-runner.js';
export type { CycleCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';
export * from './runtime-adapter.js';
export * from './workspace-telemetry-adapters.js';
export * from './workspace-registry.js';
export * from './phase-handlers/index.js';
export * from './routing/job-router.js';
export * from './exec/pr-opener.js';
export * from './exec/real-test-runner.js';
export * from './exec/git-ops.js';

// Migrated from root src/autonomous/ — selective exports to avoid
// name collisions with newer core modules (SprintPlan, GateVerdictMetadata, etc.).
export {
  AutonomousSprintFramework,
  type SprintPhase,
  type SprintItem,
  type SprintResult,
  type SprintFrameworkOptions,
  type GateVerdictMemoryWriter,
} from './sprint-framework.js';
export {
  ReviewPhaseHandler,
  type FindingSeverity,
  type ReviewFinding,
  type ReviewPhaseResult,
} from './review-phase-handler.js';
export {
  AuditPhaseHandler,
  type GateVerdictReader,
  type PastMistake,
  type AuditPromptInjection,
} from './audit-phase-handler.js';
export {
  GatePhaseHandler,
  type GateVerdictInput,
  type GatePhaseResult,
} from './gate-phase-handler.js';
export {
  ExecutePhaseHandler,
  type ExecutePhaseMemorySection,
} from './execute-phase-handler.js';
export * from './sprint-retrospective.js';
export {
  runUnattendedChecks,
  assertUnattendedSafe,
  UnattendedGuardError,
} from './audit/unattended-guard.js';
export type { UnattendedCheckResult } from './audit/unattended-guard.js';
