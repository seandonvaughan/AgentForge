// packages/core/src/autonomous/index.ts
// Barrel export for the autonomous development cycle module.

export * from './types.js';
export * from './version-bumper.js';
export * from './config-loader.js';
export * from './cycle-logger.js';
export * from './pr-body-renderer.js';
export * from './kill-switch.js';
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
export * from './cycle-runner.js';
export * from './runtime-adapter.js';
export * from './workspace-registry.js';
export * from './phase-handlers/index.js';
export * from './exec/pr-opener.js';
export * from './exec/real-test-runner.js';
export * from './exec/git-ops.js';
