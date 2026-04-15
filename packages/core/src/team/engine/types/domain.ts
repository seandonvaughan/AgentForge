/**
 * Domain type definitions for the AgentForge v2 Universal Forge.
 *
 * Domains are modular agent packs (software, business, marketing, etc.)
 * that bundle agent templates, skills, scanners, and collaboration
 * patterns into self-contained units.
 */

import type { AgentCategory } from "./agent.js";

/**
 * Identifies a domain pack.
 *
 * Known domains are enumerated for autocomplete; arbitrary strings
 * are also accepted so custom packs can be registered at runtime.
 */
export type DomainId =
  | "core"
  | "software"
  | "business"
  | "marketing"
  | "product"
  | "research"
  | "sales"
  | "legal"
  | "hr"
  | "it"
  | (string & {});

/**
 * Conditions that trigger a domain's activation during project scanning.
 *
 * All fields are optional; a domain may activate based on file patterns,
 * directory presence, specific file existence, or any combination.
 */
export interface ActivationRule {
  /** Glob patterns for files that signal this domain (e.g. "*.ts", "*.py"). */
  file_patterns?: string[];
  /** Directory names whose existence signals this domain (e.g. "src/", "docs/"). */
  directories?: string[];
  /** Specific filenames whose existence signals this domain (e.g. "package.json"). */
  files?: string[];
}

/**
 * Scanner configuration for a domain pack.
 *
 * Describes what kind of scanning the domain needs, the rules that
 * activate it, and which scanner plugins to run.
 */
export interface DomainScanner {
  /** The class of scanning this domain uses. */
  type: "codebase" | "document" | "hybrid";
  /** Rules checked against scan results to determine if this domain should activate. */
  activates_when: ActivationRule[];
  /** Names of scanner plugins to run when this domain is active. */
  scanners: string[];
}

/**
 * A complete domain pack manifest.
 *
 * Each domain pack is a self-contained module loaded from a
 * `domain.yaml` file that declares agents, scanners, signals,
 * and a default collaboration template.
 */
export interface DomainPack {
  /** Unique domain identifier. */
  name: DomainId;
  /** Semantic version of this domain pack. */
  version: string;
  /** Human-readable description of the domain's focus. */
  description: string;
  /** Scanner configuration for this domain. */
  scanner: DomainScanner;
  /** Agent names grouped by functional category. */
  agents: Record<AgentCategory, string[]>;
  /** Name of the default collaboration template for this domain. */
  default_collaboration: string;
  /** Signal names emitted when this domain's activation rules match. */
  signals: string[];
}
