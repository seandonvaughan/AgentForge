/**
 * Synthesis — Phase B of the agent-driven forge pipeline.
 *
 * Takes the five recon artifacts produced by Phase A agents plus a corpus of
 * representative source files, invokes Opus to design the full agent roster,
 * validates the output, and atomically writes all output files.
 *
 * Output files written:
 *   .agentforge/agents/<id>.yaml       — per-agent YAML (AgentTemplate-compatible)
 *   .claude/agents/<id>.md             — CC-compatible frontmatter + system_prompt
 *   .agentforge/team.yaml              — team manifest (compatible with TeamManifest)
 *   .agentforge/forge/team-plan.json   — raw synthesis output for audit
 */

import { readFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { z } from "zod";
import { writeFileAtomic } from "../fs/atomic-write.js";

import type { AgentRuntime } from "../../../agent-runtime/agent-runtime.js";
import type {
  SubsystemsReport,
  DependenciesReport,
  ConventionsReport,
  DomainReport,
  HistoryReport,
} from "./recon/schemas.js";
import { BASELINE_PR_MERGE_MANAGER } from "./pr-merge-manager-baseline.js";
import { AgentOutputSchemaSchema } from "../../agent-yaml/agent-yaml-schema.js";

// ---------------------------------------------------------------------------
// TeamPlan Zod schema
// ---------------------------------------------------------------------------

export const TeamPlanAgentSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  tier: z.enum(["opus", "sonnet", "haiku"]),
  category: z.enum(["strategic", "implementation", "quality", "utility"]),
  owns_subsystems: z.array(z.string()),
  capability_tags: z.array(z.string().min(1)),
  system_prompt: z.string().min(1),
  auto_include_files: z.array(z.string()),
  learnings_seed: z.array(z.string()),
  skill_ids: z.array(z.string()).optional(),
  // Structured return-value contract; required for implementation-tier agents
  // but tolerated as absent for backward compatibility.
  output_schema: AgentOutputSchemaSchema.optional(),
});

export type TeamPlanAgent = z.infer<typeof TeamPlanAgentSchema>;

export const TeamPlanSchema = z.object({
  team_name: z.string().min(1),
  agents: z.array(TeamPlanAgentSchema),
});

export type TeamPlan = z.infer<typeof TeamPlanSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SynthesisCapacityError extends Error {
  constructor(
    public readonly rosterSize: number,
    public readonly min: number,
    public readonly max: number,
  ) {
    super(
      `Synthesis produced ${rosterSize} agents but the hard cap is ${min}–${max}. ` +
        `Either the Opus response was truncated or the prompt constraints were ignored.`,
    );
    this.name = "SynthesisCapacityError";
  }
}

