/**
 * Builder barrel export for AgentForge — Phase 3: Team Builder Engine.
 *
 * Orchestrates the full forge pipeline: scan -> load templates -> compose
 * team -> customize -> write output. Re-exports all sub-module types and
 * functions.
 */

export { loadTemplate, loadAllTemplates, getDefaultTemplatesDir, loadDomainTemplates } from "./template-loader.js";
export { composeTeam, composeTeamFromDomains } from "./team-composer.js";
export type { TeamComposition, CustomAgentSpec } from "./team-composer.js";
export { customizeTemplate } from "./template-customizer.js";
export { writeTeam } from "./team-writer.js";
export { validateTeam } from "./validator.js";
export type {
  ValidationReport,
  AgentFinding,
  ValidationSeverity,
  ValidateTeamOptions,
} from "./validator.js";
export { synthesizeTeam } from "./synthesis.js";
export type {
  TeamPlan,
  TeamPlanAgent,
  SynthesizeTeamOptions,
} from "./synthesis.js";
export { forgeTeamAgentDriven } from "./agent-driven-forge.js";
export type {
  AgentDrivenForgeOptions,
  AgentDrivenForgeResult,
} from "./agent-driven-forge.js";
export { buildSourceCorpus } from "./source-corpus.js";
export type {
  SourceCorpusFile,
  SourceCorpusOptions,
  SourceCorpusResult,
} from "./source-corpus.js";

import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { AgentTemplate, ModelTier } from "../types/agent.js";
import type { TeamManifest, TeamAgents } from "../types/team.js";
import type { FullScanResult } from "../scanner/index.js";

import { runFullScan } from "../scanner/index.js";
import { loadAllTemplates, getDefaultTemplatesDir, loadDomainTemplates } from "./template-loader.js";
import { composeTeam, composeTeamFromDomains } from "./team-composer.js";
import type { TeamComposition } from "./team-composer.js";
import { customizeTemplate } from "./template-customizer.js";
import { writeTeam } from "./team-writer.js";
import { loadAllDomains, getDefaultDomainsDir } from "../domains/index.js";
import { activateDomains } from "../domains/domain-activator.js";
import type { DomainId } from "../types/domain.js";
import { AgentRuntime } from "../../../agent-runtime/agent-runtime.js";
import { forgeTeamAgentDriven } from "./agent-driven-forge.js";
import { buildSourceCorpus } from "./source-corpus.js";
import type { SourceCorpusFile } from "./source-corpus.js";
import type { TeamPlan } from "./synthesis.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a short hash of the scan result for cache invalidation. */
function computeProjectHash(scan: FullScanResult): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(scan));
  return hash.digest("hex").slice(0, 12);
}

/** Derive a project name from the project root path. */
function deriveProjectName(projectRoot: string): string {
  return basename(projectRoot) || "project";
}

/**
 * Categorize an agent name into a {@link TeamAgents} category bucket.
 *
 * Uses explicit mappings for known agents and infers from the template
 * for custom agents.
 */
function categorizeAgent(
  name: string,
  template: AgentTemplate,
): keyof TeamAgents {
  const categoryMap: Record<string, keyof TeamAgents> = {
    architect: "strategic",
    coder: "implementation",
    researcher: "utility",
    "file-reader": "utility",
    linter: "quality",
    "security-auditor": "quality",
    "test-engineer": "quality",
    "test-runner": "quality",
    "devops-engineer": "utility",
    "documentation-writer": "utility",
  };

  if (categoryMap[name]) {
    return categoryMap[name];
  }

  // For custom agents, infer from the template
  if (template.collaboration.reports_to === null) return "strategic";
  if (
    template.skills.some((s) =>
      ["testing", "security", "review", "audit"].some((k) => s.includes(k)),
    )
  ) {
    return "quality";
  }

  return "implementation";
}

/**
 * Build the rich, placeholder-driven system prompt for a custom agent that
 * has no base template. The placeholders ({project_name}, {project_purpose},
 * {key_subsystems}, {detected_stack}, {detected_conventions},
 * {baked_learnings}) are filled by `customizeTemplate` so the forged prompt
 * carries real project context instead of a one-liner.
 */
