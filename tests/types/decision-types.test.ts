import { describe, it, expect } from "vitest";
import type { DecisionType, DecisionEntry } from "../../src/types/decision.js";

describe("Decision types", () => {
  it("DecisionType accepts all valid values", () => {
    const types: DecisionType[] = [
      "routing",
      "delegation",
      "reforge",
      "escalation",
      "budget",
      "review",
    ];
    expect(types).toHaveLength(6);
  });

  it("DecisionEntry has required fields", () => {
    const entry: DecisionEntry = {
      id: "test-id",
      type: "routing",
      timestamp: "2026-03-25T00:00:00.000Z",
      agent: "cost-tracker-dev",
      description: "Routed to haiku tier",
      alternatives: ["sonnet", "opus"],
      rationale: "Low complexity score",
      artifacts: [],
      confidence: 0.9,
    };
    expect(entry.type).toBe("routing");
    expect(entry.sessionId).toBeUndefined();
  });

  it("DecisionEntry accepts optional sessionId", () => {
    const entry: DecisionEntry = {
      id: "test-id",
      type: "reforge",
      timestamp: "2026-03-25T00:00:00.000Z",
      agent: "reforge-engine",
      description: "Applied prompt preamble",
      alternatives: [],
      rationale: "Feedback analysis",
      artifacts: [{ type: "override", location: ".agentforge/agent-overrides/test.json" }],
      confidence: 0.8,
      sessionId: "session-123",
    };
    expect(entry.sessionId).toBe("session-123");
    expect(entry.artifacts).toHaveLength(1);
  });

  it("DecisionEntry artifacts support various types", () => {
    const entry: DecisionEntry = {
      id: "test",
      type: "delegation",
      timestamp: "",
      agent: "cto",
      description: "Delegated to lead",
      alternatives: [],
      rationale: "Type system task",
      artifacts: [
        { type: "override", location: ".agentforge/agent-overrides/foo.json" },
        { type: "proposal", location: ".agentforge/reforge-proposals/bar.md" },
        { type: "file", location: "src/types/agent.ts" },
      ],
      confidence: 0.95,
    };
    expect(entry.artifacts).toHaveLength(3);
  });
});
