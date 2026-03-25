import { describe, it, expect } from "vitest";
import { selectTopology } from "../../src/collaboration/topology-selector.js";
import type { ProjectBrief } from "../../src/types/analysis.js";
import type { DomainId } from "../../src/types/domain.js";

/**
 * Helper to build a minimal ProjectBrief for testing.
 */
function makeBrief(overrides: {
  domains?: DomainId[];
  constraints?: Record<string, string>;
} = {}): ProjectBrief {
  return {
    project: { name: "Test", type: "saas", stage: "early" },
    goals: { primary: "Test project", secondary: [] },
    domains: overrides.domains ?? ["software"],
    constraints: overrides.constraints ?? {},
    context: {},
  };
}

describe("selectTopology", () => {
  it("returns 'flat' for a single domain with <= 5 agents", () => {
    const brief = makeBrief({ domains: ["software"] });
    expect(selectTopology(brief, ["software"], 3)).toBe("flat");
    expect(selectTopology(brief, ["software"], 5)).toBe("flat");
    expect(selectTopology(brief, ["software"], 1)).toBe("flat");
  });

  it("returns 'hierarchy' for a single domain with > 5 agents", () => {
    const brief = makeBrief({ domains: ["software"] });
    expect(selectTopology(brief, ["software"], 6)).toBe("hierarchy");
    expect(selectTopology(brief, ["software"], 10)).toBe("hierarchy");
  });

  it("returns 'hub-and-spoke' for multiple domains", () => {
    const brief = makeBrief({ domains: ["software", "marketing"] });
    expect(selectTopology(brief, ["software", "marketing"], 8)).toBe(
      "hub-and-spoke",
    );
  });

  it("returns 'hub-and-spoke' for three or more domains", () => {
    const brief = makeBrief({
      domains: ["software", "marketing", "research"],
    });
    expect(
      selectTopology(brief, ["software", "marketing", "research"], 12),
    ).toBe("hub-and-spoke");
  });

  it("returns 'matrix' for cross-functional with dual-reporting constraint", () => {
    const brief = makeBrief({
      domains: ["software", "marketing"],
      constraints: { reporting: "dual" },
    });
    expect(selectTopology(brief, ["software", "marketing"], 8)).toBe("matrix");
  });

  it("returns 'hierarchy' when user specifies corporate structure constraint", () => {
    const brief = makeBrief({
      domains: ["software"],
      constraints: { structure: "corporate" },
    });
    expect(selectTopology(brief, ["software"], 3)).toBe("hierarchy");
  });

  it("uses agent count boundary correctly at exactly 5", () => {
    const brief = makeBrief({ domains: ["core"] });
    expect(selectTopology(brief, ["core"], 5)).toBe("flat");
  });

  it("uses agent count boundary correctly at exactly 6", () => {
    const brief = makeBrief({ domains: ["core"] });
    expect(selectTopology(brief, ["core"], 6)).toBe("hierarchy");
  });
});
