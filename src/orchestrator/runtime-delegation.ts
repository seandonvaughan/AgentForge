/**
 * RuntimeDelegationPipeline — AgentForge v6.0 P0-3
 *
 * Runs the agent delegation chain via real Anthropic API calls.
 *
 * Each step in the chain is a genuine AgentRuntime invocation:
 *   1. CTO agent    — groups sprint items by technical domain
 *   2. VP Engineering agent — distributes domain groups to specific agents
 *
 * The pipeline produces a full DelegationChainResult including:
 *   - per-step records with from/to/rationale
 *   - a final assignments map (agentId → itemIds)
 *   - any items that could not be assigned
 *
 * Export:
 *   runDelegationChain(items, agentsDir, onEvent?) → Promise<DelegationChainResult>
 */

import { AgentRuntime, loadAgentConfig } from "../../packages/core/src/agent-runtime/index.js";
import type { SprintItem, DelegationStep } from "./auto-delegation.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Event emitted during the chain for real-time progress tracking. */
export interface DelegationChainEvent {
  type: "step_start" | "step_done" | "chunk" | "error";
  agentId: string;
  message: string;
  data?: unknown;
}

/** Result of the full runtime delegation chain. */
export interface DelegationChainResult {
  steps: DelegationStep[];
  /** agentId → list of item IDs assigned to that agent. */
  assignments: Map<string, string[]>;
  /** Item IDs that could not be assigned to any agent. */
  unassigned: string[];
  /** Total cost of all LLM calls during the chain. */
  totalCostUsd: number;
  /** ISO timestamp when the chain completed. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pattern that finds a JSON code fence or bare JSON object in a response. */
const JSON_FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

/**
 * Attempt to extract the first JSON object from an agent response.
 * Tries a fenced code block first, then a bare {...} in the text.
 * Returns null when nothing parseable is found.
 */
function extractJson(text: string): unknown {
  // Try fenced block first
  const fenceMatch = JSON_FENCE_RE.exec(text);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try to find first { and last } and parse what's in between
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

/** Build a DelegationStep record. */
function makeStep(
  from: string,
  to: string,
  itemId: string,
  action: string,
  rationale: string,
): DelegationStep {
  return { from, to, itemId, action, rationale, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Phase 1 — CTO Planning
// ---------------------------------------------------------------------------

/** Shape of the JSON the CTO agent should return. */
interface CtoPlanJson {
  domains: Record<string, string[]>; // domain → itemIds[]
}

async function runCtoPlanningPhase(
  items: SprintItem[],
  agentsDir: string,
  onEvent?: (e: DelegationChainEvent) => void,
): Promise<{ plan: CtoPlanJson; steps: DelegationStep[]; costUsd: number }> {
  const agentId = "cto";
  const config = await loadAgentConfig(agentId, agentsDir);
  if (!config) {
    throw new Error(`Agent config not found for "${agentId}" in ${agentsDir}`);
  }
  config.workspaceId = "delegation";

  const itemList = items
    .map((i) => `- [${i.id}] (${i.priority}) ${i.title}: ${i.description}`)
    .join("\n");

  const task =
    `You are the CTO. Create a technical plan for these sprint items:\n\n${itemList}\n\n` +
    `Group them by technical domain. Valid domains: frontend, backend, infra, data, qa, platform, research.\n\n` +
    `Output ONLY valid JSON (no prose, no markdown fences) in exactly this shape:\n` +
    `{ "domains": { "<domain>": ["<itemId>", ...], ... } }`;

  onEvent?.({ type: "step_start", agentId, message: "CTO planning phase started" });

  const runtime = new AgentRuntime(config);
  const result = await runtime.runStreaming({
    task,
    onEvent: (e) => {
      if (e.type === "chunk") {
        onEvent?.({ type: "chunk", agentId, message: "cto chunk", data: e.data });
      }
    },
  });

  onEvent?.({ type: "step_done", agentId, message: "CTO planning phase done", data: { costUsd: result.costUsd } });

  if (result.status === "failed") {
    throw new Error(`CTO agent failed: ${result.error ?? "unknown error"}`);
  }

  const parsed = extractJson(result.response) as CtoPlanJson | null;
  if (!parsed?.domains || typeof parsed.domains !== "object") {
    // Fallback: classify everything as "backend" so the chain can still proceed
    console.warn("[runtime-delegation] CTO response could not be parsed; using fallback classification");
    const fallback: CtoPlanJson = { domains: { backend: items.map((i) => i.id) } };
    const steps = items.map((i) =>
      makeStep("cto", "vp-engineering", i.id, `Plan (fallback): ${i.id} -> backend`, "CTO response unparseable; defaulted to backend")
    );
    return { plan: fallback, steps, costUsd: result.costUsd };
  }

  // Build delegation steps — one per item from CTO -> vp-engineering
  const itemDomainMap = new Map<string, string>();
  for (const [domain, ids] of Object.entries(parsed.domains)) {
    for (const id of ids) itemDomainMap.set(id, domain);
  }

  const steps: DelegationStep[] = items.map((i) => {
    const domain = itemDomainMap.get(i.id) ?? "backend";
    return makeStep(
      "cto",
      "vp-engineering",
      i.id,
      `Plan: assign ${i.id} to ${domain} domain`,
      `CTO classified "${i.title}" as ${domain} domain`,
    );
  });

  return { plan: parsed, steps, costUsd: result.costUsd };
}

// ---------------------------------------------------------------------------
// Phase 2 — VP Engineering Distribution
// ---------------------------------------------------------------------------

/** Shape of the JSON the VP Engineering agent should return. */
interface VpEngPlanJson {
  assignments: Record<string, string[]>; // agentId → itemIds[]
}

/** Default domain-to-agent mapping used when VP Eng response cannot be parsed. */
const DOMAIN_AGENT_FALLBACK: Record<string, string> = {
  frontend: "coder",
  backend: "coder",
  infra: "coder",
  data: "dba",
  qa: "linter",
  platform: "architect",
  research: "researcher",
};

async function runVpEngDistributionPhase(
  plan: CtoPlanJson,
  items: SprintItem[],
  agentsDir: string,
  onEvent?: (e: DelegationChainEvent) => void,
): Promise<{ assignments: Map<string, string[]>; steps: DelegationStep[]; costUsd: number }> {
  const vpConfig = await loadAgentConfig("vp-engineering", agentsDir);
  const config = vpConfig ?? (await loadAgentConfig("cto", agentsDir));
  if (!config) {
    throw new Error(`Neither "vp-engineering" nor "cto" agent configs found in ${agentsDir}`);
  }
  config.workspaceId = "delegation";
  const effectiveAgentId = vpConfig ? "vp-engineering" : "cto";

  const planJson = JSON.stringify(plan, null, 2);
  const itemIndex = items.map((i) => `${i.id}: ${i.title} (${i.priority})`).join("\n");

  const task =
    `You are the VP of Engineering. Distribute this technical plan to the team.\n\n` +
    `Item index:\n${itemIndex}\n\n` +
    `Domain plan from CTO:\n${planJson}\n\n` +
    `Assign each item to the most appropriate agent based on the domain.\n` +
    `Use agent IDs from the standard team roster (e.g. coder, architect, dba, api-specialist, ml-engineer, linter, debugger).\n\n` +
    `Output ONLY valid JSON (no prose, no markdown fences) in exactly this shape:\n` +
    `{ "assignments": { "<agentId>": ["<itemId>", ...], ... } }`;

  onEvent?.({ type: "step_start", agentId: effectiveAgentId, message: "VP Engineering distribution phase started" });

  const runtime = new AgentRuntime(config);
  const result = await runtime.runStreaming({
    task,
    onEvent: (e) => {
      if (e.type === "chunk") {
        onEvent?.({ type: "chunk", agentId: effectiveAgentId, message: "vp-eng chunk", data: e.data });
      }
    },
  });

  onEvent?.({
    type: "step_done",
    agentId: effectiveAgentId,
    message: "VP Engineering distribution phase done",
    data: { costUsd: result.costUsd },
  });

  if (result.status === "failed") {
    throw new Error(`VP Engineering agent failed: ${result.error ?? "unknown error"}`);
  }

  const parsed = extractJson(result.response) as VpEngPlanJson | null;

  const assignedMap: Map<string, string[]> = new Map();
  const steps: DelegationStep[] = [];

  if (!parsed?.assignments || typeof parsed.assignments !== "object") {
    // Fallback: map each domain group to a default agent
    console.warn("[runtime-delegation] VP Eng response could not be parsed; using fallback assignment");
    for (const [domain, ids] of Object.entries(plan.domains)) {
      const targetAgent = DOMAIN_AGENT_FALLBACK[domain] ?? "coder";
      const existing = assignedMap.get(targetAgent) ?? [];
      assignedMap.set(targetAgent, [...existing, ...ids]);
      for (const id of ids) {
        steps.push(
          makeStep(
            effectiveAgentId,
            targetAgent,
            id,
            `Assign (fallback): ${id} -> ${targetAgent}`,
            `VP Eng response unparseable; defaulted ${domain} items to ${targetAgent}`,
          ),
        );
      }
    }
    return { assignments: assignedMap, steps, costUsd: result.costUsd };
  }

  for (const [targetAgentId, ids] of Object.entries(parsed.assignments)) {
    assignedMap.set(targetAgentId, ids);
    for (const id of ids) {
      steps.push(
        makeStep(
          effectiveAgentId,
          targetAgentId,
          id,
          `Assign: ${id} -> ${targetAgentId}`,
          `VP Engineering distributed item to ${targetAgentId}`,
        ),
      );
    }
  }

  return { assignments: assignedMap, steps, costUsd: result.costUsd };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the full agent delegation chain via real Anthropic API calls.
 *
 * @param items      Sprint items to assign.
 * @param agentsDir  Path to the .agentforge directory (contains agents/).
 * @param onEvent    Optional callback for streaming progress events.
 * @returns          Full delegation result including assignments and audit trail.
 */
export async function runDelegationChain(
  items: SprintItem[],
  agentsDir: string,
  onEvent?: (e: DelegationChainEvent) => void,
): Promise<DelegationChainResult> {
  const allSteps: DelegationStep[] = [];
  let totalCostUsd = 0;

  // -------------------------------------------------------------------
  // Phase 1 — CTO Planning
  // -------------------------------------------------------------------
  const { plan, steps: ctoSteps, costUsd: ctoCost } = await runCtoPlanningPhase(
    items,
    agentsDir,
    onEvent,
  );
  allSteps.push(...ctoSteps);
  totalCostUsd += ctoCost;

  // -------------------------------------------------------------------
  // Phase 2 — VP Engineering Distribution
  // -------------------------------------------------------------------
  const { assignments, steps: vpSteps, costUsd: vpCost } = await runVpEngDistributionPhase(
    plan,
    items,
    agentsDir,
    onEvent,
  );
  allSteps.push(...vpSteps);
  totalCostUsd += vpCost;

  // -------------------------------------------------------------------
  // Determine unassigned items
  // -------------------------------------------------------------------
  const assignedItemIds = new Set<string>();
  for (const ids of assignments.values()) {
    for (const id of ids) assignedItemIds.add(id);
  }
  const unassigned = items.map((i) => i.id).filter((id) => !assignedItemIds.has(id));

  return {
    steps: allSteps,
    assignments,
    unassigned,
    totalCostUsd,
    completedAt: new Date().toISOString(),
  };
}
