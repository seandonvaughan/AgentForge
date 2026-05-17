/**
 * Agent-driven forge orchestrator.
 *
 * Wires the four phases of the new forge pipeline:
 *   Phase A: 5 parallel recon agents emit structured JSON
 *   Phase B: Opus synthesis writes every agent's system prompt
 *   Phase C: deterministic validator fact-checks generated agents
 *   Phase D: capability-tag routing index is built from the new agents
 *
 * This is OPT-IN. The existing deterministic `forgeTeam()` remains the
 * default; agent-driven forge is enabled by supplying a `runtime`.
 *
 * See `docs/superpowers/specs/2026-05-17-agent-driven-forge.md`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentRuntime } from "../../../agent-runtime/agent-runtime.js";
import {
  runReconAgent,
  type AgentRuntime as ReconAgentRuntime,
} from "./recon/recon-runner.js";
import type { ReconAgentId } from "./recon/types.js";
import type {
  SubsystemsReport,
  DependenciesReport,
  ConventionsReport,
  DomainReport,
  HistoryReport,
} from "./recon/schemas.js";
import { synthesizeTeam, type TeamPlan } from "./synthesis.js";
import { validateTeam, type ValidationReport } from "./validator.js";
import { buildRoutingIndex } from "../../../autonomous/routing/routing-index.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AgentDrivenForgeOptions {
  /** Absolute path to the project being forged. */
  projectRoot: string;
  /** Injected runtime — production wires this to ExecutionService. */
  runtime: AgentRuntime;
  /**
   * Representative source files for synthesis input. Caller chooses how to
   * pick these (e.g. top-N largest files per subsystem). Each entry's
   * `content` should be a slice, not necessarily the full file.
   */
  sourceCorpus: Array<{ path: string; content: string }>;
  /**
   * Optional override for the recon model tier. When provided, ALL recon
   * agents use this model regardless of their default. Useful for
   * cost-sensitive runs (`'haiku'`) or quality-sensitive runs (`'sonnet'`).
   */
  reconModel?: "sonnet" | "haiku";
  /**
   * Optional model for synthesis. Defaults to `"opus"` (recommended). Use
   * `"sonnet"` only for testing or extreme cost sensitivity — quality drops.
   */
  synthesisModel?: "opus" | "sonnet";
}

export interface AgentDrivenForgeResult {
  /** The full team plan produced by Opus synthesis. */
  teamPlan: TeamPlan;
  /** Phase C validation report. May contain WARN-level findings. */
  validation: ValidationReport;
  /** Path to the routing index built from the new team. */
  routingIndexPath: string;
}

/**
 * Run the full agent-driven forge pipeline.
 *
 * 1. Phase A — run all 5 recon agents in parallel.
 * 2. Phase B — call synthesis to write every agent's system prompt.
 * 3. Phase C — run deterministic validation against the generated team.
 * 4. Phase D — build the capability-tag routing index.
 *
 * Returns the plan, validation report, and the routing-index path.
 *
 * Throws on Phase A or Phase B failures; Phase C warnings are returned in
 * the result for the caller to decide what to do with them.
 */
export async function forgeTeamAgentDriven(
  opts: AgentDrivenForgeOptions,
): Promise<AgentDrivenForgeResult> {
  const { projectRoot, runtime, sourceCorpus } = opts;

  // ── Phase A — parallel recon ────────────────────────────────────────
  const reconRuntime = adaptToReconRuntime(runtime);
  const reconResults = await runAllReconAgents({
    projectRoot,
    runtime: reconRuntime,
    sourceCorpus,
    overrideModel: opts.reconModel,
  });

  // ── Phase B — Opus synthesis ────────────────────────────────────────
  const teamPlan = await synthesizeTeam({
    reconResults,
    sourceCorpus,
    projectRoot,
    runtime,
    ...(opts.synthesisModel ? { model: opts.synthesisModel } : {}),
  });

  // ── Phase C — deterministic validation ──────────────────────────────
  const validation = await validateTeam({ projectRoot });

  // ── Phase D — routing index ─────────────────────────────────────────
  const agentsDir = join(projectRoot, ".agentforge", "agents");
  const teamPath = join(projectRoot, ".agentforge", "team.yaml");
  const routingIndexPath = join(projectRoot, ".agentforge", "routing-index.json");
  buildRoutingIndex({ agentsDir, teamPath, outputPath: routingIndexPath });

  return { teamPlan, validation, routingIndexPath };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunAllReconAgentsOpts {
  projectRoot: string;
  runtime: ReconAgentRuntime;
  sourceCorpus: Array<{ path: string; content: string }>;
  overrideModel?: "sonnet" | "haiku" | undefined;
}

interface ReconResults {
  subsystems: SubsystemsReport;
  dependencies: DependenciesReport;
  conventions: ConventionsReport;
  domain: DomainReport;
  history: HistoryReport;
}

const RECON_AGENT_IDS: readonly ReconAgentId[] = [
  "code-archaeologist",
  "dep-graph-analyst",
  "convention-detective",
  "domain-mapper",
  "failure-historian",
];

/**
 * Adapt the canonical `AgentRuntime` (used by synthesis) to the lightweight
 * `ReconAgentRuntime` shape expected by recon-runner. The recon-runner only
 * uses `run(agentId, task, opts?)` and only reads `.response` from the
 * result — both are structurally satisfied by the canonical runtime.
 */
function adaptToReconRuntime(runtime: AgentRuntime): ReconAgentRuntime {
  return {
    async run(_agentId, task, opts) {
      const result = await runtime.run({
        task,
        ...(opts?.systemPrompt ? { context: opts.systemPrompt } : {}),
      });
      return { ...result, response: result.response };
    },
  };
}

/** Run all 5 recon agents in parallel; surface the first failure. */
async function runAllReconAgents(
  opts: RunAllReconAgentsOpts,
): Promise<ReconResults> {
  const results = await Promise.all(
    RECON_AGENT_IDS.map((agentId) => runSingleReconAgent(agentId, opts)),
  );

  return {
    subsystems: results[0] as SubsystemsReport,
    dependencies: results[1] as DependenciesReport,
    conventions: results[2] as ConventionsReport,
    domain: results[3] as DomainReport,
    history: results[4] as HistoryReport,
  };
}

/** Load the prompt file for a recon agent and invoke the runner. */
async function runSingleReconAgent(
  agentId: ReconAgentId,
  opts: RunAllReconAgentsOpts,
): Promise<unknown> {
  const prompt = await loadReconPrompt(agentId);
  return runReconAgent({
    agentId,
    prompt,
    inputs: {
      projectRoot: opts.projectRoot,
      sourceCorpus: opts.sourceCorpus,
    },
    runtime: opts.runtime,
    projectRoot: opts.projectRoot,
    ...(opts.overrideModel ? { model: opts.overrideModel } : {}),
  });
}

/**
 * Load a recon agent's system prompt from disk.
 *
 * Resolved relative to this file's URL so the lookup works regardless of
 * whether the package is consumed from `src/` or `dist/`.
 */
async function loadReconPrompt(agentId: ReconAgentId): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const selfDir = dirname(fileURLToPath(import.meta.url));
  const promptPath = join(selfDir, "recon", "prompts", `${agentId}.md`);
  return readFile(promptPath, "utf-8");
}
