// tests/orchestrator/speaker-selector.test.ts
import { describe, it, expect } from "vitest";
import { SpeakerSelector } from "../../src/orchestrator/speaker-selector.js";
import type { ProgressLedger, ConditionalDelegationGraph } from "../../src/types/orchestration.js";
import type { AgentTemplate } from "../../src/types/agent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLedger(overrides: Partial<ProgressLedger> = {}): ProgressLedger {
  return {
    task_id: "task-001",
    objective: "Build feature X",
    facts: {
      given: [],
      to_look_up: [],
      to_derive: [],
      educated_guesses: [],
    },
    plan: ["analyze", "implement", "review"],
    steps_completed: [],
    current_step: null,
    is_request_satisfied: false,
    is_in_loop: false,
    is_progress_being_made: true,
    confidence: 0.8,
    next_speaker: "architect",
    instruction: "Begin analysis",
    ...overrides,
  };
}

function makeAgent(name: string, category: AgentTemplate["category"] = "implementation"): AgentTemplate {
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

describe("SpeakerSelector", () => {
  const selector = new SpeakerSelector();

  it("returns ledger.next_speaker when no conditional edges match", () => {
    const ledger = makeLedger({ next_speaker: "architect" });
    const graph: ConditionalDelegationGraph = {};
    const agents = [makeAgent("architect"), makeAgent("developer")];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBe("architect");
  });

  it("returns null when ledger.next_speaker is null and no edges match", () => {
    const ledger = makeLedger({ next_speaker: null });
    const graph: ConditionalDelegationGraph = {};
    const agents = [makeAgent("architect")];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBeNull();
  });

  it("evaluates equals condition and routes to matching edge target", () => {
    const ledger = makeLedger({
      next_speaker: "architect",
      is_in_loop: false,
      confidence: 0.9,
    });
    const graph: ConditionalDelegationGraph = {
      architect: [
        {
          from: "architect",
          to: "reviewer",
          condition: {
            type: "ledger-state",
            field: "is_in_loop",
            operator: "equals",
            value: false,
          },
        },
      ],
    };
    const agents = [makeAgent("architect"), makeAgent("reviewer")];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBe("reviewer");
  });

  it("skips non-matching condition and falls back to ledger.next_speaker", () => {
    const ledger = makeLedger({
      next_speaker: "architect",
      confidence: 0.5,
    });
    const graph: ConditionalDelegationGraph = {
      architect: [
        {
          from: "architect",
          to: "reviewer",
          condition: {
            type: "confidence",
            field: "confidence",
            operator: "greater-than",
            value: 0.8,
          },
        },
      ],
    };
    const agents = [makeAgent("architect"), makeAgent("reviewer")];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBe("architect");
  });

  it("evaluates contains condition against string fields", () => {
    const ledger = makeLedger({
      next_speaker: "implementer",
      current_step: "implement authentication",
    });
    const graph: ConditionalDelegationGraph = {
      implementer: [
        {
          from: "implementer",
          to: "security-reviewer",
          condition: {
            type: "ledger-state",
            field: "current_step",
            operator: "contains",
            value: "authentication",
          },
        },
      ],
    };
    const agents = [makeAgent("implementer"), makeAgent("security-reviewer")];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBe("security-reviewer");
  });

  it("returns first matching edge when multiple edges exist", () => {
    const ledger = makeLedger({
      next_speaker: "architect",
      is_request_satisfied: true,
      confidence: 0.95,
    });
    const graph: ConditionalDelegationGraph = {
      architect: [
        {
          from: "architect",
          to: "done-agent",
          condition: {
            type: "ledger-state",
            field: "is_request_satisfied",
            operator: "equals",
            value: true,
          },
        },
        {
          from: "architect",
          to: "other-agent",
          condition: {
            type: "confidence",
            field: "confidence",
            operator: "greater-than",
            value: 0.9,
          },
        },
      ],
    };
    const agents = [
      makeAgent("architect"),
      makeAgent("done-agent"),
      makeAgent("other-agent"),
    ];

    const result = selector.selectNextSpeaker(ledger, graph, agents);
    expect(result).toBe("done-agent");
  });
});
