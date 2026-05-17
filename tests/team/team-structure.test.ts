// tests/team/team-structure.test.ts
//
// Structural invariants for the active team manifest. Reads
// `.agentforge/team.yaml` and verifies shape, not specific agent names —
// the v22+ Opus-driven forge produces different agents per project.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

const TEAM_YAML_PATH = join(process.cwd(), ".agentforge/team.yaml");

interface TeamYaml {
  name?: string;
  agents?: {
    strategic?: string[];
    implementation?: string[];
    quality?: string[];
    utility?: string[];
    [key: string]: string[] | undefined;
  };
  model_routing?: {
    opus?: string[];
    sonnet?: string[];
    haiku?: string[];
  };
  delegation_graph?: Record<string, string[]>;
}

let team: TeamYaml;

beforeAll(() => {
  expect(existsSync(TEAM_YAML_PATH)).toBe(true);
  team = parseYaml(readFileSync(TEAM_YAML_PATH, "utf-8")) as TeamYaml;
});

describe("team.yaml — shape", () => {
  it("has a 'name' field", () => {
    expect(typeof team.name).toBe("string");
    expect((team.name ?? "").length).toBeGreaterThan(0);
  });

  it("has an 'agents' object with at least one category", () => {
    expect(typeof team.agents).toBe("object");
    expect(Object.keys(team.agents ?? {}).length).toBeGreaterThan(0);
  });

  it("has at least one agent total", () => {
    const total = Object.values(team.agents ?? {}).reduce(
      (sum, list) => sum + (list?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(0);
  });

  it("agent ids are kebab-case", () => {
    const ids = Object.values(team.agents ?? {}).flatMap((l) => l ?? []);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe("team.yaml — required roster", () => {
  it("includes pr-merge-manager (mandatory role from Cycle 1)", () => {
    const allIds = Object.values(team.agents ?? {}).flatMap((l) => l ?? []);
    expect(allIds).toContain("pr-merge-manager");
  });

  it("has at least one strategic agent", () => {
    expect(team.agents?.strategic?.length ?? 0).toBeGreaterThan(0);
  });

  it("has at least one implementation agent", () => {
    expect(team.agents?.implementation?.length ?? 0).toBeGreaterThan(0);
  });

  it("agents do not appear in multiple categories", () => {
    const seen = new Map<string, string>();
    for (const [cat, ids] of Object.entries(team.agents ?? {})) {
      for (const id of ids ?? []) {
        const prior = seen.get(id);
        if (prior !== undefined) {
          throw new Error(
            `agent '${id}' appears in both '${prior}' and '${cat}'`,
          );
        }
        seen.set(id, cat);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe("team.yaml — model_routing (when present)", () => {
  it("model_routing tiers reference real agents only", () => {
    if (!team.model_routing) return;
    const allIds = new Set(
      Object.values(team.agents ?? {}).flatMap((l) => l ?? []),
    );
    for (const tier of ["opus", "sonnet", "haiku"] as const) {
      for (const id of team.model_routing[tier] ?? []) {
        expect(allIds).toContain(id);
      }
    }
  });
});

describe("team.yaml — delegation_graph (when present)", () => {
  it("every key in delegation_graph is an agent in the team", () => {
    if (!team.delegation_graph) return;
    const allIds = new Set(
      Object.values(team.agents ?? {}).flatMap((l) => l ?? []),
    );
    for (const key of Object.keys(team.delegation_graph)) {
      expect(allIds).toContain(key);
    }
  });

  it("every delegation target exists in the team", () => {
    if (!team.delegation_graph) return;
    const allIds = new Set(
      Object.values(team.agents ?? {}).flatMap((l) => l ?? []),
    );
    for (const [, targets] of Object.entries(team.delegation_graph)) {
      for (const target of targets ?? []) {
        expect(allIds).toContain(target);
      }
    }
  });
});
