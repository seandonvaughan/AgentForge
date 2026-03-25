/**
 * Genesis barrel export and workflow orchestrators for AgentForge.
 *
 * Guides the user from an idea to a fully composed agent team.
 * Supports two modes:
 *  - Interview mode: prompts the user with structured questions
 *  - Auto mode:      detects domains from the project directory
 *
 * Returns a {@link GenesisResult} containing the proposed team manifest
 * and the project brief used to produce it.
 *
 * Also exposes the low-level Genesis pipeline via `genesis(projectRoot)`.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { discover } from "./discovery.js";
import { buildBrief } from "./brief-builder.js";
import { designTeam } from "./team-designer.js";
import { writeTeam } from "../builder/index.js";
import { runFullScan } from "../scanner/index.js";
import { loadAllDomains, activateDomains } from "../domains/index.js";
import { loadDomainTemplates } from "../builder/template-loader.js";
import { customizeTemplate } from "../builder/index.js";
import type { TeamManifest } from "../types/team.js";
import type { ProjectBrief } from "../types/analysis.js";
import type { DomainId } from "../types/domain.js";

// ---------------------------------------------------------------------------
// Re-exports (sub-modules)
// ---------------------------------------------------------------------------

export { discover } from "./discovery.js";
export type { DiscoveryResult, DiscoveryState } from "./discovery.js";

export { getInterviewQuestions } from "./interviewer.js";
export type { InterviewQuestion } from "./interviewer.js";

export { runInteractiveInterview } from "./interview-runner.js";

export { designTeam } from "./team-designer.js";

export { buildBrief } from "./brief-builder.js";
export type { BuildBriefParams } from "./brief-builder.js";

// ---------------------------------------------------------------------------
// Top-level genesis pipeline
// ---------------------------------------------------------------------------

/**
 * Return the default domains directory.
 *
 * Resolves to `<package-root>/templates/domains/` whether the module is
 * running from `src/` (ts-node / tsx) or from `dist/` (compiled JS).
 */
function getDefaultDomainsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // From src/genesis/ or dist/genesis/, go up two levels to package root.
  const packageRoot = join(dirname(thisFile), "..", "..");
  return join(packageRoot, "templates", "domains");
}

/**
 * Infer minimal domain IDs from discovery signals when domain packs are
 * unavailable.  Always includes "core".
 */
function inferDomainsFromSignals(signals: string[]): DomainId[] {
  const domains = new Set<DomainId>(["core"]);

  if (signals.includes("codebase_present")) {
    domains.add("software");
  }

  if (signals.includes("documents_present")) {
    domains.add("business");
  }

  return [...domains].sort();
}

/**
 * Run the full Genesis workflow against a project root.
 *
 * This is the high-level "one-call" API.  It handles all edge cases
 * (empty dir, scan failures, missing domain packs) gracefully.
 *
 * Pipeline:
 * 1. Discover — classify the project root
 * 2. Scan — run full scanner suite when something exists
 * 3. Domains — load domain packs and activate the relevant ones
 * 4. Brief — build a universal ProjectBrief
 * 5. Design — design the optimal agent team for the brief
 * 6. Return — hand back the ready-to-use TeamManifest
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param answers     - Optional interview answers that supplement discovery.
 * @returns A {@link TeamManifest} describing the designed team.
 */
export async function genesis(
  projectRoot: string,
  answers: Record<string, string> = {},
): Promise<TeamManifest> {
  // Phase 1: Discovery
  const discoveryResult = await discover(projectRoot);

  // Phase 2: Context Gathering
  const scan =
    discoveryResult.state !== "empty"
      ? await runFullScan(projectRoot).catch(() => null)
      : null;

  // Phase 3: Domain Loading & Activation
  const domainsDir = getDefaultDomainsDir();

  let domainPacks = new Map<DomainId, import("../types/domain.js").DomainPack>();
  try {
    domainPacks = await loadAllDomains(domainsDir);
  } catch {
    // No domain packs found — proceed with empty map.
  }

  const activeDomains =
    scan && domainPacks.size > 0
      ? activateDomains(scan, domainPacks)
      : inferDomainsFromSignals(discoveryResult.signals);

  // Phase 4: Project Brief
  const brief = buildBrief({
    scan: scan ?? undefined,
    answers: Object.keys(answers).length > 0 ? answers : undefined,
  });

  // Phase 5: Team Design
  let templates = new Map<
    DomainId,
    Map<string, import("../types/agent.js").AgentTemplate>
  >();
  try {
    templates = await loadDomainTemplates(domainsDir);
  } catch {
    // No templates available — designTeam still works with empty map.
  }

  const manifest = designTeam(brief, activeDomains, domainPacks, templates);

  return manifest;
}

