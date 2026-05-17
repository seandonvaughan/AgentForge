/**
 * Recon phase barrel export.
 *
 * Provides Zod schemas, inferred types, the ReconAgentId union, and the
 * runReconAgent function used to invoke the five Phase A recon agents.
 */

export {
  SubsystemsReportSchema,
  DependenciesReportSchema,
  ConventionsReportSchema,
  DomainReportSchema,
  HistoryReportSchema,
} from "./schemas.js";

export type {
  SubsystemsReport,
  DependenciesReport,
  ConventionsReport,
  DomainReport,
  HistoryReport,
} from "./schemas.js";

export type { ReconAgentId } from "./types.js";

export {
  runReconAgent,
  ReconValidationError,
} from "./recon-runner.js";

export type { RunReconAgentOpts, AgentRuntime } from "./recon-runner.js";
