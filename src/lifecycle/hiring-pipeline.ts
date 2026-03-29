/**
 * HiringPipeline — AgentForge v6.0 P1-2
 *
 * Runs the Genesis agent to synthesize a new agent YAML definition,
 * writes it to disk, and registers the new agent in the lifecycle
 * manager. Every step is a real Anthropic API call via AgentRuntime.
 *
 * Export:
 *   executeHiring(recommendation, genesisAgentDir) → Promise<HiringResult>
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentRuntime, loadAgentConfig } from "../../packages/core/src/agent-runtime/index.js";
import type { AgentLifecycleManager } from "./agent-lifecycle-manager.js";
import type { HiringRecommendation, AgentIdentity } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options passed to executeHiring. */
export interface HiringExecutionOptions {
  /**
   * Path to the .agentforge directory.
   * Genesis YAML is read from <genesisAgentDir>/agents/genesis.yaml.
   * The new agent YAML is written to <genesisAgentDir>/agents/<newId>.yaml.
   */
  genesisAgentDir: string;

  /**
   * Optional lifecycle manager.  When provided, the new agent is also
   * registered so it is immediately available for task routing.
   */
  lifecycleManager?: AgentLifecycleManager;
}

/** Result of a successful hiring execution. */
export interface HiringResult {
  /** The newly-created agent ID (slugified from the name). */
  agentId: string;
  /** Absolute path to the written YAML file. */
  yamlPath: string;
  /** Raw YAML content produced by Genesis. */
  yamlContent: string;
  /** AgentIdentity registered in the lifecycle manager (if one was provided). */
  identity?: AgentIdentity;
  /** USD cost of the Genesis API call. */
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a human name like "Backend Senior Coder" to a slug "backend-senior-coder". */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Extract a YAML block from a Genesis response. */
function extractYaml(text: string): string | null {
  // Try fenced yaml block
  const fenceMatch = /```(?:yaml)?\s*([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Heuristic: if the response starts with "name:" it's raw YAML
  const trimmed = text.trim();
  if (trimmed.startsWith("name:")) return trimmed;

  return null;
}

/** Extract a field value from a simple YAML string (key: value on one line). */
function yamlField(yaml: string, field: string): string | undefined {
  const re = new RegExp(`^${field}:\\s*['\"]?([^'\"\\n]+)['\"]?`, "m");
  const m = re.exec(yaml);
  return m?.[1]?.trim();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Execute the hiring workflow for a given recommendation.
 *
 * 1. Loads the Genesis agent config from <genesisAgentDir>/agents/genesis.yaml.
 * 2. Calls the Genesis agent via AgentRuntime with a structured prompt that
 *    describes the role, seniority, skills, and justification.
 * 3. Parses the YAML block from the response.
 * 4. Writes the YAML to <genesisAgentDir>/agents/<id>.yaml.
 * 5. Registers the agent in the lifecycle manager (if provided).
 *
 * @param recommendation   The approved hiring recommendation to execute.
 * @param options          Paths and optional lifecycle manager.
 * @returns                The result including file path and registered identity.
 */
export async function executeHiring(
  recommendation: HiringRecommendation,
  options: HiringExecutionOptions,
): Promise<HiringResult> {
  const { genesisAgentDir, lifecycleManager } = options;

  // -------------------------------------------------------------------------
  // 1. Load Genesis agent config
  // -------------------------------------------------------------------------
  const config = await loadAgentConfig("genesis", genesisAgentDir);
  if (!config) {
    throw new Error(`Genesis agent config not found in ${genesisAgentDir}`);
  }
  config.workspaceId = "hiring";

  // -------------------------------------------------------------------------
  // 2. Build the hiring prompt
  // -------------------------------------------------------------------------
  const skillList = (recommendation.requestedSkills ?? []).join(", ") || "general-purpose";

  const task =
    `You are the Genesis agent. A hiring request has been approved. Create a complete agent YAML definition.\n\n` +
    `Hiring request details:\n` +
    `  Team ID:    ${recommendation.teamId}\n` +
    `  Role:       ${recommendation.requestedRole}\n` +
    `  Seniority:  ${recommendation.requestedSeniority}\n` +
    `  Skills:     ${skillList}\n` +
    `  Justification: ${recommendation.justification ?? "N/A"}\n\n` +
    `Generate a production-ready agent YAML with these fields:\n` +
    `  name: <descriptive agent name>\n` +
    `  model: <haiku|sonnet|opus — choose based on seniority>\n` +
    `  version: '1.0'\n` +
    `  description: <one-line description>\n` +
    `  system_prompt: >\n` +
    `    <multi-line system prompt tailored to the role and skills>\n` +
    `  skills:\n` +
    `    - <skill1>\n` +
    `  collaboration:\n` +
    `    reports_to: ${recommendation.teamId}\n` +
    `    can_delegate_to: []\n\n` +
    `Output ONLY the YAML content inside a fenced code block:\n` +
    "```yaml\n<agent yaml here>\n```";

  // -------------------------------------------------------------------------
  // 3. Run Genesis
  // -------------------------------------------------------------------------
  const runtime = new AgentRuntime(config);
  const result = await runtime.runStreaming({ task });

  if (result.status === "failed") {
    throw new Error(`Genesis agent failed during hiring: ${result.error ?? "unknown error"}`);
  }

  // -------------------------------------------------------------------------
  // 4. Parse the YAML from the response
  // -------------------------------------------------------------------------
  const yamlContent = extractYaml(result.response);
  if (!yamlContent) {
    throw new Error(
      `Genesis agent did not return a valid YAML block.\n` +
      `Response preview: ${result.response.slice(0, 300)}`,
    );
  }

  // Derive the agent ID from the name field
  const rawName = yamlField(yamlContent, "name") ?? `${recommendation.requestedRole}-${recommendation.requestedSeniority}`;
  const agentId = slugify(rawName);

  // -------------------------------------------------------------------------
  // 5. Write the YAML file
  // -------------------------------------------------------------------------
  const agentsDir = join(genesisAgentDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  const yamlPath = join(agentsDir, `${agentId}.yaml`);
  await writeFile(yamlPath, yamlContent, "utf-8");

  // -------------------------------------------------------------------------
  // 6. Register in lifecycle manager (optional)
  // -------------------------------------------------------------------------
  let identity: AgentIdentity | undefined;
  if (lifecycleManager) {
    const now = new Date().toISOString();

    // Map seniority to a sensible maxConcurrentTasks default
    const concurrencyMap: Record<string, number> = {
      junior: 1, mid: 2, senior: 3, lead: 4, principal: 5,
    };

    // Map seniority to a model tier if not already resolved
    const modelMap: Record<string, "haiku" | "sonnet" | "opus"> = {
      junior: "haiku", mid: "sonnet", senior: "sonnet", lead: "opus", principal: "opus",
    };

    identity = {
      id: agentId,
      name: rawName,
      role: recommendation.requestedRole,
      seniority: recommendation.requestedSeniority,
      layer: "backend", // default; Genesis YAML may override at runtime
      teamId: recommendation.teamId,
      model: modelMap[recommendation.requestedSeniority] ?? "sonnet",
      status: "idle",
      hiredAt: now,
      currentTasks: [],
      maxConcurrentTasks: concurrencyMap[recommendation.requestedSeniority] ?? 2,
    };

    lifecycleManager.registerAgent(identity);
  }

  return {
    agentId,
    yamlPath,
    yamlContent,
    identity,
    costUsd: result.costUsd,
  };
}