function buildCustomAgentPrompt(customName: string, reason: string): string {
  return [
    `You are the ${customName} for {project_name}.`,
    "",
    "## Identity & Mission",
    "{project_purpose}",
    "",
    `Why this seat exists on the team: ${reason}`,
    "",
    "## Owned Subsystems",
    "{key_subsystems}",
    "",
    "Stay inside the subsystems above. If a change must cross into another",
    "agent's territory, hand it off with a clear note instead of editing.",
    "",
    "## Conventions",
    "- Stack: {detected_stack}",
    "- Conventions: {detected_conventions}",
    "- Match the existing code style precisely — indentation, naming, patterns.",
    "",
    "## Key APIs/Patterns",
    "- Read the primary files of your owned subsystems before every task.",
    "- Mirror the dominant patterns you find there; never invent parallel ones.",
    "",
    "## Pitfalls (lessons from prior cycles)",
    "{baked_learnings}",
    "",
    "## Collaboration",
    "- You report to the architect; escalate design changes instead of deciding alone.",
    "- All changes must pass the project's test suite before you report completion.",
  ].join("\n");
}

/**
 * Build a custom agent template by cloning a base template and adjusting
 * the name, description, and model tier.
 *
 * Exported so tests can assert the rich fallback prompt structure.
 */
