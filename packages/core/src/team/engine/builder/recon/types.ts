/**
 * Public types for the Recon phase.
 *
 * Re-exports inferred Zod types from schemas.ts and defines the union of
 * valid recon agent identifiers.
 */

export type {
  SubsystemsReport,
  DependenciesReport,
  ConventionsReport,
  DomainReport,
  HistoryReport,
} from "./schemas.js";

/**
 * The five recon agents that run in Phase A of the agent-driven forge.
 * Each agent produces a structured JSON artifact validated by the
 * corresponding Zod schema in schemas.ts.
 */
export type ReconAgentId =
  | "code-archaeologist"
  | "dep-graph-analyst"
  | "convention-detective"
  | "domain-mapper"
  | "failure-historian";
