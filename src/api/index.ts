/**
 * Barrel export for the AgentForge API layer.
 *
 * Re-exports all public symbols from the client, agent runner,
 * and delegation executor modules.
 */

export {
  sendMessage,
  MODEL_MAP,
  MODEL_EFFORT_DEFAULTS,
} from "./client.js";

export type {
  SendMessageParams,
  SendMessageResult,
} from "./client.js";

export { runAgent } from "./agent-runner.js";
export type { AgentRunResult, RunContext } from "./agent-runner.js";

export { executeDelegation } from "./delegation-executor.js";
export type { DelegationExecResult } from "./delegation-executor.js";

export {
  APIStabilityAuditor,
  type StabilityLevel,
  type ExportType,
  type APIEntry,
  type BreakingChange,
  type StabilityReport,
} from "./api-stability-auditor.js";
