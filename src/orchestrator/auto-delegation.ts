/**
 * AutoDelegationPipeline — AgentForge v6.2 P1-7
 *
 * Sprint Auto-Delegation Pipeline.
 *
 * When a sprint enters the "assign" phase this pipeline runs the full
 * executive chain automatically:
 *   1. CTO Planning   — groups items by technical domain
 *   2. VP Engineering  — distributes domain groups to team managers
 *   3. Tech Lead Routing — selects the best specialist per item
 *   4. Fallback        — adjacent-team search, then unassigned list
 *
 * This module is intentionally pure: no DB or bus dependencies.
 * Pass data in, get a delegation plan out.
 */

import type {
  TeamUnit,
  AgentIdentity,
  SeniorityLevel,
  TechnicalLayer,
} from "../types/lifecycle.js";
import { SENIORITY_CONFIG } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Sprint item from a sprint plan.
 */
export interface SprintItem {
  id: string;
  title: string;
  description: string;
  priority: "P0" | "P1" | "P2";
  assignee: string;
  status: string;
}

/**
 * A delegation step recording who delegated what to whom.
 */
export interface DelegationStep {
  from: string;      // delegator agent ID
  to: string;        // delegatee agent ID
  itemId: string;    // sprint item ID
  action: string;    // what was delegated
  rationale: string; // why this delegation was made
  timestamp: string;
}

/**
 * Result of the auto-delegation pipeline.
 */
