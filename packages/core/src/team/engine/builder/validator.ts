/**
 * Team Plan Validator - Phase C of the agent-driven forge pipeline.
 *
 * Reads `.agentforge/forge/team-plan.json` (output of Phase B synthesis) and
 * runs five deterministic checks against the project root. No LLM calls.
 *
 * Writes `.agentforge/forge/validation-report.json` and returns a
 * ValidationReport. Never throws; errors are surfaced as findings.
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ValidationSeverity = "ERROR" | "WARN";

export interface AgentFinding {
  /** The agent id this finding belongs to. */
  agentId: string;
  /** Which check produced this finding. */
  check:
    | "auto_include_files"
    | "owns_subsystems"
    | "system_prompt_paths"
    | "domain_contradiction"
    | "duplicate_prompt";
  severity: ValidationSeverity;
  message: string;
}

export interface ValidationReport {
  /** True only when no ERROR-severity findings exist. */
  valid: boolean;
  /** Total number of agents evaluated. */
  agentsChecked: number;
  /** All findings (errors + warnings) keyed by agent. */
  findings: AgentFinding[];
  /** ISO timestamp of when this report was generated. */
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Internal team-plan types (matches Phase B synthesis output shape)
// ---------------------------------------------------------------------------

interface TeamPlanAgent {
  id: string;
  tier?: string;
  owns_subsystems?: string[];
  system_prompt?: string;
  capability_tags?: string[];
  auto_include_files?: string[];
  learnings_seed?: string[];
  description?: string;
}

interface TeamPlan {
  team_name?: string;
  agents: TeamPlanAgent[];
  /** Optional domain report embedded by synthesis for cross-checks. */
  domain_report?: {
    keywords?: string[];
    tech_stack?: string[];
  };
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

/** Regex that matches path-like strings beginning with common project prefixes. */
const PATH_HEURISTIC_RE =
  /(?:^|\s)((?:packages|src|tests|test|lib|apps|dist|scripts)\/[^\s"'`,]+)/gm;

/**
 * Extract heuristic file-path references from a system prompt string.
 * Returns deduplicated list of path strings that look like real paths.
 */
function extractPathRefs(prompt: string): string[] {
  const found = new Set<string>();
  for (const match of prompt.matchAll(PATH_HEURISTIC_RE)) {
    const captured = match[1];
    if (captured) found.add(captured);
  }
  return [...found];
}

/** Return true if the path resolves to a real file or directory. */
async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check (a): every auto_include_files path exists under projectRoot.
 */
async function checkAutoIncludeFiles(
  agent: TeamPlanAgent,
  projectRoot: string,
): Promise<AgentFinding[]> {
  const findings: AgentFinding[] = [];
  for (const rel of agent.auto_include_files ?? []) {
    const abs = resolve(projectRoot, rel);
    if (!(await pathExists(abs))) {
      findings.push({
        agentId: agent.id,
        check: "auto_include_files",
        severity: "ERROR",
        message: `auto_include_files path does not exist: "${rel}"`,
      });
    }
  }
  return findings;
}

/**
 * Check (b): every owns_subsystems entry resolves to a real directory (or
 * at least a path that exists under projectRoot).
 */
async function checkOwnsSubsystems(
  agent: TeamPlanAgent,
  projectRoot: string,
): Promise<AgentFinding[]> {
  const findings: AgentFinding[] = [];
  for (const sub of agent.owns_subsystems ?? []) {
    const abs = resolve(projectRoot, sub);
    if (!(await pathExists(abs))) {
      findings.push({
        agentId: agent.id,
        check: "owns_subsystems",
        severity: "ERROR",
        message: `owns_subsystems path does not exist: "${sub}"`,
      });
    }
  }
  return findings;
}

/**
 * Check (c): file-path references inside system_prompt resolve to real files.
 * Heuristic: strings matching `packages/...`, `src/...`, `tests/...` patterns.
 */
async function checkSystemPromptPaths(
  agent: TeamPlanAgent,
  projectRoot: string,
): Promise<AgentFinding[]> {
  const findings: AgentFinding[] = [];
  if (!agent.system_prompt) return findings;
  const refs = extractPathRefs(agent.system_prompt);
  for (const ref of refs) {
    const abs = resolve(projectRoot, ref);
    if (!(await pathExists(abs))) {
      findings.push({
        agentId: agent.id,
        check: "system_prompt_paths",
        severity: "WARN",
        message: `system_prompt references a path that does not exist: "${ref}"`,
      });
    }
  }
  return findings;
}

/**
 * Check (d): description doesn't mention technology keywords absent from the
 * domain report. Simple keyword intersection - no NLP.
 */
function checkDomainContradiction(
  agent: TeamPlanAgent,
  domainKeywords: string[],
): AgentFinding[] {
  if (!agent.description || domainKeywords.length === 0) return [];

  const TECH_TERMS = [
    "python",
    "django",
    "flask",
    "fastapi",
    "ruby",
    "rails",
    "php",
    "laravel",
    "java",
    "spring",
    "kotlin",
    "swift",
    "rust",
    "golang",
    "go",
    "c++",
    "cpp",
    "c#",
    "dotnet",
    ".net",
    "perl",
    "scala",
    "clojure",
    "haskell",
    "elixir",
    "erlang",
    "lua",
    "r language",
    "matlab",
    "julia",
  ];

  const lowerDesc = agent.description.toLowerCase();
  const lowerDomain = domainKeywords.map((k) => k.toLowerCase()).join(" ");

  const findings: AgentFinding[] = [];
  for (const term of TECH_TERMS) {
    if (lowerDesc.includes(term) && !lowerDomain.includes(term)) {
      findings.push({
        agentId: agent.id,
        check: "domain_contradiction",
        severity: "WARN",
        message: `description mentions "${term}" but the domain report does not - possible hallucination`,
      });
    }
  }
  return findings;
}

/**
 * Check (e): system_prompt is not byte-identical to another agent in the roster.
 * Returns findings for the *second* (and subsequent) agents with a duplicate prompt.
 */
function checkDuplicatePrompts(agents: TeamPlanAgent[]): AgentFinding[] {
  const seen = new Map<string, string>();
  const findings: AgentFinding[] = [];
  for (const agent of agents) {
    const prompt = agent.system_prompt ?? "";
    if (!prompt) continue;
    const prior = seen.get(prompt);
    if (prior !== undefined) {
      findings.push({
        agentId: agent.id,
        check: "duplicate_prompt",
        severity: "ERROR",
        message: `system_prompt is byte-identical to agent "${prior}" - no real specialization`,
      });
    } else {
      seen.set(prompt, agent.id);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ValidateTeamOptions {
  /**
   * Absolute path to the `.agentforge/forge/team-plan.json` file.
   * Defaults to `<projectRoot>/.agentforge/forge/team-plan.json`.
   */
  teamPlanPath?: string;
  /** Absolute path to the project root (used to resolve relative paths). */
  projectRoot: string;
}

/**
 * Run all five deterministic checks against a team-plan.json file.
 *
 * Writes `.agentforge/forge/validation-report.json` under projectRoot and
 * returns the same report as the function return value.
 *
 * Never throws - any fatal read/parse error is captured as a top-level finding
 * on a synthetic `__meta__` agent.
 */
export async function validateTeam(
  opts: ValidateTeamOptions,
): Promise<ValidationReport> {
  const { projectRoot } = opts;
  const teamPlanPath =
    opts.teamPlanPath ??
    join(projectRoot, ".agentforge", "forge", "team-plan.json");

  const allFindings: AgentFinding[] = [];

  let plan: TeamPlan;
  try {
    const raw = await readFile(teamPlanPath, "utf8");
    plan = JSON.parse(raw) as TeamPlan;
  } catch (err) {
    allFindings.push({
      agentId: "__meta__",
      check: "auto_include_files",
      severity: "ERROR",
      message: `Cannot read or parse team-plan.json at "${teamPlanPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return buildReport(allFindings, 0, projectRoot);
  }

  const agents: TeamPlanAgent[] = Array.isArray(plan.agents) ? plan.agents : [];
  const domainKeywords: string[] = [
    ...(plan.domain_report?.keywords ?? []),
    ...(plan.domain_report?.tech_stack ?? []),
  ];

  for (const agent of agents) {
    const [autoInclude, subsystems, promptPaths, domain] = await Promise.all([
      checkAutoIncludeFiles(agent, projectRoot),
      checkOwnsSubsystems(agent, projectRoot),
      checkSystemPromptPaths(agent, projectRoot),
      Promise.resolve(checkDomainContradiction(agent, domainKeywords)),
    ]);
    allFindings.push(...autoInclude, ...subsystems, ...promptPaths, ...domain);
  }

  allFindings.push(...checkDuplicatePrompts(agents));

  return buildReport(allFindings, agents.length, projectRoot);
}

async function buildReport(
  findings: AgentFinding[],
  agentsChecked: number,
  projectRoot: string,
): Promise<ValidationReport> {
  const report: ValidationReport = {
    valid: !findings.some((f) => f.severity === "ERROR"),
    agentsChecked,
    findings,
    generatedAt: new Date().toISOString(),
  };

  try {
    const forgeDir = join(projectRoot, ".agentforge", "forge");
    await mkdir(forgeDir, { recursive: true });
    await writeFile(
      join(forgeDir, "validation-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
  } catch {
    // Best-effort write; non-fatal
  }

  return report;
}
