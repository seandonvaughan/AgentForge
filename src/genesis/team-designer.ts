/**
 * Team Designer for the AgentForge Genesis workflow.
 *
 * Orchestrates the full team-composition pipeline starting from a
 * {@link ProjectBrief} and ending with a ready-to-use {@link TeamManifest}.
 *
 * Pipeline:
 * 1. Collect agent names from every active domain pack.
 * 2. Apply model-tier assignments (Opus → strategic, Haiku → utility,
 *    Sonnet → everything else).
 * 3. Select a collaboration topology.
 * 4. Build cross-domain bridges if multiple domains are active.
 * 5. Build a delegation graph from the topology and bridges.
 * 6. Assemble and return the {@link TeamManifest}.
 */

import type { ProjectBrief } from "../types/analysis.js";
import type { DomainId, DomainPack } from "../types/domain.js";
import type { AgentTemplate } from "../types/agent.js";
import type { TeamManifest, TeamAgents, ModelRouting, DelegationGraph } from "../types/team.js";
import type { CollaborationTemplate, Bridge } from "../types/collaboration.js";
import { selectTopology } from "../collaboration/index.js";
import { buildBridges } from "../collaboration/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Agent names that are considered "strategic" and should receive the Opus
 * model tier regardless of their domain pack classification.
 */
const STRATEGIC_AGENT_PATTERNS = [
  "architect",
  "genesis",
  "meta-architect",
  "ceo",
  "cto",
  "cmo",
  "coo",
  "lead",
  "principal",
  "director",
  "chief",
  "head-of",
];

/**
 * Agent names that are considered "utility" and should receive the Haiku
 * model tier regardless of their domain pack classification.
 */