export interface AutoDelegationResult {
  steps: DelegationStep[];
  assignments: Map<string, string[]>; // agentId → list of item IDs assigned
  unassigned: string[];               // item IDs that couldn't be assigned
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Seniority ordering for "at least X" comparisons. */
const SENIORITY_ORDER: Record<SeniorityLevel, number> = {
  junior: 0,
  mid: 1,
  senior: 2,
  lead: 3,
  principal: 4,
};

/** Keyword buckets used to infer technical domain from item text. */
const DOMAIN_KEYWORDS: Record<TechnicalLayer, string[]> = {
  frontend: [
    "ui", "component", "page", "dashboard", "css", "style", "svelte",
    "react", "html", "dom", "animation", "layout", "theme", "design",
  ],
  backend: [
    "api", "endpoint", "route", "server", "handler", "middleware",
    "rest", "graphql", "websocket", "http", "request", "response",
  ],
  infra: [
    "ci", "cd", "deploy", "docker", "pipeline", "security", "monitor",
    "kubernetes", "k8s", "terraform", "nginx", "load balancer", "ssl",
    "certificate", "helm", "ansible", "github actions",
  ],
  data: [
    "database", "schema", "migration", "query", "embedding",
    "sql", "sqlite", "postgres", "mongodb", "redis", "index",
    "table", "column", "orm", "prisma", "vector",
  ],
  qa: [
    "test", "coverage", "quality", "lint", "spec", "fixture",
    "mock", "assertion", "vitest", "jest", "e2e", "playwright",
  ],
  // The following layers are not primary routing targets but exist in the type.
  platform: [
    "platform", "sdk", "library", "package", "workspace", "monorepo",
  ],
  research: [
    "research", "poc", "prototype", "experiment", "benchmark", "eval",
  ],
  executive: [],
};

/** Canonical adjacency list for fallback team search. */
const ADJACENT_LAYERS: Partial<Record<TechnicalLayer, TechnicalLayer[]>> = {
  frontend: ["backend", "qa"],
  backend: ["infra", "data", "qa"],
  infra: ["backend", "platform"],
  data: ["backend", "infra"],
  qa: ["frontend", "backend"],
  platform: ["infra", "backend"],
  research: ["backend", "data"],
};

// ---------------------------------------------------------------------------
// AutoDelegationPipeline
// ---------------------------------------------------------------------------

export class AutoDelegationPipeline {
  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Run the full sprint delegation chain and return a delegation plan.
   *
   * No external calls — purely derives a plan from the supplied data.
   */
  delegateSprint(
    items: SprintItem[],
    teams: TeamUnit[],
    allAgents?: AgentIdentity[],
  ): AutoDelegationResult {
    const steps: DelegationStep[] = [];
    const assignments: Map<string, string[]> = new Map();
    const unassigned: string[] = [];

    // ------------------------------------------------------------------
    // Phase 1 — CTO Planning: group items by domain
    // ------------------------------------------------------------------
    const domainGroups = new Map<string, SprintItem[]>();

    for (const item of items) {
      const domain = this.inferDomain(item);
      const group = domainGroups.get(domain) ?? [];
      group.push(item);
      domainGroups.set(domain, group);

      steps.push(
        this._step(
          "cto",
          "vp-engineering",
          item.id,
          `Plan: assign ${item.id} to ${domain} domain`,
          `Item "${item.title}" classified as ${domain} domain by keyword analysis`,
        ),
      );
    }

    // ------------------------------------------------------------------
    // Phase 2 — VP Engineering Distribution: find team per domain
    // ------------------------------------------------------------------
    for (const [domain, groupItems] of domainGroups) {
      const matchingTeam = this._findTeamForLayer(
        domain as TechnicalLayer,
        teams,
      );

      if (!matchingTeam) {
        // No primary team for this domain — attempt adjacent-team fallback
        // directly from VP Engineering, then mark unassigned if that also fails.
        for (const item of groupItems) {
          steps.push(
            this._step(
              "vp-engineering",
              "cto",
              item.id,
              `Escalate: no team found for ${domain} domain`,
              `No team registered for layer "${domain}"; attempting adjacent-team routing`,
            ),
          );

          const adjacentLayers =
            ADJACENT_LAYERS[domain as TechnicalLayer] ?? [];
          let assigned = false;

          for (const adjLayer of adjacentLayers) {
            const adjTeam = this._findTeamForLayer(adjLayer, teams);
            if (!adjTeam) continue;

            const adjSpecialist = this.selectSpecialist(
              adjTeam,
              item,
              allAgents,
            );
            if (adjSpecialist) {
              steps.push(
                this._step(
                  "vp-engineering",
                  adjTeam.techLead,
                  item.id,
                  `Fallback: route ${item.id} to adjacent ${adjLayer} team`,
                  `No primary ${domain} team; adjacent ${adjLayer} team has available capacity`,
                ),
              );
              steps.push(
                this._step(
                  adjTeam.techLead,
                  adjSpecialist,
                  item.id,
                  `Assign (fallback): ${item.id} → ${adjSpecialist}`,
                  `Adjacent tech lead selected ${adjSpecialist} for cross-team assignment`,
                ),
              );

              const list = assignments.get(adjSpecialist) ?? [];
              list.push(item.id);
              assignments.set(adjSpecialist, list);
              assigned = true;
              break;
            }
          }

          if (!assigned) {
            unassigned.push(item.id);
            steps.push(
              this._step(
                "vp-engineering",
                "cto",
                item.id,
                `Unassigned: ${item.id} cannot be staffed`,
                `No primary or adjacent team with capacity for ${item.priority} item "${item.title}"`,
              ),
            );
          }
        }
        continue;
      }

      for (const item of groupItems) {
        steps.push(
          this._step(
            "vp-engineering",
            matchingTeam.manager,
            item.id,
            `Distribute: assign ${item.id} to ${matchingTeam.id}`,
            `Domain "${domain}" maps to team "${matchingTeam.id}"; routing to engineering manager`,
          ),
        );
      }

      // ----------------------------------------------------------------
      // Phase 3 — Tech Lead Routing
      // ----------------------------------------------------------------
      for (const item of groupItems) {
        const specialist = this.selectSpecialist(matchingTeam, item, allAgents);

        if (specialist) {
          steps.push(
            this._step(
              matchingTeam.techLead,
              specialist,
              item.id,
              `Assign: ${item.id} → ${specialist}`,
              `Tech lead selected ${specialist} based on seniority, capacity, and skill match`,
            ),
          );

          const list = assignments.get(specialist) ?? [];
          list.push(item.id);
          assignments.set(specialist, list);
          continue;
        }

        // ----------------------------------------------------------------
        // Phase 4 — Fallback: try adjacent teams
        // ----------------------------------------------------------------
        const adjacentLayers =
          ADJACENT_LAYERS[domain as TechnicalLayer] ?? [];
        let assigned = false;

        for (const adjLayer of adjacentLayers) {
          const adjTeam = this._findTeamForLayer(adjLayer, teams);
          if (!adjTeam) continue;

          const adjSpecialist = this.selectSpecialist(
            adjTeam,
            item,
            allAgents,
          );
          if (adjSpecialist) {
            steps.push(
              this._step(
                matchingTeam.techLead,
                adjTeam.techLead,
                item.id,
                `Fallback: escalate ${item.id} to adjacent ${adjLayer} team`,
                `No capacity in ${domain} team; adjacent ${adjLayer} team has availability`,
              ),
            );
            steps.push(
              this._step(
                adjTeam.techLead,
                adjSpecialist,
                item.id,
                `Assign (fallback): ${item.id} → ${adjSpecialist}`,
                `Adjacent tech lead selected ${adjSpecialist} for cross-team assignment`,
              ),
            );

            const list = assignments.get(adjSpecialist) ?? [];
            list.push(item.id);
            assignments.set(adjSpecialist, list);
            assigned = true;
            break;
          }
        }

        if (!assigned) {
          unassigned.push(item.id);
          steps.push(
            this._step(
              matchingTeam.techLead,
              "vp-engineering",
              item.id,
              `Unassigned: ${item.id} cannot be staffed`,
              `No capacity in primary or adjacent teams for ${item.priority} item "${item.title}"`,
            ),
          );
        }
      }
    }

    return { steps, assignments, unassigned };
  }

