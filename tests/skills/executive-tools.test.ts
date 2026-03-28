import { describe, it, expect } from "vitest";
import { CeoToolSuite } from "../../src/skills/executive-tools/ceo-tools.js";
import { CtoToolSuite } from "../../src/skills/executive-tools/cto-tools.js";
import { CooToolSuite } from "../../src/skills/executive-tools/coo-tools.js";
import { CfoToolSuite } from "../../src/skills/executive-tools/cfo-tools.js";
import { VpEngToolSuite } from "../../src/skills/executive-tools/vp-eng-tools.js";
import {
  checkAuthorization,
  ExecutiveToolError,
} from "../../src/skills/executive-tools/base-tool-suite.js";
import type { AgentIdentity } from "../../src/types/lifecycle.js";
import type { ExecutiveToolPermission } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCeo(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "ceo",
    name: "CEO",
    role: "executive",
    seniority: "principal",
    layer: "executive",
    teamId: "executive-team",
    model: "opus",
    status: "active",
    hiredAt: new Date().toISOString(),
    currentTasks: [],
    maxConcurrentTasks: 2,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    id: "generic-agent",
    name: "Generic Agent",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CeoToolSuite", () => {
  const suite = new CeoToolSuite();

  it("getTools() returns exactly 8 tools", () => {
    expect(suite.getTools()).toHaveLength(8);
  });

  it("contains all expected CEO tool names", () => {
    const names = suite.getTools().map((t) => t.name);
    expect(names).toContain("createSprint");
    expect(names).toContain("approveSprint");
    expect(names).toContain("setOKRs");
    expect(names).toContain("approveBudget");
    expect(names).toContain("hireApproval");
    expect(names).toContain("fireAgent");
    expect(names).toContain("strategicDecision");
    expect(names).toContain("requestStatusBrief");
  });

  it("all tools have non-empty descriptions", () => {
    for (const tool of suite.getTools()) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("all tools have a permission with requiredRole 'executive'", () => {
    for (const tool of suite.getTools()) {
      expect(tool.permission.requiredRole).toBe("executive");
    }
  });
});

describe("CtoToolSuite", () => {
  const suite = new CtoToolSuite();

  it("getTools() returns exactly 7 tools", () => {
    expect(suite.getTools()).toHaveLength(7);
  });

  it("contains all expected CTO tool names", () => {
    const names = suite.getTools().map((t) => t.name);
    expect(names).toContain("defineStandard");
    expect(names).toContain("approveArchitecture");
    expect(names).toContain("triggerTechDebt");
    expect(names).toContain("technologyDecision");
    expect(names).toContain("requestHire");
    expect(names).toContain("promoteTechLead");
    expect(names).toContain("assignTechPlan");
  });

  it("all tools have a permission with requiredRole 'executive'", () => {
    for (const tool of suite.getTools()) {
      expect(tool.permission.requiredRole).toBe("executive");
    }
  });
});

describe("CooToolSuite", () => {
  const suite = new CooToolSuite();

  it("getTools() returns exactly 7 tools", () => {
    expect(suite.getTools()).toHaveLength(7);
  });

  it("contains all expected COO tool names", () => {
    const names = suite.getTools().map((t) => t.name);
    expect(names).toContain("assignTask");
    expect(names).toContain("reassignTask");
    expect(names).toContain("reassignAgent");
    expect(names).toContain("trackVelocity");
    expect(names).toContain("identifyBlockers");
    expect(names).toContain("escalateBlocker");
    expect(names).toContain("createOperationalPlan");
  });
});

describe("CfoToolSuite", () => {
  const suite = new CfoToolSuite();

  it("getTools() returns exactly 5 tools", () => {
    expect(suite.getTools()).toHaveLength(5);
  });

  it("contains all expected CFO tool names", () => {
    const names = suite.getTools().map((t) => t.name);
    expect(names).toContain("analyzeBudget");
    expect(names).toContain("projectCosts");
    expect(names).toContain("costAlert");
    expect(names).toContain("roiAnalysis");
    expect(names).toContain("budgetRequest");
  });

  it("all tools are in the 'financial' category", () => {
    for (const tool of suite.getTools()) {
      expect(tool.category).toBe("financial");
    }
  });
});

describe("VpEngToolSuite", () => {
  const suite = new VpEngToolSuite();

  it("getTools() returns exactly 5 tools", () => {
    expect(suite.getTools()).toHaveLength(5);
  });

  it("contains all expected VP Engineering tool names", () => {
    const names = suite.getTools().map((t) => t.name);
    expect(names).toContain("distributeWork");
    expect(names).toContain("crossTeamSync");
    expect(names).toContain("resolveConflict");
    expect(names).toContain("performanceReview");
    expect(names).toContain("requestTraining");
  });

  it("all tools have a permission with requiredRole 'manager'", () => {
    for (const tool of suite.getTools()) {
      expect(tool.permission.requiredRole).toBe("manager");
    }
  });
});

// ---------------------------------------------------------------------------
// checkAuthorization()
// ---------------------------------------------------------------------------

describe("checkAuthorization()", () => {
  describe("CEO tool access", () => {
    const ceoPermission: ExecutiveToolPermission = {
      requiredRole: "executive",
      requiredAgentId: "ceo",
      minSeniority: "principal",
    };

    it("allows the CEO agent to access CEO tools", () => {
      const ceo = makeCeo({ id: "ceo" });
      expect(() => checkAuthorization(ceo, ceoPermission)).not.toThrow();
    });

    it("denies access when agent ID does not match requiredAgentId", () => {
      const notCeo = makeCeo({ id: "cto" });

      expect(() => checkAuthorization(notCeo, ceoPermission)).toThrow(
        ExecutiveToolError,
      );
    });

    it("denies access when role does not match requiredRole", () => {
      const wrongRole = makeCeo({ id: "ceo", role: "specialist" });

      expect(() => checkAuthorization(wrongRole, ceoPermission)).toThrow(
        ExecutiveToolError,
      );
    });

    it("denies access when seniority is below the minimum", () => {
      // seniority "mid" is below "principal"
      const juniorCeo = makeCeo({ id: "ceo", seniority: "mid" });

      expect(() => checkAuthorization(juniorCeo, ceoPermission)).toThrow(
        ExecutiveToolError,
      );
    });

    it("denies access with 'junior' seniority", () => {
      const juniorCeo = makeCeo({ id: "ceo", seniority: "junior" });

      expect(() => checkAuthorization(juniorCeo, ceoPermission)).toThrow(
        ExecutiveToolError,
      );
    });
  });

  describe("COO tool access", () => {
    const cooPermission: ExecutiveToolPermission = {
      requiredRole: "executive",
      requiredAgentId: "coo",
      minSeniority: "lead",
    };

    it("allows a 'lead' seniority COO to access COO tools", () => {
      const coo = makeAgent({
        id: "coo",
        role: "executive",
        seniority: "lead",
      });
      expect(() => checkAuthorization(coo, cooPermission)).not.toThrow();
    });

    it("allows a 'principal' seniority agent to satisfy a 'lead' minimum", () => {
      const principalCoo = makeAgent({
        id: "coo",
        role: "executive",
        seniority: "principal",
      });
      expect(() => checkAuthorization(principalCoo, cooPermission)).not.toThrow();
    });

    it("denies access when seniority is 'mid' (below 'lead' minimum)", () => {
      const midCoo = makeAgent({
        id: "coo",
        role: "executive",
        seniority: "mid",
      });
      expect(() => checkAuthorization(midCoo, cooPermission)).toThrow(
        ExecutiveToolError,
      );
    });
  });

  describe("insufficient seniority", () => {
    const seniorPermission: ExecutiveToolPermission = {
      requiredRole: "specialist",
      minSeniority: "senior",
    };

    it("denies 'junior' seniority when 'senior' is required", () => {
      const juniorAgent = makeAgent({ role: "specialist", seniority: "junior" });

      expect(() => checkAuthorization(juniorAgent, seniorPermission)).toThrow(
        ExecutiveToolError,
      );
    });

    it("allows 'senior' seniority when 'senior' is required", () => {
      const seniorAgent = makeAgent({ role: "specialist", seniority: "senior" });

      expect(() => checkAuthorization(seniorAgent, seniorPermission)).not.toThrow();
    });

    it("allows 'lead' seniority when 'senior' is required (senior is lower than lead)", () => {
      const leadAgent = makeAgent({ role: "specialist", seniority: "lead" });

      expect(() => checkAuthorization(leadAgent, seniorPermission)).not.toThrow();
    });

    it("allows 'principal' seniority when 'mid' is required", () => {
      const principalAgent = makeAgent({ role: "specialist", seniority: "principal" });
      const midPermission: ExecutiveToolPermission = {
        requiredRole: "specialist",
        minSeniority: "mid",
      };

      expect(() => checkAuthorization(principalAgent, midPermission)).not.toThrow();
    });
  });

  describe("ExecutiveToolError structure", () => {
    it("is an instance of Error", () => {
      const err = new ExecutiveToolError("myTool", "agent-001", "test reason");
      expect(err).toBeInstanceOf(Error);
    });

    it("has name 'ExecutiveToolError'", () => {
      const err = new ExecutiveToolError("myTool", "agent-001", "test reason");
      expect(err.name).toBe("ExecutiveToolError");
    });

    it("exposes the tool, agentId, and reason properties", () => {
      const err = new ExecutiveToolError("createSprint", "agent-003", "not authorized");
      expect(err.tool).toBe("createSprint");
      expect(err.agentId).toBe("agent-003");
      expect(err.reason).toBe("not authorized");
    });
  });
});
