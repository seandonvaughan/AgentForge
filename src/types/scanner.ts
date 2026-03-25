/**
 * Scanner plugin type definitions for the AgentForge v2 Universal Forge.
 *
 * Defines the pluggable scanner architecture that lets domain packs
 * register custom scanners to detect project signals.
 */

import type { DomainId } from "./domain.js";
import type { ModelTier } from "./agent.js";

/**
 * A pluggable scanner that examines a project and emits signals.
 *
 * Each domain pack registers one or more scanners. The base scanner
 * orchestrator discovers and runs all registered scanners in parallel
 * via `Promise.allSettled`.
 */
export interface DomainScannerPlugin {
  /** Unique scanner name. */
  name: string;
  /** Domain this scanner belongs to. */
  domain: DomainId;
  /** Claude model tier to use for any AI-assisted scanning. */
  model: ModelTier;
  /** Scan the project at the given root and return structured output. */
  scan(projectRoot: string): Promise<ScanOutput>;
}

/**
 * Structured output produced by a single scanner run.
 *
 * Contains the activation signals detected and scanner-specific data
 * that downstream consumers (Genesis, domain activator) can use.
 */
export interface ScanOutput {
  /** Name of the scanner that produced this output. */
  scanner: string;
  /** Domain this scanner belongs to. */
  domain: DomainId;
  /** Activation signals detected during the scan. */
  signals: string[];
  /** Scanner-specific structured data. */
  data: Record<string, unknown>;
}