export class SynthesisParseError extends Error {
  constructor(
    public readonly rawResponse: string,
    cause?: unknown,
  ) {
    super(
      `Failed to parse Opus synthesis output. ` +
        `Expected a fenced JSON block. Raw (first 500 chars): ` +
        rawResponse.slice(0, 500),
    );
    this.name = "SynthesisParseError";
    if (cause) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SynthesizeTeamOptions {
  /** Five recon artifacts from Phase A. */
  reconResults: {
    subsystems: SubsystemsReport;
    dependencies: DependenciesReport;
    conventions: ConventionsReport;
    domain: DomainReport;
    history: HistoryReport;
  };
  /** Representative source files — ~50k tokens total. */
  sourceCorpus: Array<{ path: string; content: string }>;
  /** Absolute path to the project root being forged. */
  projectRoot: string;
  /**
   * Model tier to use for synthesis.
   * @default "opus"
   */
  model?: "opus" | "sonnet";
  /** Injected AgentRuntime — provide a mock in tests. */
  runtime: AgentRuntime;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROSTER_MIN = 12;
const ROSTER_MAX = 30;
const LEARNINGS_SEED_MAX = 8;
const PR_MERGE_MANAGER_ID = "pr-merge-manager";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Load the synthesis system prompt from the sibling .md file.
 *
 * Resilient to running from `dist/` (where tsc doesn't copy .md files) by
 * falling back to the corresponding `src/` path. This lets the agent-driven
 * forge work even when consumers haven't wired a build step to copy assets.
 */
async function loadSynthesisPrompt(): Promise<string> {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const distPath = join(selfDir, "synthesis-prompt.md");
  try {
    return await readFile(distPath, "utf-8");
  } catch {
    // Fall back to the src/ tree if we're running from dist/
    const srcPath = distPath.replace(
      `${"/dist/"}`,
      "/src/",
    );
    return readFile(srcPath, "utf-8");
  }
}

/** Build the user message from recon results and source corpus. */
function buildUserMessage(
  recon: SynthesizeTeamOptions["reconResults"],
  corpus: Array<{ path: string; content: string }>,
): string {
  const parts: string[] = [];

  parts.push("## Recon Results\n");
  parts.push("```json");
  parts.push(JSON.stringify(recon, null, 2));
  parts.push("```\n");

  parts.push("## Source Corpus\n");
  for (const file of corpus) {
    parts.push(`### file: ${file.path}`);
    parts.push(file.content);
    parts.push("");
  }

  return parts.join("\n");
}

/** Extract the first fenced ```json block from a string. */
function extractJsonBlock(text: string): string {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match || !match[1]) {
    throw new SynthesisParseError(text);
  }
  return match[1].trim();
}

/** Parse and validate a raw Opus response into a TeamPlan. */
function parseTeamPlan(rawResponse: string): TeamPlan {
  let jsonText: string;
  try {
    jsonText = extractJsonBlock(rawResponse);
  } catch {
    throw new SynthesisParseError(rawResponse);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new SynthesisParseError(rawResponse, err);
  }

  const result = TeamPlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new SynthesisParseError(
      rawResponse,
      new Error(
        `Zod validation failed: ${result.error.issues.map((i) => i.message).join(", ")}`,
      ),
    );
  }

  return result.data;
}

/** Enforce roster size limits. */
function validateRosterSize(plan: TeamPlan): void {
  const n = plan.agents.length;
  if (n < ROSTER_MIN || n > ROSTER_MAX) {
    throw new SynthesisCapacityError(n, ROSTER_MIN, ROSTER_MAX);
  }
}

/** Inject BASELINE_PR_MERGE_MANAGER if synthesis omitted it. */
function ensurePrMergeManager(plan: TeamPlan): TeamPlan {
  const hasPmm = plan.agents.some((a) => a.id === PR_MERGE_MANAGER_ID);
  if (hasPmm) return plan;

  return {
    ...plan,
    agents: [...plan.agents, BASELINE_PR_MERGE_MANAGER],
  };
}

/** Ensure directory exists (recursive). */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

/**
 * Write a file atomically: write to a tmp file, then rename.
 * This prevents partial writes from being observed by concurrent readers.
 */
async function writeAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  await writeFileAtomic(filePath, content);
}

/** Map an agent tier to its default reasoning-effort level. */
function defaultEffortFor(tier: "opus" | "sonnet" | "haiku"): string {
  // Opus runs at the highest effort by default (deep architecture / strategy
  // work). Sonnet defaults to high (most engineers). Haiku stays at medium —
  // it's used for utility/filter agents where xhigh is wasteful.
  if (tier === "opus") return "xhigh";
  if (tier === "sonnet") return "high";
  return "medium";
}

/** Build the AgentTemplate-compatible YAML object for an agent. */
function buildAgentYaml(agent: TeamPlanAgent): Record<string, unknown> {
  // Warn (but do NOT fail) when an implementation-tier agent lacks output_schema.
  // This preserves backward compat with agents synthesised before this field existed.
  if (agent.category === "implementation" && !agent.output_schema) {
    console.warn(
      `[synthesis] implementation agent "${agent.id}" is missing output_schema — ` +
        `consider adding a structured return-value contract.`,
    );
  }

  const obj: Record<string, unknown> = {
    name: agent.id,
    model: agent.tier,
    // Surface the category as a top-level field so dashboard loaders and
    // legacy consumers that read each YAML in isolation can determine which
    // team bucket the agent belongs to without cross-referencing team.yaml.
    team: agent.category,
    effort: defaultEffortFor(agent.tier),
    version: "1.0",
    description: agent.capability_tags.slice(0, 5).join(", "),
    system_prompt: agent.system_prompt,
    skills: agent.capability_tags,
    triggers: {
      file_patterns: [],
      keywords: agent.capability_tags,
    },
    collaboration: {
      reports_to: agent.category === "strategic" ? null : "architect",
      reviews_from: [],
      can_delegate_to: [],
      parallel: true,
    },
    context: {
      max_files: 30,
      auto_include: agent.auto_include_files,
      project_specific: agent.owns_subsystems,
    },
    learnings: agent.learnings_seed.slice(0, LEARNINGS_SEED_MAX),
    owns_subsystems: agent.owns_subsystems,
    capability_tags: agent.capability_tags,
    ...(agent.skill_ids && agent.skill_ids.length > 0 ? { skill_ids: agent.skill_ids } : {}),
  };

  // Pass output_schema through verbatim when present — js-yaml handles the
  // nested object structure correctly.
  if (agent.output_schema !== undefined) {
    obj["output_schema"] = agent.output_schema;
  }

  return obj;
}

/** Build the CC-compatible .md frontmatter + body for an agent. */
function buildAgentMarkdown(agent: TeamPlanAgent): string {
  const frontmatter = [
    "---",
    `name: ${agent.id}`,
    `description: >-`,
    `  ${agent.capability_tags.slice(0, 5).join(", ")}`,
    `tools: Read,Edit,Write,Bash,Grep,Glob`,
    `model: ${agent.tier}`,
    "---",
    "",
  ].join("\n");

  return frontmatter + agent.system_prompt;
}

/** Build team.yaml compatible with the current TeamManifest schema. */
function buildTeamYaml(
  plan: TeamPlan,
  projectRoot: string,
): Record<string, unknown> {
  // Group agents by category
  const byCategory: Record<string, string[]> = {
    strategic: [],
    implementation: [],
    quality: [],
    utility: [],
  };

  const modelRouting: Record<string, string[]> = {
    opus: [],
    sonnet: [],
    haiku: [],
  };

  const delegationGraph: Record<string, string[]> = {};

  for (const agent of plan.agents) {
    const bucket = byCategory[agent.category] ?? [];
    bucket.push(agent.id);
    byCategory[agent.category] = bucket;

    const tierBucket = modelRouting[agent.tier] ?? [];
    tierBucket.push(agent.id);
    modelRouting[agent.tier] = tierBucket;
  }

  // Strategic agents delegate to all implementation agents
  const strategicAgents = byCategory.strategic ?? [];
  const implementationAgents = byCategory.implementation ?? [];
  if (strategicAgents.length > 0 && implementationAgents.length > 0) {
    for (const sa of strategicAgents) {
      delegationGraph[sa] = [...implementationAgents];
    }
  }

  const projectHash = createHash("sha256")
    .update(projectRoot)
    .update(plan.team_name)
    .digest("hex")
    .slice(0, 12);

  return {
    name: plan.team_name,
    forged_at: new Date().toISOString(),
    forged_by: "agentforge-synthesis",
    project_hash: projectHash,
    agents: byCategory,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invoke Opus to synthesize an agent team from recon artifacts and a source
 * corpus, validate the output, and write all files to `projectRoot`.
 *
 * @returns The parsed and validated {@link TeamPlan}.
 */
export async function synthesizeTeam(
  opts: SynthesizeTeamOptions,
): Promise<TeamPlan> {
  const { reconResults, sourceCorpus, projectRoot, runtime } = opts;

  // 1. Load the synthesis system prompt
  const systemPrompt = await loadSynthesisPrompt();

  // 2. Build user message
  const userMessage = buildUserMessage(reconResults, sourceCorpus);

  // 3. Call runtime
  const result = await runtime.run({
    task: userMessage,
  });

  if (result.status === "failed") {
    throw new Error(
      `Synthesis runtime call failed: ${result.error ?? "unknown error"}`,
    );
  }

  // 4. Parse output
  let plan = parseTeamPlan(result.response);

  // 5. Validate roster size BEFORE injecting pr-merge-manager
  //    (injection is additive — we validate what Opus actually produced)
  validateRosterSize(plan);

  // 6. Ensure pr-merge-manager is present
  plan = ensurePrMergeManager(plan);

  // 7. Write output files atomically
  await emitFiles(plan, projectRoot);

  return plan;
}

/**
 * Write all output files for a synthesized team plan.
 * Extracted as a separate function so tests can verify file structure.
 */
/**
 * Delete every .yaml file under agentsDir and every .md file under
 * claudeAgentsDir. Used at the start of every forge run so stale generalist
 * agents from prior runs don't dilute the new specialist team.
 *
 * Scoped strictly to leaf files in the two named directories — never
 * recursive, never touches subdirectories.
 */
async function clearStaleAgentFiles(
  agentsDir: string,
  claudeAgentsDir: string,
): Promise<void> {
  await Promise.all([
    clearLeafFiles(agentsDir, [".yaml", ".yml"]),
    clearLeafFiles(claudeAgentsDir, [".md"]),
  ]);
}

async function clearLeafFiles(dir: string, exts: readonly string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => exts.some((ext) => name.endsWith(ext)))
      .map((name) => unlink(join(dir, name)).catch(() => undefined)),
  );
}

async function emitFiles(plan: TeamPlan, projectRoot: string): Promise<void> {
  const agentforgeDir = join(projectRoot, ".agentforge");
  const agentsDir = join(agentforgeDir, "agents");
  const claudeAgentsDir = join(projectRoot, ".claude", "agents");
  const forgeDir = join(agentforgeDir, "forge");

  // Ensure directories exist
  await Promise.all([
    ensureDir(agentsDir),
    ensureDir(claudeAgentsDir),
    ensureDir(forgeDir),
  ]);

  // Clear stale agent YAMLs from any prior forge run. The new team plan is
  // the source of truth; leaving old generalist YAMLs behind dilutes the
  // capability-tag routing index and leaks broken prompts back into cycles.
  // We only delete `.yaml`/`.md` files in the agents dirs — never recursive.
  await clearStaleAgentFiles(agentsDir, claudeAgentsDir);

  // Build file contents
  const teamYamlContent = yaml.dump(buildTeamYaml(plan, projectRoot), {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });

  const teamPlanJsonContent = JSON.stringify(plan, null, 2);

  // Write all files in parallel
  await Promise.all([
    // .agentforge/team.yaml
    writeAtomic(join(agentforgeDir, "team.yaml"), teamYamlContent),

    // .agentforge/forge/team-plan.json
    writeAtomic(join(forgeDir, "team-plan.json"), teamPlanJsonContent),

    // Per-agent files
    ...plan.agents.flatMap((agent) => [
      // .agentforge/agents/<id>.yaml
      writeAtomic(
        join(agentsDir, `${agent.id}.yaml`),
        yaml.dump(buildAgentYaml(agent), { lineWidth: 120, noRefs: true, sortKeys: false }),
      ),

      // .claude/agents/<id>.md
      writeAtomic(
        join(claudeAgentsDir, `${agent.id}.md`),
        buildAgentMarkdown(agent),
      ),
    ]),
  ]);
}