// ---------------------------------------------------------------------------
// Public types (runGenesis legacy API)
// ---------------------------------------------------------------------------

/** Options accepted by {@link runGenesis}. */
export interface GenesisOptions {
  /** Project root directory to scan. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Force interactive interview mode even when project files exist. */
  interview?: boolean;
  /**
   * Manually specify domain IDs (e.g. ["software", "business"]).
   * When provided, skips auto-detection of domains.
   */
  domains?: DomainId[];
  /**
   * Interview answers to inject (used for testing / non-interactive callers).
   * Keys correspond to interview question IDs.
   */
  answers?: Record<string, string>;
}

/** Result returned by {@link runGenesis}. */
export interface GenesisResult {
  /** The composed team manifest. */
  manifest: TeamManifest;
  /** The project brief used to compose the team. */
  brief: ProjectBrief;
  /** Domain IDs that were activated for this team. */
  domains: DomainId[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the Genesis workflow.
 *
 * Scans the project directory, optionally runs the interview, builds a
 * {@link ProjectBrief}, and forges a team from it.  Returns the manifest
 * plus the brief so callers can display the proposed team.
 */
export async function runGenesis(options: GenesisOptions = {}): Promise<GenesisResult> {
  const projectRoot = options.projectRoot ?? process.cwd();

  // 1. Scan the project (always — even in interview mode we want context)
  let scan;
  try {
    scan = await runFullScan(projectRoot);
  } catch {
    // Non-fatal: a brand-new empty project may not have scannable files
    scan = undefined;
  }

  // 2. Load domain packs and templates
  const domainsDir = getDefaultDomainsDir();
  let domainPacks = new Map<DomainId, import("../types/domain.js").DomainPack>();
  try {
    domainPacks = await loadAllDomains(domainsDir);
  } catch {
    // No domain packs found — proceed with empty map.
  }

  let templates = new Map<
    DomainId,
    Map<string, import("../types/agent.js").AgentTemplate>
  >();
  try {
    templates = await loadDomainTemplates(domainsDir);
  } catch {
    // No templates available — designTeam still works with empty map.
  }

  // 3. Determine domains
  let domains: DomainId[];
  if (options.domains && options.domains.length > 0) {
    // Caller supplied explicit domains; ensure 'core' is always present
    const domainSet = new Set<DomainId>(["core", ...options.domains]);
    domains = [...domainSet].sort();
  } else {
    // Auto-detect from brief builder (same heuristics as inferDomains)
    const tempBrief = buildBrief({ scan, answers: options.answers });
    domains = tempBrief.domains;
  }

  // 4. Build the project brief
  const brief = buildBrief({
    scan,
    answers: options.answers,
  });

  // Override domains in brief when manually specified
  if (options.domains && options.domains.length > 0) {
    brief.domains = domains;
  }

  // 5. Design the team using designTeam (uses scan data assembled above)
  const manifest = designTeam(brief, domains, domainPacks, templates);

  // 6. Customize templates and write the team
  if (scan) {
    const customizedAgents = new Map<string, import("../types/agent.js").AgentTemplate>();

    // Collect all agent templates from domain templates
    for (const domainTemplates of templates.values()) {
      for (const [agentName, template] of domainTemplates) {
        customizedAgents.set(agentName, template);
      }
    }

    // Customize each agent template with project-specific context
    for (const agentName of [
      ...manifest.agents.strategic,
      ...manifest.agents.implementation,
      ...manifest.agents.quality,
      ...manifest.agents.utility,
    ]) {
      const template = customizedAgents.get(agentName);
      if (template) {
        customizedAgents.set(
          agentName,
          customizeTemplate(template, scan, brief.project.name),
        );
      }
    }

    // Write the team to .agentforge/
    await writeTeam(projectRoot, manifest, customizedAgents, scan);
  }

  // 7. Return the manifest with genesis fields attached
  manifest.project_brief = brief;

  return { manifest, brief, domains };
}
