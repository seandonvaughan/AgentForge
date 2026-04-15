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
 * Build a custom agent template by cloning a base template and adjusting
 * the name, description, and model tier.
 */
function buildCustomAgentTemplate(
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
      system_prompt: `You are the ${customName} agent. ${reason}`,
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

/**
 * Run the full AgentForge pipeline against a project directory.
 *
 * Uses the domain-aware pipeline when domain packs are available:
 * 1. Scan the project (files, git, dependencies, CI).
 * 2. Load domain packs and determine which domains are active.
 * 3. Load agent templates (domain-organized when packs exist, flat otherwise).
 * 4. Compose the optimal team via domain-aware or flat-template fallback composition.
 * 5. Customize each template with project-specific context.
 * 6. Build a {@link TeamManifest}.
 * 7. Write everything to `.agentforge/` inside the project.
 * 8. Return the manifest.
 *
 * @param projectRoot - Absolute path to the project to forge a team for.
 * @returns The generated {@link TeamManifest}.
 */
export async function forgeTeam(projectRoot: string): Promise<TeamManifest> {
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

    composition = composeTeamFromDomains(scan, activeDomainIds, domainPacks);
  } else {
    // Fallback pipeline: flat template loading + original composition
    const templatesDir = getDefaultTemplatesDir();
    templates = await loadAllTemplates(templatesDir);
    composition = composeTeam(scan);
  }

  // 4. Customize each template
  const projectName = deriveProjectName(projectRoot);
  const customizedAgents = new Map<string, AgentTemplate>();

  for (const agentName of composition.agents) {
    const template = templates.get(agentName);
    if (template) {
      customizedAgents.set(
        agentName,
        customizeTemplate(template, scan, projectName),
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
      customizeTemplate(customTemplate, scan, projectName),
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
  const modelRouting = { opus: [] as string[], sonnet: [] as string[], haiku: [] as string[] };
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
