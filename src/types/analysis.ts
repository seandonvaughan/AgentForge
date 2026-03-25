/**
 * Project analysis type definitions for the AgentForge system.
 *
 * Used during the "forge" phase to assess a project's structure,
 * identify risks and coverage gaps, and recommend an agent team.
 */

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
