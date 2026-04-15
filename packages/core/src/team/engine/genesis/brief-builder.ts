/**
 * Project Brief Builder for the AgentForge Genesis workflow.
 *
 * Constructs a universal {@link ProjectBrief} from any combination of:
 * - A full codebase scan result
 * - Interview answers provided by the user
 * - Autonomous research findings
 * - Discovered integration references
 *
 * The builder infers project type, lifecycle stage, and relevant domains
 * from the available inputs, filling in sensible defaults when information
 * is missing.
 */

import type { FullScanResult } from "../scanner/index.js";
import type {
  ProjectBrief,
  ProjectInfo,
  ResearchFindings,
  IntegrationRef,
} from "../types/analysis.js";
import type { DomainId } from "../types/domain.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Parameters accepted by {@link buildBrief}. All fields are optional. */
export interface BuildBriefParams {
  /** Full scan result from running all scanners against the project. */
  scan?: FullScanResult;
  /** Structured answers from the interactive interview. */
  answers?: Record<string, string>;
  /** Autonomous web-research findings. */
  research?: ResearchFindings;
  /** Discovered integration references (Jira, GitHub, etc.). */
  integrations?: IntegrationRef[];
}

/**
 * Build a {@link ProjectBrief} from all available inputs.
 *
 * Missing inputs are handled gracefully: a brief can be constructed from
 * a scan alone, from interview answers alone, or even with no inputs at
 * all (in which case sensible defaults are used).
 */