export function buildCustomAgentTemplate(
  baseName: string,
  customName: string,
  reason: string,
  templates: Map<string, AgentTemplate>,
  modelTier: ModelTier,
): AgentTemplate {
  const base = templates.get(baseName);
  if (!base) {
    return {
      name: customName,
      model: modelTier,
      version: "1.0",
      description: reason,
      system_prompt: buildCustomAgentPrompt(customName, reason),
      skills: [],
      triggers: { file_patterns: [], keywords: [] },
      collaboration: {
        reports_to: "architect",
        reviews_from: [],
        can_delegate_to: [],
        parallel: false,
      },
      context: { max_files: 30, auto_include: [], project_specific: [] },
    };
  }

  return {
    ...base,
    name: customName,
    model: modelTier,
    description: `${reason} (based on ${baseName})`,
    collaboration: {
      ...base.collaboration,
      reports_to: base.collaboration.reports_to ?? "architect",
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ForgeTeamOptions
// ---------------------------------------------------------------------------

/**
 * Options for {@link forgeTeam}.
 *
 * All fields are optional — the function degrades gracefully to the
 * legacy deterministic pipeline when nothing is provided.
 */
export interface ForgeTeamOptions {
  /**
   * Injected AgentRuntime. When provided, the agent-driven pipeline is
   * used automatically (unless `strategy: 'legacy'` overrides it).
   */
  runtime?: AgentRuntime;
  /**
   * Representative source files to pass to the synthesis phase. When not
   * provided and the agent-driven path is selected, the function will
   * call {@link buildSourceCorpus} automatically.
   */
  sourceCorpus?: SourceCorpusFile[];
  /**
   * Explicit strategy selection.
   *
   * - `'agent-driven'` — always use the agent-driven pipeline (requires
   *   `runtime` to be provided, or the pipeline will throw).
   * - `'legacy'` — always use the deterministic legacy pipeline.
   * - `undefined` (default) — auto-select based on `runtime` presence and
   *   the `AGENTFORGE_FORGE_STRATEGY` environment variable.
   */
  strategy?: "legacy" | "agent-driven";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine which strategy to run.
 *
 * Priority (highest to lowest):
 *   1. `opts.strategy` explicit override
 *   2. Presence of `opts.runtime` (implies agent-driven)
 *   3. `AGENTFORGE_FORGE_STRATEGY` environment variable
 *   4. Conservative default: `'legacy'`
 */
function resolveStrategy(opts: ForgeTeamOptions | undefined): "legacy" | "agent-driven" {
  if (opts?.strategy === "agent-driven") return "agent-driven";
  if (opts?.strategy === "legacy") return "legacy";
  if (opts?.runtime !== undefined) return "agent-driven";
  const envVal = process.env["AGENTFORGE_FORGE_STRATEGY"];
  if (envVal === "agent-driven") return "agent-driven";
  return "legacy";
}

/**
 * Reshape a {@link TeamPlan} produced by synthesis into the canonical
 * {@link TeamManifest} shape expected by callers of `forgeTeam`.
 */
function teamPlanToManifest(plan: TeamPlan, projectRoot: string): TeamManifest {
  const projectName = basename(projectRoot) || "project";

  const agentsByCategory: TeamAgents = {
    strategic: [],
    implementation: [],
    quality: [],
    utility: [],
  };

  const modelRouting: { fable: string[]; opus: string[]; sonnet: string[]; haiku: string[] } = {
    fable: [],
    opus: [],
    sonnet: [],
    haiku: [],
  };

  const delegationGraph: Record<string, string[]> = {};

  for (const agent of plan.agents) {
    const catBucket = agentsByCategory[agent.category] ?? (agentsByCategory[agent.category] = []);
    catBucket.push(agent.id);
    modelRouting[agent.tier].push(agent.id);
  }

  // Strategic agents delegate to all implementation agents
  const strategicAgents = agentsByCategory.strategic ?? [];
  const implementationAgents = agentsByCategory.implementation ?? [];
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
    name: plan.team_name || `${projectName}-team`,
    forged_at: new Date().toISOString(),
    forged_by: "agentforge-synthesis",
    project_hash: projectHash,
    agents: agentsByCategory,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
  };
}

// ---------------------------------------------------------------------------
// Agent-driven path
// ---------------------------------------------------------------------------

/**
 * Construct a default {@link AgentRuntime} for the agent-driven forge when
 * the caller did not inject one (e.g. `AGENTFORGE_FORGE_STRATEGY=agent-driven`
 * via `agentforge team forge`). Uses the same AgentRuntime/ExecutionService
 * construction pattern as the autonomous path (runtime-adapter.ts) — the
 * ExecutionService resolves the actual transport from AGENTFORGE_RUNTIME.
 */
function buildDefaultForgeRuntime(projectRoot: string): AgentRuntime {
  try {
    return new AgentRuntime({
      agentId: "forge-synthesis",
      name: "forge-synthesis",
      model: "opus",
      systemPrompt:
        "You are an AgentForge forge-pipeline agent. Follow the instructions " +
        "supplied in each task exactly and emit only the requested fenced " +
        "JSON block — no prose before or after it.",
      workspaceId: "forge-default",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Agent-driven forge was selected but no runtime was provided and a ` +
        `default runtime could not be constructed for ${projectRoot}: ${detail}. ` +
        `Pass opts.runtime, configure AGENTFORGE_RUNTIME, or fall back with ` +
        `AGENTFORGE_FORGE_STRATEGY=legacy.`,
    );
  }
}

/**
 * Run the agent-driven forge pipeline and return a {@link TeamManifest}.
 *
 * Builds a source corpus automatically when one is not provided, and a
 * default runtime when the caller did not inject one — so the env-var
 * strategy path works from `agentforge team forge` without programmatic
 * wiring. The synthesis phase writes all YAML/MD files to disk; this
 * function only reshapes the plan into the manifest type.
 */
async function runAgentDrivenPath(
  projectRoot: string,
  opts: ForgeTeamOptions,
): Promise<TeamManifest> {
  const runtime = opts.runtime ?? buildDefaultForgeRuntime(projectRoot);

  // Build source corpus if caller didn't supply one
  const corpusFiles = opts.sourceCorpus ?? (await buildSourceCorpus({ projectRoot })).files;

  const result = await forgeTeamAgentDriven({
    projectRoot,
    runtime,
    sourceCorpus: corpusFiles,
  });

  return teamPlanToManifest(result.teamPlan, projectRoot);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full AgentForge pipeline against a project directory.
 *
 * Strategy selection (in priority order):
 *   1. `opts.strategy` explicit override
 *   2. Presence of `opts.runtime` implies agent-driven
 *   3. `AGENTFORGE_FORGE_STRATEGY=agent-driven` environment variable
 *   4. Conservative default: legacy deterministic pipeline
 *
 * When `strategy === 'agent-driven'` (or auto-selected):
 *   - Runs 5 parallel recon agents (Phase A)
 *   - Opus synthesis writes all agent YAML/MD files (Phase B)
 *   - Deterministic validator fact-checks the team (Phase C)
 *   - Routing index is built (Phase D)
 *   - Returns a {@link TeamManifest} reshaped from the synthesized plan
 *
 * When `strategy === 'legacy'` (default):
 *   - Scan → domain packs → templates → compose → customize → write
 *   - Returns a {@link TeamManifest}
 *
 * @param projectRoot - Absolute path to the project to forge a team for.
 * @param opts - Optional strategy/runtime/corpus overrides.
 * @returns The generated {@link TeamManifest}.
 */
export async function forgeTeam(
  projectRoot: string,
  opts?: ForgeTeamOptions,
): Promise<TeamManifest> {
  const strategy = resolveStrategy(opts);

  if (strategy === "agent-driven") {
    return runAgentDrivenPath(projectRoot, opts ?? {});
  }

  // --- Legacy pipeline below ---
  // 1. Run full scan
  const scan: FullScanResult = await runFullScan(projectRoot);

  // 2. Attempt to load domain packs
  const domainsDir = getDefaultDomainsDir();
  const domainPacks = await loadAllDomains(domainsDir);

  // 3. Load templates and compose team (domain-aware or flat-template fallback)
  let composition: TeamComposition;
  let templates: Map<string, AgentTemplate>;

  if (domainPacks.size > 0) {
    // Domain-aware pipeline: activate domains, load domain templates, compose
    const activeDomainIds: DomainId[] = activateDomains(scan, domainPacks);
    const domainTemplates = await loadDomainTemplates(domainsDir);

    // Flatten domain templates into a single map for customization
    templates = new Map<string, AgentTemplate>();
    for (const [, agentMap] of domainTemplates) {
      for (const [agentName, agentTemplate] of agentMap) {
        templates.set(agentName, agentTemplate);
      }
    }

    // Fall back to flat templates for any agents not found in domain templates
    const templatesDir = getDefaultTemplatesDir();
    const flatTemplates = await loadAllTemplates(templatesDir);
    for (const [name, tmpl] of flatTemplates) {
      if (!templates.has(name)) {
        templates.set(name, tmpl);
      }
    }

    composition = composeTeamFromDomains(scan, activeDomainIds, domainPacks, templates);
  } else {
    // Fallback pipeline: flat template loading + original composition
    const templatesDir = getDefaultTemplatesDir();
    templates = await loadAllTemplates(templatesDir);
    composition = composeTeam(scan, templates);
  }

  // 4. Customize each template
  const projectName = deriveProjectName(projectRoot);
  const customizedAgents = new Map<string, AgentTemplate>();

  for (const agentName of composition.agents) {
    const template = templates.get(agentName);
    if (template) {
      customizedAgents.set(
        agentName,
        customizeTemplate(template, scan, projectName, { projectRoot }),
      );
    }
  }

  // Build and customize custom agents
  for (const custom of composition.custom_agents) {
    const customTemplate = buildCustomAgentTemplate(
      custom.base_template,
      custom.name,
      custom.reason,
      templates,
      composition.model_assignments[custom.name] ?? "sonnet",
    );
    customizedAgents.set(
      custom.name,
      customizeTemplate(customTemplate, scan, projectName, { projectRoot }),
    );
  }

  // 5. Build manifest
  const teamAgents: TeamAgents = {
    strategic: [],
    implementation: [],
    quality: [],
    utility: [],
  };

  for (const [name, template] of customizedAgents) {
    const category = categorizeAgent(name, template);
    const bucket = teamAgents[category] ?? (teamAgents[category] = []);
    bucket.push(name);
  }

  const projectHash = computeProjectHash(scan);

  // Build final routing and delegation from the customized agents
  const modelRouting = {
    fable: [] as string[],
    opus: [] as string[],
    sonnet: [] as string[],
    haiku: [] as string[],
  };
  for (const [name, template] of customizedAgents) {
    modelRouting[template.model].push(name);
  }

  const delegationGraph: Record<string, string[]> = {};
  for (const [name, template] of customizedAgents) {
    if (template.collaboration.can_delegate_to.length > 0) {
      delegationGraph[name] = [...template.collaboration.can_delegate_to];
    }
  }

  const manifest: TeamManifest = {
    name: `${projectName}-team`,
    forged_at: new Date().toISOString(),
    forged_by: "agentforge",
    project_hash: projectHash,
    agents: teamAgents,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
  };

  // 6. Write to .agentforge/
  await writeTeam(projectRoot, manifest, customizedAgents, scan);

  // 7. Return the manifest
  return manifest;
}
