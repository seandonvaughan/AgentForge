import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENTS_DIR = join(process.cwd(), ".agentforge/agents");

function agentPath(agentId: string): string {
  return join(AGENTS_DIR, `${agentId}.yaml`);
}

interface AgentYaml {
  name: string;
  model: string;
  system_prompt: string;
  skills: string[];
  collaboration: {
    reports_to: string;
    can_delegate_to?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function loadAgent(agentId: string): AgentYaml {
  const raw = readFileSync(agentPath(agentId), "utf-8");
  return parseYaml(raw) as AgentYaml;
}

// ---------------------------------------------------------------------------
// V4.6 agent list
// ---------------------------------------------------------------------------

const V46_AGENTS = [
  "vp-research",
  "vp-engineering",
  "engineering-manager-frontend",
  "engineering-manager-backend",
  "engineering-manager-infra",
  "qa-manager",
  "feedback-analyst",
  "ml-engineer",
  "research-scientist",
  "experiment-runner",
];

// ---------------------------------------------------------------------------
// File existence
// ---------------------------------------------------------------------------

describe("agent YAML files — existence", () => {
  for (const agentId of V46_AGENTS) {
    it(`${agentId}.yaml exists`, () => {
      expect(existsSync(agentPath(agentId))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

describe("agent YAML files — required fields present", () => {
  for (const agentId of V46_AGENTS) {
    it(`${agentId} has a non-empty 'name' field`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.name).toBe("string");
      expect(agent.name.trim().length).toBeGreaterThan(0);
    });

    it(`${agentId} has a 'model' field`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.model).toBe("string");
      expect(["opus", "sonnet", "haiku"]).toContain(agent.model);
    });

    it(`${agentId} has a non-empty 'system_prompt' field`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.system_prompt).toBe("string");
      expect(agent.system_prompt.trim().length).toBeGreaterThan(0);
    });

    it(`${agentId} has a 'skills' array`, () => {
      const agent = loadAgent(agentId);
      expect(Array.isArray(agent.skills)).toBe(true);
      expect(agent.skills.length).toBeGreaterThan(0);
    });

    it(`${agentId} has collaboration.reports_to field`, () => {
      const agent = loadAgent(agentId);
      expect(typeof agent.collaboration).toBe("object");
      expect(typeof agent.collaboration.reports_to).toBe("string");
      expect(agent.collaboration.reports_to.trim().length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Model matches team.yaml routing
// ---------------------------------------------------------------------------

describe("agent YAML files — model matches team.yaml routing", () => {
  it("vp-research model is opus", () => {
    expect(loadAgent("vp-research").model).toBe("opus");
  });

  it("vp-engineering model is opus", () => {
    expect(loadAgent("vp-engineering").model).toBe("opus");
  });

  it("engineering-manager-frontend model is sonnet", () => {
    expect(loadAgent("engineering-manager-frontend").model).toBe("sonnet");
  });

  it("engineering-manager-backend model is sonnet", () => {
    expect(loadAgent("engineering-manager-backend").model).toBe("sonnet");
  });

  it("engineering-manager-infra model is sonnet", () => {
    expect(loadAgent("engineering-manager-infra").model).toBe("sonnet");
  });

  it("qa-manager model is sonnet", () => {
    expect(loadAgent("qa-manager").model).toBe("sonnet");
  });

  it("feedback-analyst model is haiku", () => {
    expect(loadAgent("feedback-analyst").model).toBe("haiku");
  });

  it("ml-engineer model is sonnet", () => {
    expect(loadAgent("ml-engineer").model).toBe("sonnet");
  });

  it("research-scientist model is sonnet", () => {
    expect(loadAgent("research-scientist").model).toBe("sonnet");
  });

  it("experiment-runner model is haiku", () => {
    expect(loadAgent("experiment-runner").model).toBe("haiku");
  });
});

// ---------------------------------------------------------------------------
// Reports-to correctness
// ---------------------------------------------------------------------------

describe("agent YAML files — reports_to chain", () => {
  it("vp-research reports_to cto", () => {
    expect(loadAgent("vp-research").collaboration.reports_to).toBe("cto");
  });

  it("vp-engineering reports_to cto", () => {
    expect(loadAgent("vp-engineering").collaboration.reports_to).toBe("cto");
  });

  it("engineering-manager-frontend reports_to vp-engineering", () => {
    expect(loadAgent("engineering-manager-frontend").collaboration.reports_to).toBe("vp-engineering");
  });

  it("engineering-manager-backend reports_to vp-engineering", () => {
    expect(loadAgent("engineering-manager-backend").collaboration.reports_to).toBe("vp-engineering");
  });

  it("engineering-manager-infra reports_to vp-engineering", () => {
    expect(loadAgent("engineering-manager-infra").collaboration.reports_to).toBe("vp-engineering");
  });

  it("ml-engineer reports_to vp-research", () => {
    expect(loadAgent("ml-engineer").collaboration.reports_to).toBe("vp-research");
  });

  it("research-scientist reports_to vp-research", () => {
    expect(loadAgent("research-scientist").collaboration.reports_to).toBe("vp-research");
  });

  it("experiment-runner reports_to vp-research", () => {
    expect(loadAgent("experiment-runner").collaboration.reports_to).toBe("vp-research");
  });
});

// ---------------------------------------------------------------------------
// can_delegate_to agents actually exist as YAML files
// ---------------------------------------------------------------------------

describe("agent YAML files — can_delegate_to targets exist", () => {
  it("vp-research delegates to existing agents (ml-engineer, research-scientist, experiment-runner)", () => {
    const agent = loadAgent("vp-research");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("vp-engineering delegates to existing agents (engineering-manager-*)", () => {
    const agent = loadAgent("vp-engineering");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    expect(delegates.length).toBeGreaterThan(0);
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("engineering-manager-frontend delegates to existing agents", () => {
    const agent = loadAgent("engineering-manager-frontend");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("engineering-manager-backend delegates to existing agents", () => {
    const agent = loadAgent("engineering-manager-backend");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("engineering-manager-infra delegates to existing agents", () => {
    const agent = loadAgent("engineering-manager-infra");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("qa-manager delegates to existing agents (team-reviewer, debugger, linter)", () => {
    const agent = loadAgent("qa-manager");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("ml-engineer delegates to existing agents", () => {
    const agent = loadAgent("ml-engineer");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });

  it("research-scientist delegates to existing agents", () => {
    const agent = loadAgent("research-scientist");
    const delegates = agent.collaboration.can_delegate_to ?? [];
    for (const d of delegates) {
      expect(existsSync(agentPath(d)), `Expected ${d}.yaml to exist`).toBe(true);
    }
  });
});
