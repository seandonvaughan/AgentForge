/**
 * Web Researcher Scanner Stub for AgentForge (Haiku-tier).
 *
 * Provides autonomous web research on a project's domain, market, and
 * competitive landscape. This is a stub implementation that returns empty
 * findings with an informational note. The real implementation will use the
 * Anthropic SDK's web-search capability via a Haiku agent in a future phase.
 *
 * Uses only Node.js built-in modules; no external dependencies.
 */

import type { ResearchFindings } from "../types/analysis.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Research a project's domain, market size, competitors, and industry trends.
 *
 * Stub behaviour:
 *   - When no ANTHROPIC_API_KEY is set, returns empty findings with a note
 *     explaining that the API key is not configured.
 *   - When an API key is present, still returns empty findings with a note
 *     indicating the real implementation is a future deliverable.
 *
 * @param projectName  Human-readable name of the project being researched.
 * @param keywords     Domain keywords to guide the research query.
 * @returns  A ResearchFindings object (always resolves, never throws).
 */
export async function researchProject(
  projectName: string,
  keywords: string[],
): Promise<ResearchFindings> {
  const hasApiKey = Boolean(process.env["ANTHROPIC_API_KEY"]);

  if (!hasApiKey) {
    return {
      note:
        "Web research is unavailable: ANTHROPIC_API_KEY is not configured. " +
        `Set the environment variable to enable autonomous research for "${projectName}" ` +
        `(keywords: ${keywords.length > 0 ? keywords.join(", ") : "none"}).`,
    };
  }

  // API key is present but the real Anthropic SDK integration is a future
  // deliverable (see plan Task H4, Step 3).
  return {
    note:
      `Web research stub: real implementation will use the Anthropic SDK ` +
      `(Haiku web-search agent) to research "${projectName}" ` +
      `with keywords [${keywords.join(", ")}]. ` +
      "This will be implemented in a future phase.",
  };
}
