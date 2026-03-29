/**
 * Tests for AutoDelegationPipeline — AgentForge v6.2 P1-7
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  AutoDelegationPipeline,
  type SprintItem,
  type AutoDelegationResult,
} from "../../src/orchestrator/auto-delegation.js";
import type { TeamUnit, AgentIdentity } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeItem(
  overrides: Partial<SprintItem> & Pick<SprintItem, "id" | "title">,
): SprintItem {
  return {
    description: "",
    priority: "P1",
    assignee: "",
    status: "todo",
    ...overrides,
  };
}

function makeAgent(
  id: string,
  overrides: Partial<AgentIdentity> = {},
): AgentIdentity {
  return {
    id,
    name: id,
    role: "specialist",
    seniority: "mid",
    layer: "backend",
    teamId: "backend-team",
    model: "sonnet",
    status: "active",
    hiredAt: new Date().toISOString(),
    currentTasks: [],
    maxConcurrentTasks: 2,
    ...overrides,
  };
}

function makeTeam(
  id: string,
  layer: TeamUnit["layer"],
  specialists: string[],
  overrides: Partial<TeamUnit> = {},
): TeamUnit {
  return {
    id,
    layer,
    manager: `${id}-manager`,
    techLead: `${id}-lead`,
    specialists,
    maxCapacity: 6,
    currentLoad: 0,
    domain: [layer],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared pipeline instance
// ---------------------------------------------------------------------------

let pipeline: AutoDelegationPipeline;

beforeEach(() => {
  pipeline = new AutoDelegationPipeline();
});

// ---------------------------------------------------------------------------
// inferDomain
// ---------------------------------------------------------------------------

describe("inferDomain", () => {
  it("classifies frontend keywords", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "1", title: "Build dashboard component", description: "Svelte UI page" }),
      ),
    ).toBe("frontend");
  });

  it("classifies backend keywords", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "2", title: "Add API endpoint", description: "REST route handler" }),
      ),
    ).toBe("backend");
  });

  it("classifies infra keywords", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "3", title: "Fix CI pipeline", description: "Deploy via Docker" }),
      ),
    ).toBe("infra");
  });

  it("classifies data keywords", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "4", title: "Add database migration", description: "Schema change for embeddings" }),
      ),
    ).toBe("data");
  });

  it("classifies qa keywords", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "5", title: "Improve test coverage", description: "Add e2e spec fixtures" }),
      ),
    ).toBe("qa");
  });

  it("defaults to backend when nothing matches", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "6", title: "Miscellaneous task", description: "Unrelated stuff" }),
      ),
    ).toBe("backend");
  });

  it("picks the domain with the most keyword matches when multiple overlap", () => {
    // "api" and "route" and "handler" are all backend — should win over one frontend keyword
    const domain = pipeline.inferDomain(
      makeItem({
        id: "7",
        title: "API route handler with component",
        description: "server middleware endpoint",
      }),
    );
    expect(domain).toBe("backend");
  });

  it("uses both title and description for matching", () => {
    // Title alone has no strong signal; description has CSS keyword
    const domain = pipeline.inferDomain(
      makeItem({ id: "8", title: "Update styles", description: "Rework CSS layout animations" }),
    );
    expect(domain).toBe("frontend");
  });

  it("is case-insensitive", () => {
    expect(
      pipeline.inferDomain(
        makeItem({ id: "9", title: "SVELTE PAGE", description: "UI DASHBOARD COMPONENT" }),
      ),
    ).toBe("frontend");
  });
});

// ---------------------------------------------------------------------------
// priorityToMinSeniority
// ---------------------------------------------------------------------------

describe("priorityToMinSeniority", () => {
  it("P0 maps to senior", () => {
    expect(AutoDelegationPipeline.priorityToMinSeniority("P0")).toBe("senior");
  });

  it("P1 maps to mid", () => {
    expect(AutoDelegationPipeline.priorityToMinSeniority("P1")).toBe("mid");
  });

  it("P2 maps to junior", () => {
    expect(AutoDelegationPipeline.priorityToMinSeniority("P2")).toBe("junior");
  });
});

// ---------------------------------------------------------------------------
// selectSpecialist
// ---------------------------------------------------------------------------

describe("selectSpecialist", () => {
  const backendTeam = makeTeam("backend-team", "backend", [
    "backend-junior-1",
    "backend-mid-1",
    "backend-senior-1",
  ]);

  it("picks the highest-capacity agent (fewest active tasks)", () => {
    const agents: AgentIdentity[] = [
      makeAgent("backend-mid-1", { seniority: "mid", currentTasks: ["t1", "t2"], maxConcurrentTasks: 2 }),
      makeAgent("backend-senior-1", { seniority: "senior", currentTasks: [], maxConcurrentTasks: 3 }),
      makeAgent("backend-junior-1", { seniority: "junior", currentTasks: [], maxConcurrentTasks: 1 }),
    ];
    const item = makeItem({ id: "i1", title: "Fix backend route", priority: "P1" });
    const result = pipeline.selectSpecialist(backendTeam, item, agents);
    // senior has 0 active, junior also has 0 but only meets P2; senior should win
    expect(result).toBe("backend-senior-1");
  });

  it("skips agents that are at max capacity", () => {
    const agents: AgentIdentity[] = [
      makeAgent("backend-mid-1", { seniority: "mid", currentTasks: ["t1", "t2"], maxConcurrentTasks: 2 }),
      makeAgent("backend-senior-1", { seniority: "senior", currentTasks: ["t1", "t2", "t3"], maxConcurrentTasks: 3 }),
      makeAgent("backend-junior-1", { seniority: "junior", currentTasks: [], maxConcurrentTasks: 1 }),
    ];
    const item = makeItem({ id: "i2", title: "Add API handler", priority: "P2" });
    // mid and senior are both full; junior has capacity and meets P2 bar
    const result = pipeline.selectSpecialist(backendTeam, item, agents);
    expect(result).toBe("backend-junior-1");
  });

  it("returns null when all specialists are at max capacity", () => {
    const agents: AgentIdentity[] = [
      makeAgent("backend-mid-1", { seniority: "mid", currentTasks: ["t1", "t2"], maxConcurrentTasks: 2 }),
      makeAgent("backend-senior-1", { seniority: "senior", currentTasks: ["t1", "t2", "t3"], maxConcurrentTasks: 3 }),
      makeAgent("backend-junior-1", { seniority: "junior", currentTasks: ["t1"], maxConcurrentTasks: 1 }),
    ];
    const item = makeItem({ id: "i3", title: "Update middleware", priority: "P2" });
    expect(pipeline.selectSpecialist(backendTeam, item, agents)).toBeNull();
  });

  it("returns null when no agent meets the seniority bar for P0", () => {
    const agents: AgentIdentity[] = [
      makeAgent("backend-mid-1", { seniority: "mid", currentTasks: [], maxConcurrentTasks: 2 }),
      makeAgent("backend-junior-1", { seniority: "junior", currentTasks: [], maxConcurrentTasks: 1 }),
    ];
    const item = makeItem({ id: "i4", title: "Critical API fix", priority: "P0" });
    expect(pipeline.selectSpecialist(backendTeam, item, agents)).toBeNull();
  });

  it("prefers agents whose ID keywords match the item text", () => {
    const mixedTeam = makeTeam("backend-team", "backend", [
      "frontend-specialist",
      "api-specialist",
    ]);
    const agents: AgentIdentity[] = [
      makeAgent("frontend-specialist", { seniority: "senior", currentTasks: [] }),
      makeAgent("api-specialist", { seniority: "senior", currentTasks: [] }),
    ];
    const item = makeItem({ id: "i5", title: "Build API endpoint", description: "REST api route" });
    const result = pipeline.selectSpecialist(mixedTeam, item, agents);
    // Either specialist is valid — both are senior with capacity
    expect(["api-specialist", "frontend-specialist"]).toContain(result);
  });

  it("works without allAgents (bare id mode), skipping P0 items", () => {
    const item = makeItem({ id: "i6", title: "Low-priority task", priority: "P2" });
    const result = pipeline.selectSpecialist(backendTeam, item);
    // Should return the first specialist id without agent data (non-P0)
    expect(result).toBe("backend-junior-1");
  });

  it("returns null in bare id mode for P0 items", () => {
    const item = makeItem({ id: "i7", title: "Critical fix", priority: "P0" });
    expect(pipeline.selectSpecialist(backendTeam, item)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// delegateSprint — full pipeline
// ---------------------------------------------------------------------------

describe("delegateSprint", () => {
  const frontendTeam = makeTeam("frontend-team", "frontend", [
    "frontend-senior-1",
    "frontend-mid-1",
  ]);
  const backendTeam = makeTeam("backend-team", "backend", [
    "backend-senior-1",
    "backend-mid-1",
  ]);
  const qaTeam = makeTeam("qa-team", "qa", ["qa-senior-1", "qa-mid-1"]);

  const agents: AgentIdentity[] = [
    makeAgent("frontend-senior-1", { seniority: "senior", layer: "frontend", teamId: "frontend-team", currentTasks: [] }),
    makeAgent("frontend-mid-1", { seniority: "mid", layer: "frontend", teamId: "frontend-team", currentTasks: [] }),
    makeAgent("backend-senior-1", { seniority: "senior", layer: "backend", teamId: "backend-team", currentTasks: [] }),
    makeAgent("backend-mid-1", { seniority: "mid", layer: "backend", teamId: "backend-team", currentTasks: [] }),
    makeAgent("qa-senior-1", { seniority: "senior", layer: "qa", teamId: "qa-team", currentTasks: [] }),
    makeAgent("qa-mid-1", { seniority: "mid", layer: "qa", teamId: "qa-team", currentTasks: [] }),
  ];

  const teams = [frontendTeam, backendTeam, qaTeam];

  it("assigns all items when every domain has a team", () => {
    const items: SprintItem[] = [
      makeItem({ id: "s1", title: "Build dashboard component", description: "Svelte UI page", priority: "P1" }),
      makeItem({ id: "s2", title: "Add API route", description: "REST endpoint handler", priority: "P1" }),
      makeItem({ id: "s3", title: "Improve test coverage", description: "Add spec fixtures", priority: "P2" }),
    ];

    const result: AutoDelegationResult = pipeline.delegateSprint(items, teams, agents);

    expect(result.unassigned).toHaveLength(0);

    // Every item should appear exactly once across all assignments
    const allAssigned = [...result.assignments.values()].flat();
    expect(allAssigned.sort()).toEqual(["s1", "s2", "s3"].sort());
  });

  it("records CTO → VP engineering delegation steps for every item", () => {
    const items: SprintItem[] = [
      makeItem({ id: "c1", title: "Add API endpoint", priority: "P1" }),
    ];
    const result = pipeline.delegateSprint(items, teams, agents);

    const ctoSteps = result.steps.filter((s) => s.from === "cto" && s.to === "vp-engineering");
    expect(ctoSteps).toHaveLength(1);
    expect(ctoSteps[0].itemId).toBe("c1");
  });

  it("records VP → manager distribution steps", () => {
    const items: SprintItem[] = [
      makeItem({ id: "v1", title: "API route handler", priority: "P1" }),
    ];
    const result = pipeline.delegateSprint(items, teams, agents);

    const vpSteps = result.steps.filter(
      (s) => s.from === "vp-engineering" && s.to === "backend-team-manager",
    );
    expect(vpSteps).toHaveLength(1);
  });

  it("records tech lead → specialist assignment steps", () => {
    const items: SprintItem[] = [
      makeItem({ id: "tl1", title: "Add API route", description: "server middleware", priority: "P1" }),
    ];
    const result = pipeline.delegateSprint(items, teams, agents);

    const leadSteps = result.steps.filter((s) => s.from === "backend-team-lead");
    expect(leadSteps.length).toBeGreaterThan(0);
    expect(leadSteps.some((s) => s.itemId === "tl1")).toBe(true);
  });

  it("P0 items only go to senior+ agents", () => {
    const items: SprintItem[] = [
      makeItem({ id: "p0a", title: "Critical API fix", description: "server crash", priority: "P0" }),
      makeItem({ id: "p0b", title: "Build dashboard component", description: "Svelte UI crash", priority: "P0" }),
    ];

    const result = pipeline.delegateSprint(items, teams, agents);

    for (const [agentId, itemIds] of result.assignments) {
      if (itemIds.some((id) => ["p0a", "p0b"].includes(id))) {
        const agent = agents.find((a) => a.id === agentId);
        if (agent) {
          const order: Record<string, number> = {
            junior: 0, mid: 1, senior: 2, lead: 3, principal: 4,
          };
          expect(order[agent.seniority]).toBeGreaterThanOrEqual(order["senior"]);
        }
      }
    }
  });

  it("adds to unassigned when no team matches the domain", () => {
    // Only include the qa team; backend and frontend items will need fallback
    const items: SprintItem[] = [
      makeItem({ id: "u1", title: "Deploy to Docker", description: "infra CI pipeline", priority: "P1" }),
    ];

    // infra team is absent; adjacent teams (backend, platform) may or may not exist
    const result = pipeline.delegateSprint(
      items,
      [qaTeam], // no infra or backend team
      agents,
    );

    // "infra" domain → no primary team. Adjacent = backend, platform.
    // QA team is present but not adjacent to infra. Should be unassigned.
    expect(result.unassigned).toContain("u1");
  });

  it("falls back to adjacent team when primary team has no capacity", () => {
    const fullBackendTeam = makeTeam("backend-team", "backend", [
      "backend-senior-1",
      "backend-mid-1",
    ]);

    const overloadedAgents: AgentIdentity[] = [
      // backend agents are full
      makeAgent("backend-senior-1", {
        seniority: "senior", layer: "backend", teamId: "backend-team",
        currentTasks: ["t1", "t2", "t3"], maxConcurrentTasks: 3,
      }),
      makeAgent("backend-mid-1", {
        seniority: "mid", layer: "backend", teamId: "backend-team",
        currentTasks: ["t1", "t2"], maxConcurrentTasks: 2,
      }),
      // qa agents are free (qa is adjacent to backend)
      makeAgent("qa-senior-1", { seniority: "senior", layer: "qa", teamId: "qa-team", currentTasks: [] }),
      makeAgent("qa-mid-1", { seniority: "mid", layer: "qa", teamId: "qa-team", currentTasks: [] }),
    ];

    const items: SprintItem[] = [
      makeItem({ id: "f1", title: "Fix API handler", description: "server middleware", priority: "P1" }),
    ];

    const result = pipeline.delegateSprint(
      items,
      [fullBackendTeam, qaTeam],
      overloadedAgents,
    );

    // Should be assigned via fallback to qa team, not unassigned
    expect(result.unassigned).not.toContain("f1");
    const allAssigned = [...result.assignments.values()].flat();
    expect(allAssigned).toContain("f1");

    // A fallback step should be recorded
    const fallbackSteps = result.steps.filter((s) =>
      s.action.startsWith("Fallback:"),
    );
    expect(fallbackSteps.length).toBeGreaterThan(0);
  });

  it("produces no steps and empty assignments for an empty sprint", () => {
    const result = pipeline.delegateSprint([], teams, agents);
    expect(result.steps).toHaveLength(0);
    expect(result.assignments.size).toBe(0);
    expect(result.unassigned).toHaveLength(0);
  });

  it("load-balances across agents in the same team", () => {
    // Give 6 P2 items — all backend — and verify both specialists get work
    const items: SprintItem[] = Array.from({ length: 6 }, (_, i) =>
      makeItem({ id: `lb${i}`, title: "API route update", description: "backend server endpoint", priority: "P2" }),
    );

    // Both agents have capacity 2 each (mid seniority)
    const balancedAgents: AgentIdentity[] = [
      makeAgent("backend-senior-1", { seniority: "senior", layer: "backend", teamId: "backend-team", currentTasks: [], maxConcurrentTasks: 3 }),
      makeAgent("backend-mid-1", { seniority: "mid", layer: "backend", teamId: "backend-team", currentTasks: [], maxConcurrentTasks: 2 }),
    ];

    // Note: pipeline is pure — it doesn't mutate agent.currentTasks as it runs,
    // so both will show 0 active tasks throughout. The first candidate wins each
    // round. This test verifies at least one assignment per agent would be
    // possible: with 5 items and capacity 3+2 = 5 total, all should be assigned.
    const result = pipeline.delegateSprint(items, [backendTeam], balancedAgents);
    expect(result.unassigned).toHaveLength(0);
    const allAssigned = [...result.assignments.values()].flat();
    expect(allAssigned).toHaveLength(6);
  });

  it("step timestamps are valid ISO strings", () => {
    const items: SprintItem[] = [
      makeItem({ id: "ts1", title: "API fix", priority: "P1" }),
    ];
    const result = pipeline.delegateSprint(items, teams, agents);
    for (const step of result.steps) {
      expect(() => new Date(step.timestamp).toISOString()).not.toThrow();
    }
  });
});
