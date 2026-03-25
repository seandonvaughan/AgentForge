import { describe, it, expect } from "vitest";
import {
  buildBridges,
  mergeTopology,
} from "../../src/collaboration/bridge-builder.js";
import type { DomainTeam, Bridge } from "../../src/types/collaboration.js";
import type { DelegationGraph } from "../../src/types/team.js";

describe("buildBridges", () => {
  it("creates bridges between strategic leads across domains", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder", "test-engineer"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["content-strategist", "seo-specialist"],
        utilities: ["researcher"],
        internal_topology: "flat",
      },
    };

    const delegationGraph: DelegationGraph = {
      architect: ["coder", "test-engineer"],
      cmo: ["content-strategist", "seo-specialist"],
    };

    const bridges = buildBridges(teams, delegationGraph);

    // Should have at least one bridge between architect and cmo
    const architectToCmo = bridges.find(
      (b) => b.from === "architect" && isTargeting(b, "cmo"),
    );
    expect(architectToCmo).toBeDefined();
    expect(architectToCmo!.reason).toBeTruthy();
  });

  it("creates coordinator bridge from PM to all domain leads", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder"],
        utilities: ["researcher"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["content-strategist"],
        utilities: ["researcher"],
        internal_topology: "flat",
      },
    };

    const delegationGraph: DelegationGraph = {
      "project-manager": ["architect", "cmo"],
      architect: ["coder"],
      cmo: ["content-strategist"],
    };

    const bridges = buildBridges(teams, delegationGraph);

    // PM should bridge to all domain leads
    const pmBridge = bridges.find((b) => b.from === "project-manager");
    expect(pmBridge).toBeDefined();
    expect(isTargeting(pmBridge!, "architect")).toBe(true);
    expect(isTargeting(pmBridge!, "cmo")).toBe(true);
  });

  it("returns an empty array for a single domain", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder"],
        utilities: ["researcher"],
        internal_topology: "hierarchy",
      },
    };

    const delegationGraph: DelegationGraph = {
      architect: ["coder"],
    };

    const bridges = buildBridges(teams, delegationGraph);
    expect(bridges).toEqual([]);
  });

  it("does not create duplicate bridges", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder"],
        utilities: ["researcher"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["content-strategist"],
        utilities: ["researcher"],
        internal_topology: "flat",
      },
    };

    const delegationGraph: DelegationGraph = {
      architect: ["coder"],
      cmo: ["content-strategist"],
    };

    const bridges = buildBridges(teams, delegationGraph);

    // Ensure no duplicate from-to pairs
    const keys = bridges.map((b) => `${b.from}->${JSON.stringify(b.to)}`);
    const uniqueKeys = new Set(keys);
    expect(keys.length).toBe(uniqueKeys.size);
  });
});

describe("mergeTopology", () => {
  it("combines domain teams and bridges into a CrossDomainTeam", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder", "test-engineer"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["content-strategist"],
        utilities: ["researcher"],
        internal_topology: "flat",
      },
    };

    const bridges: Bridge[] = [
      {
        from: "architect",
        to: "cmo",
        reason: "Technical constraints affect marketing messaging",
      },
      {
        from: "project-manager",
        to: ["architect", "cmo"],
        reason: "Coordinator needs visibility into all domains",
      },
    ];

    const merged = mergeTopology(teams, bridges, "project-manager");

    expect(merged.topology).toBe("hub-and-spoke");
    expect(merged.coordinator).toBe("project-manager");
    expect(merged.teams).toEqual(teams);
    expect(merged.bridges).toEqual(bridges);
  });

  it("collects shared utilities across domain teams", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["content-strategist"],
        utilities: ["researcher"],
        internal_topology: "flat",
      },
      research: {
        lead: "lead-researcher",
        members: ["data-analyst"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "flat",
      },
    };

    const merged = mergeTopology(teams, [], "project-manager");

    // "researcher" appears in all three domains, "file-reader" in two
    expect(merged.shared_utilities).toContain("researcher");
    expect(merged.shared_utilities).toContain("file-reader");
  });

  it("deduplicates shared utilities", () => {
    const teams: Record<string, DomainTeam> = {
      software: {
        lead: "architect",
        members: ["coder"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "hierarchy",
      },
      marketing: {
        lead: "cmo",
        members: ["writer"],
        utilities: ["researcher", "file-reader"],
        internal_topology: "flat",
      },
    };

    const merged = mergeTopology(teams, [], "project-manager");

    const uniqueUtils = new Set(merged.shared_utilities);
    expect(merged.shared_utilities.length).toBe(uniqueUtils.size);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

/** Check whether a bridge targets a specific agent (handles string | string[]). */
function isTargeting(bridge: Bridge, agent: string): boolean {
  if (Array.isArray(bridge.to)) {
    return bridge.to.includes(agent);
  }
  return bridge.to === agent;
}
