import { describe, it, expect } from "vitest";
import type {
  DelegationEdge,
  ConditionalDelegationGraph,
} from "../../src/types/orchestration.js";

describe("v3 orchestration types", () => {
  it("DelegationEdge supports conditions", () => {
    const edge: DelegationEdge = {
      from: "core-platform-lead",
      to: "type-system-designer",
      condition: {
        type: "ledger-state",
        field: "is_in_loop",
        operator: "equals",
        value: false,
      },
    };
    expect(edge.from).toBe("core-platform-lead");
    expect(edge.condition?.type).toBe("ledger-state");
  });

  it("DelegationEdge works without condition (unconditional)", () => {
    const edge: DelegationEdge = {
      from: "cto",
      to: "lead-architect",
    };
    expect(edge.condition).toBeUndefined();
  });

  it("ConditionalDelegationGraph maps agents to edges", () => {
    const graph: ConditionalDelegationGraph = {
      "core-platform-lead": [
        { from: "core-platform-lead", to: "type-system-designer" },
        {
          from: "core-platform-lead",
          to: "scanner-pipeline-designer",
          condition: { type: "confidence", field: "confidence", operator: "less-than", value: 0.5 },
        },
      ],
    };
    expect(graph["core-platform-lead"]).toHaveLength(2);
  });
});
