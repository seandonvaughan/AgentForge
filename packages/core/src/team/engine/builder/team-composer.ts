// @ts-nocheck
/**
 * Team Composer — decides which agents to include based on scan results.
 *
 * Analyzes a {@link FullScanResult} and produces a {@link TeamComposition}
 * that lists required agents, custom specialists, and model assignments.
 */

import type { ModelTier } from "../types/agent.js";
import type { FullScanResult } from "../scanner/index.js";
import type { DomainPack, DomainId } from "../types/domain.js";
import type { TeamUnit, TechnicalLayer, SeniorityLevel } from "../types/lifecycle.js";
import { SENIORITY_CONFIG } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Description of a custom agent to be generated for a project. */
export interface CustomAgentSpec {
  /** Agent name (kebab-case). */
  name: string;
  /** Name of the base template to derive from. */
  base_template: string;
  /** Human-readable explanation of why this agent was added. */
  reason: string;
}

/** The result of team composition: which agents, custom agents, and models. */
export interface TeamComposition {
  /** Names of standard agents to include (keys into the template map). */
  agents: string[];
  /** Custom agents that should be generated for project-specific needs. */
  custom_agents: CustomAgentSpec[];
  /** Model tier assignment for each agent (keyed by agent name). */
  model_assignments: Record<string, ModelTier>;
  /** Team units organized by technical layer (v6.1+). */
  team_units?: TeamUnit[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Agents that are always included in every team. */
const CORE_AGENTS = [
  "architect",
  "coder",
  "researcher",
  "file-reader",
  "linter",
] as const;

/** Default model assignments from the standard templates. */
const DEFAULT_MODELS: Record<string, ModelTier> = {
  architect: "opus",
  coder: "sonnet",
  researcher: "sonnet",
  "file-reader": "haiku",
  linter: "haiku",
  "security-auditor": "sonnet",
  "test-engineer": "sonnet",
  "test-runner": "haiku",
  "devops-engineer": "sonnet",
  "documentation-writer": "sonnet",
};

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** Check whether the dependency list has categories that signal security risk. */
function hasSecurityRiskDependencies(scan: FullScanResult): boolean {
  const riskyCategories = new Set(["auth", "database", "framework"]);
  return scan.dependencies.dependencies.some((d) =>
    riskyCategories.has(d.category),
  );
}

/** Detect custom auth patterns in the scanned files. */
function hasCustomAuth(scan: FullScanResult): boolean {
  const authIndicators = [
    "jwt",
    "oauth",
    "passport",
    "auth",
    "session",
    "token",
    "bcrypt",
  ];
  return scan.files.files.some((f) =>
    authIndicators.some(
      (indicator) =>
        f.file_path.toLowerCase().includes(indicator) ||
        f.imports.some((imp) => imp.toLowerCase().includes(indicator)),
    ),
  );
}

/** Check whether test frameworks are detected or coverage gaps exist. */
function needsTestEngineer(scan: FullScanResult): boolean {
  if (scan.dependencies.test_frameworks.length > 0) return true;
  // Look for existing test files as evidence that testing is in use
  const hasTestFiles = scan.files.files.some(
    (f) =>
      f.file_path.includes(".test.") ||
      f.file_path.includes(".spec.") ||
      f.file_path.includes("__tests__") ||
      f.file_path.includes("test/") ||
      f.file_path.includes("tests/"),
  );
  return hasTestFiles;
}

/** Detect heavy API surface (many route/handler/controller files). */
function hasHeavyAPISurface(scan: FullScanResult): boolean {
  const apiIndicators = [
    "controller",
    "handler",
    "route",
    "endpoint",
    "api/",
    "routes/",
    "controllers/",
    "handlers/",
  ];
  const apiFileCount = scan.files.files.filter((f) =>
    apiIndicators.some((ind) => f.file_path.toLowerCase().includes(ind)),
  ).length;
  return apiFileCount >= 5;
}

/** Detect database-heavy projects. */
function isDatabaseHeavy(scan: FullScanResult): boolean {
  const dbDeps = scan.dependencies.dependencies.filter(
    (d) => d.category === "database",
  );
  if (dbDeps.length >= 2) return true;

  const dbIndicators = [
    "migration",
    "model",
    "schema",
    "entity",
    "repository",
    "prisma",
    "sequelize",
    "typeorm",
    "drizzle",
  ];
  const dbFileCount = scan.files.files.filter((f) =>
    dbIndicators.some((ind) => f.file_path.toLowerCase().includes(ind)),
  ).length;
  return dbFileCount >= 3;
}

/** Detect ML/AI patterns. */
function hasMLPatterns(scan: FullScanResult): boolean {
  const mlImports = [
    "tensorflow",
    "torch",
    "pytorch",
    "keras",
    "sklearn",
    "scikit-learn",
    "transformers",
    "huggingface",
    "numpy",
    "pandas",
    "scipy",
    "xgboost",
    "lightgbm",
    "mlflow",
    "wandb",
    "openai",
    "@anthropic-ai",
  ];
  return scan.files.files.some((f) =>
    f.imports.some((imp) =>
      mlImports.some((ml) => imp.toLowerCase().includes(ml)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compose a team by merging agents from all active domain packs.
 *
 * Collects agents declared in every active domain pack, deduplicates them,
 * applies scan-based conditional logic (custom agent generation), and
 * assigns model tiers.
 *
 * @param scan - Full scan result from all scanners.
 * @param activeDomains - Domain IDs that have been activated for this project.
 * @param domainPacks - All available domain packs (keyed by DomainId).
 * @returns A {@link TeamComposition} with merged, deduplicated agent list.
 */
export function composeTeamFromDomains(
  scan: FullScanResult,
  activeDomains: DomainId[],
  domainPacks: Map<DomainId, DomainPack>,
): TeamComposition {
  const agentSet = new Set<string>();
  const custom_agents: CustomAgentSpec[] = [];
  const model_assignments: Record<string, ModelTier> = {};

  // ── Merge agents from all active domain packs ──────────────────────────

  for (const domainId of activeDomains) {
    const pack = domainPacks.get(domainId);
    if (!pack) continue;

    for (const category of ["strategic", "implementation", "quality", "utility"] as const) {
      for (const agent of pack.agents[category]) {
        agentSet.add(agent);
      }
    }
  }

  // ── Conditional standard agents (scan-driven, additive) ────────────────

  // Security Auditor: vuln-risk deps, custom auth, or large project
  if (
    hasSecurityRiskDependencies(scan) ||
    hasCustomAuth(scan) ||
    scan.files.total_files > 20
  ) {
    agentSet.add("security-auditor");
  }

  // Test Engineer: test frameworks detected or coverage gaps
  if (needsTestEngineer(scan)) {
    agentSet.add("test-engineer");
  }

  // DevOps Engineer: CI config exists or Docker detected
  if (scan.ci.ci_provider !== "none" || scan.ci.has_docker) {
    agentSet.add("devops-engineer");
  }

  // Documentation Writer: large project or multiple languages
  const languageCount = Object.keys(scan.files.languages).length;
  if (scan.files.total_files > 50 || languageCount > 1) {
    agentSet.add("documentation-writer");
  }

  // Test Runner: included when test-engineer is present
  if (agentSet.has("test-engineer")) {
    agentSet.add("test-runner");
  }

  // ── Custom agents (scan-driven) ────────────────────────────────────────

  if (hasHeavyAPISurface(scan)) {
    custom_agents.push({
      name: "api-specialist",
      base_template: "coder",
      reason:
        "Project has a heavy API surface with many route/controller files.",
    });
  }

  if (isDatabaseHeavy(scan)) {
    custom_agents.push({
      name: "db-specialist",
      base_template: "coder",
      reason:
        "Project relies heavily on databases with multiple ORM/migration patterns.",
    });
  }

  if (hasMLPatterns(scan)) {
    custom_agents.push({
      name: "ml-engineer",
      base_template: "coder",
      reason:
        "Project contains ML/AI libraries and patterns requiring specialized knowledge.",
    });
  }

  // ── Model assignments ──────────────────────────────────────────────────

  const agents = [...agentSet];

  for (const agent of agents) {
    model_assignments[agent] = DEFAULT_MODELS[agent] ?? "sonnet";
  }
  for (const custom of custom_agents) {
    model_assignments[custom.name] = "sonnet";
  }

  return { agents, custom_agents, model_assignments };
}

/**
 * Analyze scan results and decide which agents to include in the team.
 *
 * This is the original v1 API. It uses the core agent list directly
 * (without domain packs) for backward compatibility.
 *
 * @deprecated Prefer {@link composeTeamFromDomains} for domain-aware composition.
 */
export function composeTeam(scan: FullScanResult): TeamComposition {
  const agents: string[] = [...CORE_AGENTS];
  const custom_agents: CustomAgentSpec[] = [];
  const model_assignments: Record<string, ModelTier> = {};

  // ── Conditional standard agents ────────────────────────────────────────

  // Security Auditor: vuln-risk deps, custom auth, or large project
  if (
    hasSecurityRiskDependencies(scan) ||
    hasCustomAuth(scan) ||
    scan.files.total_files > 20
  ) {
    agents.push("security-auditor");
  }

  // Test Engineer: test frameworks detected or coverage gaps
  if (needsTestEngineer(scan)) {
    agents.push("test-engineer");
  }

  // DevOps Engineer: CI config exists or Docker detected
  if (scan.ci.ci_provider !== "none" || scan.ci.has_docker) {
    agents.push("devops-engineer");
  }

  // Documentation Writer: large project or multiple languages
  const languageCount = Object.keys(scan.files.languages).length;
  if (scan.files.total_files > 50 || languageCount > 1) {
    agents.push("documentation-writer");
  }

  // Test Runner: included when test-engineer is present
  if (agents.includes("test-engineer")) {
    agents.push("test-runner");
  }

  // ── Custom agents ──────────────────────────────────────────────────────

  if (hasHeavyAPISurface(scan)) {
    custom_agents.push({
      name: "api-specialist",
      base_template: "coder",
      reason:
        "Project has a heavy API surface with many route/controller files.",
    });
  }

  if (isDatabaseHeavy(scan)) {
    custom_agents.push({
      name: "db-specialist",
      base_template: "coder",
      reason:
        "Project relies heavily on databases with multiple ORM/migration patterns.",
    });
  }

  if (hasMLPatterns(scan)) {
    custom_agents.push({
      name: "ml-engineer",
      base_template: "coder",
      reason:
        "Project contains ML/AI libraries and patterns requiring specialized knowledge.",
    });
  }

  // ── Model assignments ──────────────────────────────────────────────────

  for (const agent of agents) {
    model_assignments[agent] = DEFAULT_MODELS[agent] ?? "sonnet";
  }
  for (const custom of custom_agents) {
    // Custom specialists get sonnet by default
    model_assignments[custom.name] = "sonnet";
  }

  return { agents, custom_agents, model_assignments };
}

// ---------------------------------------------------------------------------
// v6.1 — Team Unit Composition
// ---------------------------------------------------------------------------

/** Layer detection indicators. */
const LAYER_INDICATORS: Record<TechnicalLayer, string[]> = {
  frontend: ["component", "page", "layout", "view", "ui", "css", "style", "react", "vue", "svelte", "angular"],
  backend: ["controller", "handler", "route", "service", "middleware", "api", "server", "endpoint"],
  infra: ["ci", "docker", "deploy", "pipeline", "terraform", "ansible", "k8s", "helm", "github/workflows"],
  data: ["migration", "model", "schema", "entity", "repository", "prisma", "sequelize", "typeorm", "drizzle"],
  platform: ["plugin", "sdk", "extension", "provider", "adapter", "connector"],
  qa: ["test", "spec", "__tests__", "e2e", "integration", "fixture", "mock"],
  research: [],
  executive: [],
};

/**
 * Determine which technical layers are active based on scan results.
 */
function detectActiveLayers(scan: FullScanResult): TechnicalLayer[] {
  const layers = new Set<TechnicalLayer>();
  layers.add("executive");
  layers.add("qa");

  for (const file of scan.files.files) {
    const path = file.file_path.toLowerCase();
    for (const [layer, indicators] of Object.entries(LAYER_INDICATORS) as [TechnicalLayer, string[]][]) {
      if (indicators.some((ind) => path.includes(ind))) {
        layers.add(layer);
      }
    }
  }

  if (scan.files.total_files > 0) layers.add("backend");
  if (scan.ci.ci_provider !== "none" || scan.ci.has_docker) layers.add("infra");
  if (isDatabaseHeavy(scan)) layers.add("data");

  return [...layers];
}

/** Infer an agent's seniority from its name and model tier. */
function inferSeniority(agentName: string, model: ModelTier): SeniorityLevel {
  const name = agentName.toLowerCase();
  if (["ceo", "cto", "coo", "cfo"].includes(name)) return "principal";
  if (name.includes("vp-") || name.includes("lead")) return "lead";
  if (name.includes("manager")) return "lead";
  if (name.includes("architect") || name.includes("tech-lead")) return "lead";
  if (model === "opus") return "senior";
  if (model === "haiku") return "junior";
  return "mid";
}

/** Infer which layer an agent belongs to based on its name. */
function inferLayer(agentName: string): TechnicalLayer {
  const name = agentName.toLowerCase();
  if (["ceo", "cto", "coo", "cfo"].some((e) => name === e) || name.startsWith("vp-")) return "executive";
  if (["frontend", "ui", "ux", "dashboard", "component"].some((f) => name.includes(f))) return "frontend";
  if (["devops", "ci-", "security", "platform-engineer", "infra"].some((i) => name.includes(i))) return "infra";
  if (["dba", "db-", "data-pipeline", "migration", "embedding"].some((d) => name.includes(d))) return "data";
  if (["test", "qa", "linter", "reviewer", "quality"].some((q) => name.includes(q))) return "qa";
  if (["research", "ml-engineer", "scientist"].some((r) => name.includes(r))) return "research";
  if (["plugin", "sdk"].some((p) => name.includes(p))) return "platform";
  return "backend";
}

/**
 * Compose team units organized by technical layer.
 *
 * Produces TeamUnit[] from a TeamComposition, assigning agents to layers
 * with manager, tech lead, and specialist roles.
 */
export function composeTeamUnits(
  composition: TeamComposition,
  scan: FullScanResult,
): TeamUnit[] {
  const activeLayers = detectActiveLayers(scan);
  const agentsByLayer = new Map<TechnicalLayer, Array<{ name: string; seniority: SeniorityLevel; model: ModelTier }>>();

  for (const layer of activeLayers) agentsByLayer.set(layer, []);

  const allAgents = [
    ...composition.agents,
    ...composition.custom_agents.map((c) => c.name),
  ];

  for (const agentName of allAgents) {
    const model = composition.model_assignments[agentName] ?? "sonnet";
    const layer = inferLayer(agentName);
    const seniority = inferSeniority(agentName, model);
    const targetLayer = agentsByLayer.has(layer) ? layer : "backend";
    agentsByLayer.get(targetLayer)?.push({ name: agentName, seniority, model });
  }

  const units: TeamUnit[] = [];
  const seniorityOrder: SeniorityLevel[] = ["principal", "lead", "senior", "mid", "junior"];

  for (const [layer, agents] of agentsByLayer) {
    if (agents.length === 0) continue;
    agents.sort((a, b) => seniorityOrder.indexOf(a.seniority) - seniorityOrder.indexOf(b.seniority));

    const manager = agents.find((a) => a.seniority === "principal" || a.seniority === "lead")?.name ?? agents[0].name;
    const techLead = agents.find((a) => a.name !== manager && (a.seniority === "lead" || a.seniority === "senior"))?.name
      ?? (agents.length > 1 ? agents[1].name : manager);
    const specialists = agents.filter((a) => a.name !== manager && a.name !== techLead).map((a) => a.name);
    const defaultCapacity = layer === "executive" ? 6 : 10;

    units.push({
      id: `${layer}-team`,
      layer,
      manager,
      techLead,
      specialists,
      maxCapacity: Math.max(defaultCapacity, specialists.length + 2),
      currentLoad: 0,
      domain: LAYER_INDICATORS[layer]?.slice(0, 5) ?? [],
    });
  }

  return units;
}
