// tests/team/agent-yaml.test.ts
//
// Team-YAML-aware contract tests. Reads `.agentforge/team.yaml`, enumerates
// every agent listed under the `agents:` sections, and verifies each agent's
// `.agentforge/agents/<id>.yaml` file exists with the required fields.
//
// This replaces the v4.6 hardcoded list, which broke whenever the forge
// produced a different team composition (e.g. the v22.1 Opus-driven forge
// replaced 139 v4.6 generalists with 24 project-specific specialists).

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

const PROJECT_ROOT = process.cwd();
const AGENTS_DIR = join(PROJECT_ROOT, ".agentforge/agents");
const TEAM_PATH = join(PROJECT_ROOT, ".agentforge/team.yaml");

interface TeamYaml {
  name?: string;
  agents?: Record<string, string[] | undefined>;
}

interface AgentYaml {
  name?: string;
  model?: string;
  system_prompt?: string;
  skills?: unknown;
  capability_tags?: unknown;
  collaboration?: {
    reports_to?: string;
  };
}

function loadTeam(): TeamYaml {
  if (!existsSync(TEAM_PATH)) return {};
  return parseYaml(readFileSync(TEAM_PATH, "utf-8")) as TeamYaml;
}

function listTeamAgents(team: TeamYaml): string[] {
  const groups = team.agents ?? {};
  const ids = new Set<string>();
  for (const list of Object.values(groups)) {
    for (const id of list ?? []) ids.add(id);
  }
  return [...ids];
}

function agentPath(agentId: string): string {
  return join(AGENTS_DIR, `${agentId}.yaml`);
}

function loadAgent(agentId: string): AgentYaml {
  return parseYaml(readFileSync(agentPath(agentId), "utf-8")) as AgentYaml;
}

const team = loadTeam();
const teamAgents = listTeamAgents(team);

// ---------------------------------------------------------------------------
// Team manifest sanity
// ---------------------------------------------------------------------------

describe("team.yaml", () => {
  it("exists at .agentforge/team.yaml", () => {
    expect(existsSync(TEAM_PATH)).toBe(true);
  });

  it("lists at least one agent", () => {
    expect(teamAgents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-agent contract tests — every agent listed in team.yaml MUST exist
// with the required fields and a valid model tier.
// ---------------------------------------------------------------------------

describe("agent YAML files — manifest contract", () => {
  for (const agentId of teamAgents) {
    it(`${agentId}.yaml exists`, () => {
      expect(existsSync(agentPath(agentId))).toBe(true);
    });

    it(`${agentId} has a non-empty 'name' field`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.name).toBe("string");
      expect((agent.name ?? "").trim().length).toBeGreaterThan(0);
    });

    it(`${agentId} has a valid 'model' tier`, () => {
      const agent = loadAgent(agentId);
      expect(["opus", "sonnet", "haiku"]).toContain(agent.model);
    });

    it(`${agentId} has a non-empty 'system_prompt'`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.system_prompt).toBe("string");
      expect((agent.system_prompt ?? "").trim().length).toBeGreaterThan(20);
    });

    it(`${agentId} has 'skills' or 'capability_tags'`, () => {
      // Pre-v18 templates used `skills`; v18+ Opus-driven forge uses
      // `capability_tags`. Accept either, but require at least one.
      const agent = loadAgent(agentId);
      const hasSkills = Array.isArray(agent.skills) && agent.skills.length > 0;
      const hasTags =
        Array.isArray(agent.capability_tags) && agent.capability_tags.length > 0;
      expect(hasSkills || hasTags).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Roster invariants
// ---------------------------------------------------------------------------

describe("team roster invariants", () => {
  it("pr-merge-manager is in the team (required role from Cycle 1)", () => {
    expect(teamAgents).toContain("pr-merge-manager");
  });

  it("no two agents share the same id", () => {
    const seen = new Set<string>();
    for (const id of teamAgents) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