export function buildBrief(params: BuildBriefParams): ProjectBrief {
  const { scan, answers, research, integrations } = params;

  const codebase = scan ? buildCodebaseInfo(scan) : undefined;
  const domains = inferDomains(scan, answers);
  let projectType = inferProjectType(scan);
  const stage = inferStage(scan);
  const name = inferName(answers, codebase);
  const { primary, secondary } = inferGoals(answers);
  const constraints = extractConstraints(answers);

  // Thread through research-informed project type updates
  if (answers?.output_artifact === "Academic paper or report") {
    projectType = "research";
  }

  const context: ProjectBrief["context"] = {};
  if (codebase) {
    context.codebase = codebase;
  }
  if (scan?.documents) {
    context.documents = scan.documents;
  }
  const resolvedIntegrations = scan?.integrations ?? integrations;
  if (resolvedIntegrations) {
    context.integrations = resolvedIntegrations;
  }
  const resolvedResearch = research ?? scan?.research;
  if (resolvedResearch) {
    context.research = resolvedResearch;
  }

  return {
    project: {
      name,
      type: projectType,
      stage,
    },
    goals: {
      primary,
      secondary,
    },
    domains,
    constraints,
    context,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Well-known constraint keys extracted from interview answers. */
const CONSTRAINT_KEYS = new Set([
  "budget",
  "timeline",
  "team_size",
  "deployment",
  "compliance",
]);

/** Well-known answer keys that are NOT constraints. */
const NON_CONSTRAINT_KEYS = new Set([
  "project_name",
  "primary_goal",
  "secondary_goals",
]);

/** Programming language extensions that signal a software codebase. */
const CODE_EXTENSIONS = new Set([
  "typescript",
  "javascript",
  "python",
  "java",
  "go",
  "rust",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "swift",
  "kotlin",
  "php",
  "scala",
]);

/**
 * Build {@link ProjectInfo} from scan results.
 */
function buildCodebaseInfo(scan: FullScanResult): ProjectInfo {
  const languages = Object.keys(scan.files.languages);
  const primaryLanguage = determinePrimaryLanguage(scan);

  return {
    name: "project",
    primary_language: primaryLanguage,
    languages,
    frameworks: [...scan.files.frameworks_detected],
    architecture: inferArchitecture(scan),
    size: {
      files: scan.files.total_files,
      loc: scan.files.total_loc,
    },
  };
}

/**
 * Determine the primary language from scan results by file count.
 */
function determinePrimaryLanguage(scan: FullScanResult): string {
  const langs = scan.files.languages;
  let best = "unknown";
  let bestCount = 0;

  for (const [lang, count] of Object.entries(langs)) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }

  return best;
}

/**
 * Infer the architectural pattern from scan results.
 */
function inferArchitecture(scan: FullScanResult): string {
  const dirs = scan.files.directory_structure;

  if (dirs.includes("packages") || dirs.includes("apps")) {
    return "monorepo";
  }

  if (
    scan.ci.has_docker &&
    scan.ci.dockerfile_count > 1
  ) {
    return "microservices";
  }

  return "monolith";
}

/**
 * Infer project type from scan results.
 *
 * Returns "software" if any programming language files are detected,
 * otherwise "business".
 */
function inferProjectType(scan?: FullScanResult): string {
  if (!scan) return "business";

  const languages = Object.keys(scan.files.languages);
  const hasCode = languages.some((lang) => CODE_EXTENSIONS.has(lang));

  return hasCode ? "software" : "business";
}

/**
 * Infer project lifecycle stage from scan results.
 *
 * Heuristic:
 * - mature: 50+ files AND (200+ commits OR 180+ days old)
 * - growth: 20+ files OR 50+ commits
 * - early:  everything else (including no scan)
 */
function inferStage(
  scan?: FullScanResult,
): "early" | "growth" | "mature" | "pivot" {
  if (!scan) return "early";

  const fileCount = scan.files.total_files;
  const commitCount = scan.git.total_commits;
  const ageDays = scan.git.age_days;

  if (fileCount >= 50 && (commitCount >= 200 || ageDays >= 180)) {
    return "mature";
  }

  if (fileCount >= 20 || commitCount >= 50) {
    return "growth";
  }

  return "early";
}

/**
 * Infer the project name.
 *
 * Prefers the interview answer `project_name`, then falls back to the
 * codebase info name, then a generic default.
 */
function inferName(
  answers?: Record<string, string>,
  codebase?: ProjectInfo,
): string {
  if (answers?.project_name) return answers.project_name;
  if (codebase) return codebase.name;
  return "untitled-project";
}

/**
 * Extract goals from interview answers.
 */
function inferGoals(answers?: Record<string, string>): {
  primary: string;
  secondary: string[];
} {
  const primary = answers?.primary_goal ?? "";
  const secondaryRaw = answers?.secondary_goals ?? "";
  const secondary = secondaryRaw
    ? secondaryRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  return { primary, secondary };
}

/**
 * Extract constraint key-value pairs from interview answers.
 *
 * Any answer key in {@link CONSTRAINT_KEYS} (or any key not in
 * {@link NON_CONSTRAINT_KEYS} and not a goal key) that is also not a
 * reserved answer key is treated as a constraint.
 */
function extractConstraints(
  answers?: Record<string, string>,
): Record<string, string> {
  if (!answers) return {};

  const constraints: Record<string, string> = {};

  for (const [key, value] of Object.entries(answers)) {
    if (NON_CONSTRAINT_KEYS.has(key)) continue;
    if (key === "secondary_goals") continue;
    if (CONSTRAINT_KEYS.has(key)) {
      constraints[key] = value;
    }
  }

  return constraints;
}

/**
 * Infer which domain packs should be activated based on scan signals.
 *
 * Uses lightweight heuristics (no domain pack manifests required):
 * - "core" is always included.
 * - "software" is included when source code files are detected.
 * - "business" is included when document-oriented files/directories are found.
 * - "research" is included when research documents are detected or research-modality answers indicate research.
 *
 * Returns a sorted, deduplicated array of domain IDs.
 */
function inferDomains(
  scan?: FullScanResult,
  answers?: Record<string, string>,
): DomainId[] {
  const domains = new Set<DomainId>(["core"]);

  if (!scan && !answers) return [...domains].sort();

  if (scan) {
    // Check for source code → software domain
    const languages = Object.keys(scan.files.languages);
    const hasCode = languages.some((lang) => CODE_EXTENSIONS.has(lang));
    if (hasCode) {
      domains.add("software");
    }

    // Check for document-oriented signals → business domain
    const dirs = scan.files.directory_structure;
    const hasDocsDirs = dirs.some((d) =>
      ["docs", "documents", "business", "plans"].includes(d),
    );
    const hasDocFiles = scan.files.files.some((f) => {
      const ext = f.file_path.split(".").pop()?.toLowerCase();
      return ext === "md" || ext === "pdf" || ext === "docx";
    });

    if (hasDocsDirs || hasDocFiles) {
      domains.add("business");
    }

    // Check for document types that signal business or research domains
    if (scan.documents && scan.documents.length > 0) {
      const docTypes = new Set(scan.documents.map((d) => d.type));

      // Business domain signals
      if (
        docTypes.has("business-plan") ||
        docTypes.has("prd") ||
        docTypes.has("marketing-plan") ||
        docTypes.has("research-paper") ||
        docTypes.has("contract") ||
        docTypes.has("policy")
      ) {
        domains.add("business");
      }

      // Research domain signals
      if (docTypes.has("research-paper")) {
        domains.add("research");
      }
    }
  }

  // Check answer-based research modality signals
  if (answers?.research_modality) {
    const modality = answers.research_modality.toLowerCase();
    if (
      modality === "literature review and synthesis" ||
      modality === "mixed methods"
    ) {
      domains.add("research");
      domains.delete("software");
    } else if (modality === "machine learning / model training") {
      domains.add("research");
      domains.add("software");
    }
  }

  return [...domains].sort();
}
