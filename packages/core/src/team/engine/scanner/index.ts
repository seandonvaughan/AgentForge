/**
 * Scanner barrel export for AgentForge.
 *
 * Re-exports every type and function from the individual scanner modules
 * and provides a unified `runFullScan` that executes all scanners in parallel.
 */

export type { FileAnalysis, FileScanResult } from "./file-scanner.js";
export { scanFiles, detectFrameworks } from "./file-scanner.js";

export type {
  GitContributor,
  ActiveFile,
  ChurnEntry,
  CommitFrequency,
  GitAnalysis,
} from "./git-analyzer.js";
export { analyzeGit } from "./git-analyzer.js";

export type { DependencyInfo, DependencyAnalysis } from "./dependency-mapper.js";
export { mapDependencies, categorizeDependency } from "./dependency-mapper.js";

export type { CIProvider, CIPipeline, CIAnalysis } from "./ci-auditor.js";
export { auditCI } from "./ci-auditor.js";

export type { DocumentAnalysis, IntegrationRef, ResearchFindings } from "../types/analysis.js";
export { analyzeDocuments } from "./document-analyzer.js";
export { detectIntegrations } from "./integration-detector.js";
export type { CommentNote, CommentMineResult } from "./comment-miner.js";
export { mineComments } from "./comment-miner.js";
export { researchProject } from "./web-researcher.js";

import { scanFiles } from "./file-scanner.js";
import { analyzeGit } from "./git-analyzer.js";
import { mapDependencies } from "./dependency-mapper.js";
import { auditCI } from "./ci-auditor.js";
import { analyzeDocuments } from "./document-analyzer.js";
import { detectIntegrations } from "./integration-detector.js";
import { mineComments } from "./comment-miner.js";

import type { FileScanResult } from "./file-scanner.js";
import type { GitAnalysis } from "./git-analyzer.js";
import type { DependencyAnalysis } from "./dependency-mapper.js";
import type { CIAnalysis } from "./ci-auditor.js";
import type { DocumentAnalysis, IntegrationRef, ResearchFindings } from "../types/analysis.js";
import type { CommentNote } from "./comment-miner.js";

// ---------------------------------------------------------------------------
// Combined result
// ---------------------------------------------------------------------------

/** Combined result of running all scanners against a project. */
export interface FullScanResult {
  files: FileScanResult;
  git: GitAnalysis;
  dependencies: DependencyAnalysis;
  ci: CIAnalysis;
  /** Analyzed document files (.md, .txt) found in the project. */
  documents?: DocumentAnalysis[];
  /** External integration references (Jira, Confluence, Slack) detected in the project. */
  integrations?: IntegrationRef[];
  /** Structured comment annotations extracted from source files. */
  comments?: { todos: CommentNote[]; decisions: CommentNote[]; notes: CommentNote[] };
  /** Web research findings (only populated when triggered externally with an API key). */
  research?: ResearchFindings;
}

// ---------------------------------------------------------------------------
// Defaults (used when a scanner fails)
// ---------------------------------------------------------------------------

const DEFAULT_FILE_SCAN: FileScanResult = {
  files: [],
  languages: {},
  frameworks_detected: [],
  total_files: 0,
  total_loc: 0,
  directory_structure: [],
};

const DEFAULT_GIT_ANALYSIS: GitAnalysis = {
  total_commits: 0,
  contributors: [],
  active_files: [],
  branch_count: 0,
  branch_strategy: "unknown",
  churn_rate: [],
  commit_frequency: [],
  age_days: 0,
};

const DEFAULT_DEPENDENCY_ANALYSIS: DependencyAnalysis = {
  package_manager: "unknown",
  dependencies: [],
  total_production: 0,
  total_development: 0,
  framework_dependencies: [],
  test_frameworks: [],
  build_tools: [],
  linters: [],
};

const DEFAULT_CI_ANALYSIS: CIAnalysis = {
  ci_provider: "none",
  config_files: [],
  pipelines: [],
  test_commands: [],
  build_commands: [],
  deploy_targets: [],
  has_linting: false,
  has_type_checking: false,
  has_security_scanning: false,
  has_docker: false,
  dockerfile_count: 0,
};

// ---------------------------------------------------------------------------
// Full scan
// ---------------------------------------------------------------------------

/**
 * Run all scanners in parallel against a project root.
 *
 * Uses `Promise.allSettled` so that a failure in one scanner does not
 * prevent the others from completing. Any scanner that rejects will
 * contribute sensible defaults to the combined result.
 *
 * Note: The web-researcher is intentionally excluded from the default scan.
 * It requires an API key and is triggered separately by the Genesis pipeline.
 */
export async function runFullScan(
  projectRoot: string,
): Promise<FullScanResult> {
  const [fileResult, gitResult, depResult, ciResult, docResult, intResult, commentResult] =
    await Promise.allSettled([
      scanFiles(projectRoot),
      analyzeGit(projectRoot),
      mapDependencies(projectRoot),
      auditCI(projectRoot),
      analyzeDocuments(projectRoot),
      detectIntegrations(projectRoot),
      mineComments(projectRoot),
    ]);

  const result: FullScanResult = {
    files:
      fileResult.status === "fulfilled"
        ? fileResult.value
        : DEFAULT_FILE_SCAN,
    git:
      gitResult.status === "fulfilled"
        ? gitResult.value
        : DEFAULT_GIT_ANALYSIS,
    dependencies:
      depResult.status === "fulfilled"
        ? depResult.value
        : DEFAULT_DEPENDENCY_ANALYSIS,
    ci:
      ciResult.status === "fulfilled"
        ? ciResult.value
        : DEFAULT_CI_ANALYSIS,
  };

  if (docResult.status === "fulfilled") {
    result.documents = docResult.value;
  }

  if (intResult.status === "fulfilled") {
    result.integrations = intResult.value;
  }

  if (commentResult.status === "fulfilled") {
    result.comments = commentResult.value;
  }

  return result;
}
