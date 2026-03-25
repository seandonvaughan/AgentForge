// tests/types/reforge-types.test.ts
import { describe, it, expect } from "vitest";
import type {
  ReforgeClass,
  AgentMutation,
  ReforgePlan,
  ReforgeResult,
  AgentOverride,
} from "../../src/types/reforge.js";

describe("reforge types", () => {
  it("AgentMutation captures all required fields", () => {
    const mutation: AgentMutation = {
      type: "model-tier-override",
      agentName: "cost-analyst",
      field: "model",
      oldValue: "opus",
      newValue: "sonnet",
      rationale: "Cost feedback from 3 agents flagged Opus waste on analytical tasks",
    };
    expect(mutation.type).toBe("model-tier-override");
    expect(mutation.oldValue).toBe("opus");
    expect(mutation.newValue).toBe("sonnet");
  });

  it("ReforgePlan contains mutations and classification", () => {
    const plan: ReforgePlan = {
      id: "plan-001",
      timestamp: new Date().toISOString(),
      reforgeClass: "local" as ReforgeClass,
      triggeredBy: "model-routing",
      mutations: [
        {
          type: "model-tier-override",
          agentName: "report-writer",
          field: "model",
          oldValue: "opus",
          newValue: "sonnet",
          rationale: "Report writing does not require Opus",
        },
      ],
      rationale: "Reduce cost by downgrading non-strategic agents",
      estimatedImpact: "~60% cost reduction on report-writer invocations",
    };
    expect(plan.reforgeClass).toBe("local");
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0].type).toBe("model-tier-override");
  });

  it("AgentOverride supports version history via previousVersion", () => {
    const v1: AgentOverride = {
      agentName: "code-reviewer",
      version: 1,
      appliedAt: "2026-03-25T10:00:00.000Z",
      sessionId: "plan-001",
      mutations: [],
      modelTierOverride: "sonnet",
    };
    const v2: AgentOverride = {
      agentName: "code-reviewer",
      version: 2,
      appliedAt: "2026-03-25T11:00:00.000Z",
      sessionId: "plan-002",
      mutations: [],
      modelTierOverride: "haiku",
      previousVersion: v1,
    };
    expect(v2.version).toBe(2);
    expect(v2.previousVersion?.version).toBe(1);
    expect(v2.previousVersion?.modelTierOverride).toBe("sonnet");
  });
});
