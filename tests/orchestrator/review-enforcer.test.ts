// tests/orchestrator/review-enforcer.test.ts
import { describe, it, expect } from "vitest";
import { ReviewEnforcer } from "../../src/orchestrator/review-enforcer.js";
import type { AgentTemplate } from "../../src/types/agent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(
  name: string,
  category: AgentTemplate["category"] = "implementation",
): AgentTemplate {
  return {
    name,
    model: "sonnet",
    version: "1.0.0",
    description: `${name} agent`,
    system_prompt: `You are ${name}.`,
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 10, auto_include: [], project_specific: [] },
    category,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewEnforcer", () => {
  const enforcer = new ReviewEnforcer();

  it("auto-approves output from non-strategic agents", async () => {
    const agent = makeAgent("code-writer", "implementation");
    const decision = await enforcer.enforceReview(
      "Here is my implementation.",
      agent,
      ["tech-lead"],
    );

    expect(decision.approved).toBe(true);
    expect(decision.reviewerName).toBeUndefined();
    expect(decision.feedback).toBeUndefined();
  });

  it("blocks strategic agent output and assigns a reviewer", async () => {
    const agent = makeAgent("architecture-lead", "strategic");
    const decision = await enforcer.enforceReview(
      "My architectural recommendation is to adopt microservices.",
      agent,
      ["cto", "tech-lead"],
    );

    expect(decision.approved).toBe(false);
    expect(decision.reviewerName).toBe("cto");
  });

  it("returns first reviewer from list for strategic agents", async () => {
    const agent = makeAgent("strategy-agent", "strategic");
    const decision = await enforcer.enforceReview(
      "Strategic output text.",
      agent,
      ["reviewer-a", "reviewer-b"],
    );

    expect(decision.reviewerName).toBe("reviewer-a");
  });

  it("auto-approves strategic agent when reviewer list is empty", async () => {
    const agent = makeAgent("strategy-agent", "strategic");
    const decision = await enforcer.enforceReview(
      "Strategic output with no reviewers.",
      agent,
      [],
    );

    expect(decision.approved).toBe(true);
    expect(decision.reviewerName).toBeUndefined();
  });

  it("auto-approves utility agents without reviewers", async () => {
    const agent = makeAgent("file-writer", "utility");
    const decision = await enforcer.enforceReview(
      "File written successfully.",
      agent,
      ["any-reviewer"],
    );

    expect(decision.approved).toBe(true);
  });
});
