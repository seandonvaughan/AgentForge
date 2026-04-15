/**
 * Project analysis type definitions for the AgentForge system.
 *
 * Used during the "forge" phase to assess a project's structure,
 * identify risks and coverage gaps, and recommend an agent team.
 *
 * v2 additions: ProjectBrief (universal input replacing code-only
 * ProjectAssessment), DocumentAnalysis, ResearchFindings, IntegrationRef.
 */

import type { DomainId } from "./domain.js";

/** High-level metadata about the project being analyzed. */
export interface ProjectInfo {
  /** Project name, typically derived from package.json or directory name. */
  name: string;
  /** The dominant programming language in the project. */
  primary_language: string;
  /** All programming languages detected in the project. */
  languages: string[];
  /** Frameworks and major libraries the project depends on. */
  frameworks: string[];
  /** Detected architectural pattern (e.g. "monolith", "microservices", "monorepo"). */
  architecture: string;
  /** Quantitative size metrics. */
  size: {
    /** Total number of source files. */
    files: number;
    /** Total lines of code. */
    loc: number;
  };
}

/** An identified area of elevated risk within the project. */
export interface RiskArea {
  /** Short label for the risk area (e.g. "security", "performance"). */
  area: string;
  /** How severe the risk is. */
  severity: "high" | "medium" | "low";
  /** Human-readable explanation of why this area is risky. */
  reason: string;
}

/** A domain or concern where current tooling or testing is insufficient. */
export interface CoverageGap {
  /** Label for the under-covered area (e.g. "integration tests", "error handling"). */
  area: string;
  /** Estimated coverage as a percentage (0-100). */
  coverage: number;
}

/** The set of agents recommended to address a project's needs. */
export interface RecommendedTeam {
  /** Agent names that are essential for this project. */
  required: string[];
  /** Agent names that would be beneficial but are not strictly necessary. */
  recommended: string[];
  /** Bespoke agents suggested based on project-specific needs. */
  custom_agents: {
    /** Proposed name for the custom agent. */
    name: string;
    /** Why this custom agent is recommended. */
    reason: string;
  }[];
}

/** Complete assessment produced by the project analysis phase. */
export interface ProjectAssessment {
  /** Metadata about the analyzed project. */
  project: ProjectInfo;
  /** Identified risk areas sorted by severity. */
  risk_areas: RiskArea[];
  /** Areas where coverage is lacking. */
  coverage_gaps: CoverageGap[];
  /** Recommended agent team composition. */
  recommended_team: RecommendedTeam;
}

// ── v2 Additions ───────────────────────────────────────────────────────

/**
 * Summary of a document discovered during project scanning.
 *
 * Used in the ProjectBrief to represent analyzed business documents,
 * PRDs, strategy docs, and other non-code artifacts.
 */
export interface DocumentAnalysis {
  /** Document type (e.g. "business-plan", "prd", "pitch-deck"). */
  type: string;
  /** Path to the document relative to the project root. */
  path: string;
  /** AI-generated summary of the document's contents. */
  summary: string;
}

/**
 * Findings from autonomous web research performed during scanning.
 *
 * Known fields are typed for convenience; additional dynamic fields
 * are permitted via the index signature.
 */
export interface ResearchFindings {
  /** Estimated total addressable market size. */
  market_size?: string;
  /** Known competitors in the space. */
  competitors?: string[];
  /** Current industry trends relevant to the project. */
  industry_trends?: string[];
  /** Additional research data keyed by topic. */
  [key: string]: unknown;
}

/**
 * A reference to an external integration discovered during scanning.
 *
 * Examples: Jira project keys, Confluence space IDs, GitHub repos.
 */
export interface IntegrationRef {
  /** Integration type (e.g. "jira", "confluence", "github"). */
  type: string;
  /** Integration-specific reference identifier. */
  ref: string;
}

/**
 * Universal project input that replaces the code-only ProjectAssessment.
 *
 * The Project Brief works for both dev and business projects and is the
 * primary input to the team composition pipeline in v2.
 */
export interface ProjectBrief {
  /** High-level project metadata. */
  project: {
    /** Project name. */
    name: string;
    /** Project type descriptor (e.g. "saas-product", "internal-tool"). */
    type: string;
    /** Current project lifecycle stage. */
    stage: "early" | "growth" | "mature" | "pivot";
  };
  /** Project goals. */
  goals: {
    /** The primary objective. */
    primary: string;
    /** Additional objectives. */
    secondary: string[];
  };
  /** Domain packs relevant to this project. */
  domains: DomainId[];
  /** Named constraints (e.g. budget, timeline, team_size). */
  constraints: Record<string, string>;
  /** Gathered context from scanners, research, and integrations. */
  context: {
    /** Codebase analysis results, if a repo was found. */
    codebase?: ProjectInfo;
    /** Analyzed documents found in the project. */
    documents?: DocumentAnalysis[];
    /** Autonomous web research findings. */
    research?: ResearchFindings;
    /** Discovered integration points. */
    integrations?: IntegrationRef[];
  };
}
