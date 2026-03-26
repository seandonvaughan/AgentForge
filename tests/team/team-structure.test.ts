import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

// ---------------------------------------------------------------------------
// Load team.yaml once
// ---------------------------------------------------------------------------

const TEAM_YAML_PATH = join(process.cwd(), ".agentforge/team.yaml");

interface TeamYaml {
  name: string;
  agents: {
    strategic?: string[];
    implementation?: string[];
    quality?: string[];
    utility?: string[];
    [key: string]: string[] | undefined;
  };
  model_routing: {
    opus: string[];
    sonnet: string[];
    haiku: string[];
  };
  delegation_graph: Record<string, string[]>;
}

let team: TeamYaml;

beforeAll(() => {
  const raw = readFileSync(TEAM_YAML_PATH, "utf-8");
  team = parseYaml(raw) as TeamYaml;
});

function allCategoryAgents(t: TeamYaml): string[] {
  return Object.values(t.agents)
    .filter((v): v is string[] => Array.isArray(v))
    .flat();
}

function allModelRoutingAgents(t: TeamYaml): string[] {
  return [
    ...(t.model_routing.opus ?? []),
    ...(t.model_routing.sonnet ?? []),
    ...(t.model_routing.haiku ?? []),
  ];
}

// ---------------------------------------------------------------------------
// File exists
// ---------------------------------------------------------------------------

describe("team.yaml — file", () => {
  it("team.yaml file exists at .agentforge/team.yaml", () => {
    expect(existsSync(TEAM_YAML_PATH)).toBe(true);
  });

  it("team.yaml has a name field", () => {
    expect(typeof team.name).toBe("string");
    expect(team.name.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// All model_routing agents appear in categories
// ---------------------------------------------------------------------------

describe("team.yaml — model_routing agents in categories", () => {
  it("all opus agents are in the categories list", () => {
    const categories = allCategoryAgents(team);
    for (const agent of team.model_routing.opus) {
      expect(categories).toContain(agent);
    }
  });

  it("all sonnet agents are in the categories list", () => {
    const categories = allCategoryAgents(team);
    for (const agent of team.model_routing.sonnet) {
      expect(categories).toContain(agent);
    }
  });

  it("all haiku agents are in the categories list", () => {
    const categories = allCategoryAgents(team);
    for (const agent of team.model_routing.haiku) {
      expect(categories).toContain(agent);
    }
  });
});

// ---------------------------------------------------------------------------
// No agent appears in multiple model tiers
// ---------------------------------------------------------------------------

describe("team.yaml — no duplicate model tier assignments", () => {
  it("no agent appears in both opus and sonnet", () => {
    const opusSet = new Set(team.model_routing.opus);
    for (const agent of team.model_routing.sonnet) {
      expect(opusSet.has(agent)).toBe(false);
    }
  });

  it("no agent appears in both opus and haiku", () => {
    const opusSet = new Set(team.model_routing.opus);
    for (const agent of team.model_routing.haiku) {
      expect(opusSet.has(agent)).toBe(false);
    }
  });

  it("no agent appears in both sonnet and haiku", () => {
    const sonnetSet = new Set(team.model_routing.sonnet);
    for (const agent of team.model_routing.haiku) {
      expect(sonnetSet.has(agent)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Specific agent placements
// ---------------------------------------------------------------------------

describe("team.yaml — strategic agents in opus tier", () => {
  it("vp-research is in strategic category", () => {
    expect(team.agents.strategic).toContain("vp-research");
  });

  it("vp-engineering is in strategic category", () => {
    expect(team.agents.strategic).toContain("vp-engineering");
  });

  it("vp-research is in opus model tier", () => {
    expect(team.model_routing.opus).toContain("vp-research");
  });

  it("vp-engineering is in opus model tier", () => {
    expect(team.model_routing.opus).toContain("vp-engineering");
  });
});

describe("team.yaml — engineering managers in implementation + sonnet", () => {
  it("engineering-manager-frontend is in implementation category", () => {
    expect(team.agents.implementation).toContain("engineering-manager-frontend");
  });

  it("engineering-manager-backend is in implementation category", () => {
    expect(team.agents.implementation).toContain("engineering-manager-backend");
  });

  it("engineering-manager-infra is in implementation category", () => {
    expect(team.agents.implementation).toContain("engineering-manager-infra");
  });

  it("engineering-manager-frontend is in sonnet model tier", () => {
    expect(team.model_routing.sonnet).toContain("engineering-manager-frontend");
  });

  it("engineering-manager-backend is in sonnet model tier", () => {
    expect(team.model_routing.sonnet).toContain("engineering-manager-backend");
  });

  it("engineering-manager-infra is in sonnet model tier", () => {
    expect(team.model_routing.sonnet).toContain("engineering-manager-infra");
  });
});

describe("team.yaml — utility agents in haiku tier", () => {
  it("feedback-analyst is in utility category", () => {
    expect(team.agents.utility).toContain("feedback-analyst");
  });

  it("experiment-runner is in utility category", () => {
    expect(team.agents.utility).toContain("experiment-runner");
  });

  it("feedback-analyst is in haiku model tier", () => {
    expect(team.model_routing.haiku).toContain("feedback-analyst");
  });

  it("experiment-runner is in haiku model tier", () => {
    expect(team.model_routing.haiku).toContain("experiment-runner");
  });
});

// ---------------------------------------------------------------------------
// Delegation graph correctness
// ---------------------------------------------------------------------------

describe("team.yaml — delegation graph", () => {
  it("vp-research can delegate to ml-engineer", () => {
    expect(team.delegation_graph["vp-research"]).toContain("ml-engineer");
  });

  it("vp-research can delegate to research-scientist", () => {
    expect(team.delegation_graph["vp-research"]).toContain("research-scientist");
  });

  it("vp-research can delegate to experiment-runner", () => {
    expect(team.delegation_graph["vp-research"]).toContain("experiment-runner");
  });

  it("vp-engineering can delegate to engineering-manager-frontend", () => {
    expect(team.delegation_graph["vp-engineering"]).toContain("engineering-manager-frontend");
  });

  it("vp-engineering can delegate to engineering-manager-backend", () => {
    expect(team.delegation_graph["vp-engineering"]).toContain("engineering-manager-backend");
  });

  it("vp-engineering can delegate to engineering-manager-infra", () => {
    expect(team.delegation_graph["vp-engineering"]).toContain("engineering-manager-infra");
  });

  it("vp-engineering delegates to exactly 3 engineering managers", () => {
    expect(team.delegation_graph["vp-engineering"]).toHaveLength(3);
  });
});