const UTILITY_AGENT_PATTERNS = [
  "file-reader",
  "linter",
  "test-runner",
  "formatter",
  "watcher",
  "reporter",
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the model tier for an agent name.
 *
 * Priority:
 * 1. If the agent template has an explicit model tier, use it.
 * 2. If the agent name matches a strategic pattern, use "opus".
 * 3. If the agent name matches a utility pattern, use "haiku".
 * 4. Default to "sonnet".
 */
function resolveModelTier(
  agentName: string,
  template?: AgentTemplate,
): "opus" | "sonnet" | "haiku" {
  if (template?.model) {
    return template.model;
  }

  const lower = agentName.toLowerCase();

  if (STRATEGIC_AGENT_PATTERNS.some((p) => lower.includes(p))) {
    return "opus";
  }

  if (UTILITY_AGENT_PATTERNS.some((p) => lower.includes(p))) {
    return "haiku";
  }

  return "sonnet";
}

/**
 * Get a human-readable description for a topology type.
 */
function getTopologyDescription(
  type: CollaborationTemplate["type"],
): string {
  const descriptions: Record<CollaborationTemplate["type"], string> = {
    flat: "All agents operate as peers with equal delegation rights.",
    hierarchy:
      "Strategic agents delegate to implementation and quality; implementation delegates to quality and utility.",
    "hub-and-spoke":
      "A central coordinator agent connects specialized domain teams.",
    matrix:
      "Agents collaborate across both functional and domain boundaries.",
    custom: "Custom collaboration topology defined by team configuration.",
  };

  return descriptions[type] || "Custom collaboration topology.";
}

/**
 * Collect every unique agent name declared across all active domain packs,
 * grouped by functional category.
 *
 * The "strategic", "implementation", "quality", and "utility" categories
 * come from the domain pack manifests.  Any unknown category key is passed
 * through as-is to the returned record.
 */
function collectAgentsFromDomains(
  activeDomains: DomainId[],
  domainPacks: Map<DomainId, DomainPack>,
): { agents: TeamAgents; allAgents: string[] } {
  const strategic = new Set<string>();
  const implementation = new Set<string>();
  const quality = new Set<string>();
  const utility = new Set<string>();
  const extra: Record<string, Set<string>> = {};

  for (const domainId of activeDomains) {
    const pack = domainPacks.get(domainId);
    if (!pack) continue;

    const agentsRecord = pack.agents as Record<string, string[]>;

    for (const [category, names] of Object.entries(agentsRecord)) {
      switch (category) {
        case "strategic":
          names.forEach((n) => strategic.add(n));
          break;
        case "implementation":
          names.forEach((n) => implementation.add(n));
          break;
        case "quality":
          names.forEach((n) => quality.add(n));
          break;
        case "utility":
          names.forEach((n) => utility.add(n));
          break;
        default:
          if (!extra[category]) extra[category] = new Set();
          names.forEach((n) => extra[category].add(n));
      }
    }
  }

  const agents: TeamAgents = {
    strategic: [...strategic].sort(),
    implementation: [...implementation].sort(),
    quality: [...quality].sort(),
    utility: [...utility].sort(),
  };

  // Merge any extra domain-specific categories
  for (const [cat, names] of Object.entries(extra)) {
    agents[cat] = [...names].sort();
  }

  const allAgents = [
    ...agents.strategic,
    ...agents.implementation,
    ...agents.quality,
    ...agents.utility,
    ...Object.values(extra).flatMap((s) => [...s]),
  ];

  return { agents, allAgents };
}

/**
 * Build model routing tables from a list of agent names and their templates.
 */
function buildModelRouting(
  allAgents: string[],
  templates: Map<DomainId, Map<string, AgentTemplate>>,
): { routing: ModelRouting; assignments: Record<string, "opus" | "sonnet" | "haiku"> } {
  const opus: string[] = [];
  const sonnet: string[] = [];
  const haiku: string[] = [];
  const assignments: Record<string, "opus" | "sonnet" | "haiku"> = {};

  for (const agentName of allAgents) {
    // Search all domain template maps for this agent
    let template: AgentTemplate | undefined;
    for (const domainTemplates of templates.values()) {
      const t = domainTemplates.get(agentName);
      if (t) {
        template = t;
        break;
      }
    }

    const tier = resolveModelTier(agentName, template);
    assignments[agentName] = tier;

    switch (tier) {
      case "opus":
        opus.push(agentName);
        break;
      case "haiku":
        haiku.push(agentName);
        break;
      default:
        sonnet.push(agentName);
    }
  }

  return {
    routing: { opus, sonnet, haiku },
    assignments,
  };
}

/**
 * Construct a minimal delegation graph from the topology type and agent lists.
 *
 * Rules:
 * - In a flat topology: every agent can delegate to every other agent (peers).
 * - In a hierarchy / hub-and-spoke / matrix: strategic agents delegate to
 *   implementation and quality agents; implementation delegates to quality
 *   and utility; quality delegates to utility.
 * - Cross-domain bridges add explicit cross-agent edges.
 */
function buildDelegationGraph(
  agents: TeamAgents,
  topologyType: CollaborationTemplate["type"],
  bridges: Bridge[],
): DelegationGraph {
  const graph: DelegationGraph = {};

  const allCategories = [
    "strategic",
    "implementation",
    "quality",
    "utility",
  ] as const;

  // Initialise entries for every agent
  for (const cat of allCategories) {
    for (const agent of agents[cat] ?? []) {
      graph[agent] = [];
    }
  }

  // Extra categories (e.g. domain-specific names)
  for (const [cat, names] of Object.entries(agents)) {
    if (allCategories.includes(cat as typeof allCategories[number])) continue;
    for (const agent of names) {
      if (!graph[agent]) graph[agent] = [];
    }
  }

  if (topologyType === "flat") {
    // All agents are peers — each can delegate to all others
    const everyone = Object.keys(graph);
    for (const agent of everyone) {
      graph[agent] = everyone.filter((a) => a !== agent);
    }
  } else {
    // Hierarchical delegation: strategic → implementation → quality → utility
    const stratList = agents.strategic ?? [];
    const implList = agents.implementation ?? [];
    const qualList = agents.quality ?? [];
    const utilList = agents.utility ?? [];

    for (const agent of stratList) {
      graph[agent] = [...implList, ...qualList, ...utilList];
    }
    for (const agent of implList) {
      graph[agent] = [...qualList, ...utilList];
    }
    for (const agent of qualList) {
      graph[agent] = [...utilList];
    }
    // utility agents cannot delegate further
  }

  // Apply bridge edges (additive)
  for (const bridge of bridges) {
    const targets = Array.isArray(bridge.to) ? bridge.to : [bridge.to];
    const existing = graph[bridge.from] ?? [];
    graph[bridge.from] = [
      ...new Set([...existing, ...targets]),
    ];
  }

  return graph;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Design a complete agent team from a project brief and active domain packs.
 *
 * @param brief        - Universal project brief describing the project.
 * @param activeDomains - Domain IDs that have been activated for this project.
 * @param domainPacks  - Map of all available domain packs.
 * @param templates    - Map of agent templates keyed by domain then agent name.
 * @returns A fully assembled {@link TeamManifest}.
 */
export function designTeam(
  brief: ProjectBrief,
  activeDomains: DomainId[],
  domainPacks: Map<DomainId, DomainPack>,
  templates: Map<DomainId, Map<string, AgentTemplate>>,
): TeamManifest {
  // ── 1. Collect agents from active domain packs ──────────────────────────
  const { agents, allAgents } = collectAgentsFromDomains(activeDomains, domainPacks);

  // ── 2. Assign model tiers ───────────────────────────────────────────────
  const { routing: modelRouting } = buildModelRouting(allAgents, templates);

  // ── 3. Select collaboration topology ───────────────────────────────────
  const topologyType = selectTopology(brief, activeDomains, allAgents.length);

  // ── 4. Build cross-domain bridges ──────────────────────────────────────
  // Construct a minimal DomainTeam record for bridging purposes.
  const domainTeamRecord: Record<string, { lead: string; members: string[]; utilities: string[]; internal_topology: string }> = {};

  for (const domainId of activeDomains) {
    const pack = domainPacks.get(domainId);
    if (!pack) continue;

    const packAgents = pack.agents as Record<string, string[]>;
    const strategic = packAgents.strategic ?? [];
    const implementation = packAgents.implementation ?? [];
    const quality = packAgents.quality ?? [];
    const utility = packAgents.utility ?? [];

    const lead = strategic[0] ?? implementation[0] ?? "unknown";
    const members = [...strategic.slice(1), ...implementation, ...quality];
    const utilities = [...utility];

    domainTeamRecord[domainId] = {
      lead,
      members,
      utilities,
      internal_topology: "flat",
    };
  }

  // Build a temporary delegation graph skeleton for bridge detection
  const tempGraph: DelegationGraph = {};
  for (const agent of allAgents) {
    tempGraph[agent] = [];
  }

  const bridges = buildBridges(domainTeamRecord, tempGraph);

  // ── 5. Build delegation graph ───────────────────────────────────────────
  const collaborationStub: CollaborationTemplate["type"] = topologyType;
  const delegationGraph = buildDelegationGraph(agents, collaborationStub, bridges);

  // ── 6. Build minimal collaboration object ──────────────────────────────
  const collaboration: CollaborationTemplate = {
    name: topologyType,
    type: topologyType,
    description: getTopologyDescription(topologyType),
    topology: {
      root: null,
      levels: [],
    },
    delegation_rules: {
      direction: topologyType === "flat" ? "peer" : "top-down",
      cross_level: topologyType !== "flat",
      peer_collaboration: true,
      review_flow: topologyType === "flat" ? "peer" : "bottom-up",
    },
    communication: {
      patterns: ["request-response"],
      gates: [],
    },
    escalation: {
      max_retries: 3,
      escalate_to: agents.strategic?.[0] ?? "unknown",
      human_escalation: false,
    },
    loop_limits: {
      review_cycle: 5,
      delegation_depth: 4,
      retry_same_agent: 3,
      total_actions: 50,
    },
  };

  // ── 7. Assemble TeamManifest ────────────────────────────────────────────
  const manifest: TeamManifest = {
    name: `${brief.project.name} Team`,
    forged_at: new Date().toISOString(),
    forged_by: "genesis",
    project_hash: "",
    agents,
    model_routing: modelRouting,
    delegation_graph: delegationGraph,
    collaboration,
    project_brief: brief,
    domains: activeDomains,
  };

  return manifest;
}
