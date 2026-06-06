// packages/core/src/autonomous/cycle-artifacts/index.ts
// Barrel export for cycle artifact Zod schemas and parse helpers.

export {
  // Schemas
  CycleJsonSchema,
  PlanJsonSchema,
  GateJsonSchema,
  ReviewJsonSchema,
  ScoringJsonSchema,
  ExecutePhaseSchema,
  // Safe parsers
  parseCycleJson,
  parsePlanJson,
  parseGateJson,
  parseReviewJson,
  parseScoringJson,
  parseExecutePhase,
  // Warn-on-fail validators
  validateCycleJson,
  validatePlanJson,
  validateGateJson,
  validateReviewJson,
  validateScoringJson,
  validateExecutePhase,
} from './schemas.js';

export type {
  CycleJson,
  PlanJson,
  GateJson,
  ReviewJson,
  ScoringJson,
  ExecutePhase,
} from './schemas.js';

// P0.8 — spend report + ledger + completed.json artifacts.
export {
  buildSpendReport,
  writeSpendReport,
  renderSpendReportMarkdown,
  appendLedgerRow,
  writeCompletedSnapshot,
} from './spend-report.js';

export type {
  SpendReport,
  SpendReportPerItem,
  CycleLedgerRow,
  BuildSpendReportArgs,
} from './spend-report.js';