  /**
   * Classify a sprint item into a technical layer based on keywords in
   * its title and description. Defaults to "backend" when nothing matches.
   */
  inferDomain(item: SprintItem): string {
    const text = `${item.title} ${item.description}`.toLowerCase();

    let bestLayer: string = "backend";
    let bestScore = 0;

    for (const [layer, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestLayer = layer;
      }
    }

    return bestLayer;
  }

  /**
   * Pick the best specialist from the team for the given sprint item.
   *
   * Selection criteria (in order of priority):
   *   1. Capacity    — agent must have at least one free execution slot
   *   2. Seniority   — P0 requires senior+, P1 requires mid+, P2 allows junior+
   *   3. Skill match — prefer agents whose ID keywords overlap item text
   *   4. Load        — among equally ranked agents, prefer fewer active tasks
   *
   * Returns null if no suitable agent is available in the team.
   */
  selectSpecialist(
    team: TeamUnit,
    item: SprintItem,
    allAgents?: AgentIdentity[],
  ): string | null {
    const minSeniority = AutoDelegationPipeline.priorityToMinSeniority(
      item.priority,
    );
    const minOrder = SENIORITY_ORDER[minSeniority];

    // Build a lookup map for fast agent resolution
    const agentMap = new Map<string, AgentIdentity>(
      (allAgents ?? []).map((a) => [a.id, a]),
    );

    const candidates: Array<{
      id: string;
      skillScore: number;
      activeTasks: number;
      seniorityOrder: number;
    }> = [];

    for (const specialistId of team.specialists) {
      const agent = agentMap.get(specialistId);

      if (agent) {
        // Check seniority requirement
        const agentOrder = SENIORITY_ORDER[agent.seniority];
        if (agentOrder < minOrder) continue;

        // Check capacity
        const maxSlots =
          SENIORITY_CONFIG[agent.seniority].maxConcurrentTasks;
        const activeTasks = agent.currentTasks.length;
        if (activeTasks >= maxSlots) continue;

        // Compute skill score from ID keywords matching item text
        const skillScore = this._skillScore(specialistId, item);

        candidates.push({
          id: specialistId,
          skillScore,
          activeTasks,
          seniorityOrder: agentOrder,
        });
      } else {
        // No AgentIdentity supplied — treat as a bare id with unknown load.
        // Only accept if the item isn't P0 (can't verify seniority).
        if (item.priority === "P0") continue;

        const skillScore = this._skillScore(specialistId, item);
        candidates.push({
          id: specialistId,
          skillScore,
          activeTasks: 0,
          seniorityOrder: minOrder, // assume just meets the bar
        });
      }
    }

    if (candidates.length === 0) return null;

    // Sort: highest skill score first, then lowest active tasks, then
    // highest seniority as tiebreaker.
    candidates.sort((a, b) => {
      if (b.skillScore !== a.skillScore) return b.skillScore - a.skillScore;
      if (a.activeTasks !== b.activeTasks) return a.activeTasks - b.activeTasks;
      return b.seniorityOrder - a.seniorityOrder;
    });

    return candidates[0].id;
  }

  /**
   * Map task priority to the minimum seniority required to handle it.
   *   P0 → senior (critical work needs experience)
   *   P1 → mid    (standard feature work)
   *   P2 → junior (low-stakes tasks, good for growth)
   */
  static priorityToMinSeniority(priority: "P0" | "P1" | "P2"): SeniorityLevel {
    switch (priority) {
      case "P0":
        return "senior";
      case "P1":
        return "mid";
      case "P2":
        return "junior";
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Build a delegation step with the current timestamp. */
  private _step(
    from: string,
    to: string,
    itemId: string,
    action: string,
    rationale: string,
  ): DelegationStep {
    return {
      from,
      to,
      itemId,
      action,
      rationale,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Find the first team that matches the given technical layer.
   * Returns undefined when no team covers the layer.
   */
  private _findTeamForLayer(
    layer: TechnicalLayer,
    teams: TeamUnit[],
  ): TeamUnit | undefined {
    return teams.find((t) => t.layer === layer);
  }

  /**
   * Compute a simple skill-match score by counting how many words in the
   * agent ID appear in the normalised item text.
   *
   * Agent IDs tend to encode role info (e.g. "backend-senior-coder"),
   * so splitting on hyphens gives useful signal without requiring a
   * separate skills registry at this layer.
   */
  private _skillScore(agentId: string, item: SprintItem): number {
    const text = `${item.title} ${item.description}`.toLowerCase();
    const tokens = agentId.toLowerCase().split(/[-_]/);
    return tokens.reduce(
      (score, token) =>
        token.length >= 3 && text.includes(token) ? score + 1 : score,
      0,
    );
  }
}
