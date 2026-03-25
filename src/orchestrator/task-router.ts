/**
 * Task Router for the AgentForge Orchestrator.
 *
 * Routes incoming tasks to the best-matching agent based on
 * file patterns, keyword triggers, and agent category alignment.
 */

import type { AgentCategory, AgentTemplate } from "../types/agent.js";
import type { TeamManifest } from "../types/team.js";

/** A single agent match with confidence score and reasoning. */
export interface RouteMatch {
  /** Name of the matched agent. */
  agent: string;
  /** Confidence score between 0 and 1. */
  confidence: number;
  /** Human-readable explanation of why this agent was matched. */
  reason: string;
}

/**
 * Checks whether a file path matches a glob-like pattern.
 *
 * Supports simple wildcards:
 *   - `*` matches any sequence within a single path segment
 *   - `**` matches any number of path segments
 */
function matchesPattern(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  const regex = new RegExp(`(^|/)${regexStr}$`);
  return regex.test(filePath);
}

/** Maps broad task intent keywords to the agent category best suited. */
const CATEGORY_KEYWORDS: Record<AgentCategory, string[]> = {
  strategic: [
    "plan", "design", "architect", "strategy", "roadmap", "decide",
    "evaluate", "propose", "rfc", "adr", "tradeoff",
  ],
  implementation: [
    "implement", "code", "build", "create", "add", "feature",
    "develop", "write", "scaffold", "refactor",
  ],
  quality: [
    "test", "review", "lint", "audit", "check", "verify",
    "coverage", "security", "vulnerability", "bug",
  ],
  utility: [
    "document", "docs", "ci", "deploy", "pipeline", "format",
    "migrate", "update", "dependency", "changelog",
  ],
};

/**
 * Routes a task to the best-matching agents.
 *
 * Scoring is based on three signals that are combined additively:
 *   1. File-pattern overlap (up to 0.4)
 *   2. Keyword trigger matches (up to 0.35)
 *   3. Category alignment (up to 0.25)
 *
 * @returns A ranked list of {@link RouteMatch} entries, highest confidence first.
 */
export function routeTask(
  task: string,
  filePaths: string[],
  teamManifest: TeamManifest,
  agents: Map<string, AgentTemplate>,
): RouteMatch[] {
  const taskLower = task.toLowerCase();
  const taskWords = taskLower.split(/\s+/);
  const matches: RouteMatch[] = [];

  // Determine which category the task most likely falls into.
  const inferredCategory = inferCategory(taskWords);

  // Collect all agent names from the manifest.
  const allAgentNames = [
    ...teamManifest.agents.strategic,
    ...teamManifest.agents.implementation,
    ...teamManifest.agents.quality,
    ...teamManifest.agents.utility,
  ];

  for (const agentName of allAgentNames) {
    const template = agents.get(agentName);
    if (!template) continue;

    const reasons: string[] = [];
    let score = 0;

    // --- 1. File-pattern score (max 0.4) ---
    if (filePaths.length > 0 && template.triggers.file_patterns.length > 0) {
      const matchedFiles = filePaths.filter((fp) =>
        template.triggers.file_patterns.some((pat) => matchesPattern(fp, pat)),
      );
      if (matchedFiles.length > 0) {
        const ratio = matchedFiles.length / filePaths.length;
        const fileScore = Math.min(ratio, 1) * 0.4;
        score += fileScore;
        reasons.push(
          `Matched ${matchedFiles.length}/${filePaths.length} file(s) against patterns`,
        );
      }
    }

    // --- 2. Keyword trigger score (max 0.35) ---
    if (template.triggers.keywords.length > 0) {
      const matchedKeywords = template.triggers.keywords.filter((kw) =>
        taskLower.includes(kw.toLowerCase()),
      );
      if (matchedKeywords.length > 0) {
        const ratio = matchedKeywords.length / template.triggers.keywords.length;
        const kwScore = Math.min(ratio, 1) * 0.35;
        score += kwScore;
        reasons.push(
          `Matched keywords: ${matchedKeywords.join(", ")}`,
        );
      }
    }

    // --- 3. Category alignment score (max 0.25) ---
    const agentCategory = getCategoryForAgent(agentName, teamManifest);
    if (agentCategory && inferredCategory && agentCategory === inferredCategory) {
      score += 0.25;
      reasons.push(`Category "${agentCategory}" aligns with task intent`);
    }

    if (score > 0) {
      matches.push({
        agent: agentName,
        confidence: Math.round(score * 1000) / 1000,
        reason: reasons.join("; "),
      });
    }
  }

  // Sort descending by confidence.
  matches.sort((a, b) => b.confidence - a.confidence);

  return matches;
}

/**
 * Infers the most likely agent category from the words in a task description.
 */
function inferCategory(taskWords: string[]): AgentCategory | null {
  let bestCategory: AgentCategory | null = null;
  let bestCount = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const count = taskWords.filter((w) =>
      keywords.some((kw) => w.includes(kw)),
    ).length;
    if (count > bestCount) {
      bestCount = count;
      bestCategory = category as AgentCategory;
    }
  }

  return bestCategory;
}

/**
 * Determines which category an agent belongs to within the team manifest.
 */
function getCategoryForAgent(
  agentName: string,
  manifest: TeamManifest,
): AgentCategory | null {
  if (manifest.agents.strategic.includes(agentName)) return "strategic";
  if (manifest.agents.implementation.includes(agentName)) return "implementation";
  if (manifest.agents.quality.includes(agentName)) return "quality";
  if (manifest.agents.utility.includes(agentName)) return "utility";
  return null;
}
