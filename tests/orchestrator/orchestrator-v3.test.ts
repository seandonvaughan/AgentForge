/**
 * Tests for OrchestratorV3 — the integration point that wires the cost stack
 * and intelligence layer together.
 *
 * External I/O (runAgent, ReforgeEngine disk writes, SessionStore disk writes,
 * FeedbackCollector disk reads) is mocked to keep tests fast and hermetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRunResult } from "../../src/api/agent-runner.js";

// ── Mock the heavy I/O boundaries ────────────────────────────────────────────

vi.mock("../../src/api/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/reforge/reforge-engine.js", () => ({
  ReforgeEngine: vi.fn(function () {
    return {
      applyOverride: vi.fn(async (t) => t),
      buildPlan: vi.fn(async () => ({
        id: "plan-1",
        timestamp: new Date().toISOString(),
        reforgeClass: "local",
        triggeredBy: "test-theme",
        mutations: [],
        rationale: "test",
        estimatedImpact: "none",
      })),
      executePlan: vi.fn(async (plan) => ({
        plan,
        applied: true,
        appliedMutations: [],
        skippedMutations: [],
        version: 1,
        rollbackAvailable: false,
      })),
    };
  }),
}));

vi.mock("../../src/orchestrator/session-store.js", () => ({
  SessionStore: vi.fn(function () {
    return {
      saveSnapshot: vi.fn(async () => {}),
      loadLatest: vi.fn(async () => null),
      loadAllSnapshots: vi.fn(async () => []),
    };
  }),
}));

vi.mock("../../src/feedback/feedback-collector.js", () => ({
  FeedbackCollector: vi.fn(function () {
    return {
      loadAllFeedback: vi.fn(async () => []),
    };
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { runAgent } from "../../src/api/agent-runner.js";
import { OrchestratorV3 } from "../../src/orchestrator/orchestrator-v3.js";
import type { OrchestratorV3Config } from "../../src/orchestrator/orchestrator-v3.js";
import { BudgetEnvelope } from "../../src/budget/budget-envelope.js";
import { ReforgeEngine } from "../../src/reforge/reforge-engine.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type {
  ProgressLedger,
  ConditionalDelegationGraph,
} from "../../src/types/orchestration.js";
import type { AgentFeedback } from "../../src/types/feedback.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    name: "coder",
    model: "haiku",
    version: "1.0.0",
    description: "Writes code",
    system_prompt: "You write code.",
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 0, auto_include: [], project_specific: [] },
    category: "utility",
    ...overrides,
  };
}

function makeRunResult(response = "done", input = 50, output = 30): AgentRunResult {
  return {
    agent: "coder",
    model: "haiku",
    response,
    inputTokens: input,
    outputTokens: output,
    duration_ms: 10,
    delegations: [],
  };
}

const DEFAULT_CONFIG: OrchestratorV3Config = {
  projectRoot: "/tmp/agentforge-test",
  sessionBudgetUsd: 10,
  enableReforge: true,
  enableCostAwareRouting: true,
  enableReviewEnforcement: true,
};

function makeLedger(overrides: Partial<ProgressLedger> = {}): ProgressLedger {
  return {
    task_id: "task-1",
    objective: "test objective",
    facts: { given: [], to_look_up: [], to_derive: [], educated_guesses: [] },
    plan: [],
    steps_completed: [],
    current_step: null,
    is_request_satisfied: false,
    is_in_loop: false,
    is_progress_being_made: true,
    confidence: 0.9,
    next_speaker: "coder",
    instruction: "do work",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("OrchestratorV3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  it("constructs without throwing and exposes config", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    expect(v3).toBeInstanceOf(OrchestratorV3);
  });

  it("creates all subsystems on construction", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    // Subsystems are private but we can verify they were instantiated via mocks
    expect(ReforgeEngine).toHaveBeenCalledWith(DEFAULT_CONFIG.projectRoot, undefined);
  });

  // ── runAgent ─────────────────────────────────────────────────────────────

  it("runAgent returns a CostAwareRunResult with content", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("hello world"));

    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const agent = makeAgent();

    const result = await v3.runAgent(agent, "do work");
    expect(result.content).toBe("hello world");
  });

  it("runAgent calls ReforgeEngine.applyOverride when enableReforge=true", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReforge: true });
    const agent = makeAgent();

    // Get the mocked instance
    const reforgeInstance = vi.mocked(ReforgeEngine).mock.results[0].value as {
      applyOverride: ReturnType<typeof vi.fn>;
    };

    await v3.runAgent(agent, "do some work");
    expect(reforgeInstance.applyOverride).toHaveBeenCalledWith(agent);
  });

  it("runAgent skips ReforgeEngine.applyOverride when enableReforge=false", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReforge: false });
    const agent = makeAgent();

    const reforgeInstance = vi.mocked(ReforgeEngine).mock.results[0].value as {
      applyOverride: ReturnType<typeof vi.fn>;
    };

    await v3.runAgent(agent, "do some work");
    expect(reforgeInstance.applyOverride).not.toHaveBeenCalled();
  });

  it("runAgent enforces review for strategic agents when enableReviewEnforcement=true", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("strategic output"));

    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReviewEnforcement: true });
    const strategicAgent = makeAgent({ name: "architect", category: "strategic" });

    const result = await v3.runAgent(strategicAgent, "make a plan", {
      reviewers: ["reviewer-agent"],
    });

    // Strategic agent with reviewers — review is blocked, escalated signal present
    expect(result).toBeDefined();
    expect(result.reviewDecision).toBeDefined();
    expect(result.reviewDecision!.approved).toBe(false);
    expect(result.reviewDecision!.reviewerName).toBe("reviewer-agent");
  });

  it("runAgent auto-approves non-strategic agents regardless of review config", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("code output"));

    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReviewEnforcement: true });
    const utilityAgent = makeAgent({ category: "utility" });

    const result = await v3.runAgent(utilityAgent, "format code", {
      reviewers: ["reviewer"],
    });

    expect(result.reviewDecision).toBeDefined();
    expect(result.reviewDecision!.approved).toBe(true);
  });

  it("runAgent saves a session snapshot after execution", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const { SessionStore } = await import("../../src/orchestrator/session-store.js");

    const v3 = new OrchestratorV3(DEFAULT_CONFIG);

    // The instance is created during OrchestratorV3 constructor — grab the last result
    const results = vi.mocked(SessionStore).mock.results;
    const sessionInstance = results[results.length - 1].value as {
      saveSnapshot: ReturnType<typeof vi.fn>;
    };

    await v3.runAgent(makeAgent(), "work task");

    expect(sessionInstance.saveSnapshot).toHaveBeenCalled();
  });

  // ── getSessionCostReport ─────────────────────────────────────────────────

  it("getSessionCostReport returns correct initial values", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const report = v3.getSessionCostReport();

    expect(report.totalSpentUsd).toBe(0);
    expect(report.remainingBudgetUsd).toBe(DEFAULT_CONFIG.sessionBudgetUsd);
    expect(report.agentBreakdown).toEqual({});
  });

  it("getSessionCostReport accumulates spend across multiple runAgent calls", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok", 100_000, 50_000));

    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const agent = makeAgent();

    await v3.runAgent(agent, "task 1");
    await v3.runAgent(agent, "task 2");

    const report = v3.getSessionCostReport();
    expect(report.totalSpentUsd).toBeGreaterThan(0);
    expect(report.remainingBudgetUsd).toBeLessThan(DEFAULT_CONFIG.sessionBudgetUsd);
  });

  // ── analyzeSession ───────────────────────────────────────────────────────

  it("analyzeSession returns an analysis object with required fields", async () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const { analysis } = await v3.analyzeSession();

    expect(analysis).toHaveProperty("analyzed_at");
    expect(analysis).toHaveProperty("themes");
    expect(analysis).toHaveProperty("recommended_actions");
    expect(analysis).toHaveProperty("requires_escalation");
  });

  it("analyzeSession builds a ReforgePlan when enableReforge=true and there are actions", async () => {
    // Inject feedback that will produce recommended actions
    const { FeedbackCollector } = await import("../../src/feedback/feedback-collector.js");

    const mockFeedback: AgentFeedback[] = [
      {
        id: "f1",
        agent: "agent-a",
        category: "cost",
        priority: "high",
        title: "Opus model used for routing tasks",
        description: "The opus model was used for simple routing which is expensive",
        suggestion: "Switch routing agents to haiku tier to reduce cost",
        context: {},
        timestamp: new Date().toISOString(),
      },
      {
        id: "f2",
        agent: "agent-b",
        category: "cost",
        priority: "high",
        title: "Model routing tier too high",
        description: "Sonnet and opus used for tasks that haiku could handle",
        suggestion: "Adjust model routing to use cheaper tiers",
        context: {},
        timestamp: new Date().toISOString(),
      },
    ];

    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReforge: true });

    // Grab the instances created during construction
    const collectorResults = vi.mocked(FeedbackCollector).mock.results;
    const collectorInstance = collectorResults[collectorResults.length - 1].value as {
      loadAllFeedback: ReturnType<typeof vi.fn>;
    };
    collectorInstance.loadAllFeedback.mockResolvedValue(mockFeedback);

    const reforgeResults = vi.mocked(ReforgeEngine).mock.results;
    const reforgeInstance = reforgeResults[reforgeResults.length - 1].value as {
      buildPlan: ReturnType<typeof vi.fn>;
      executePlan: ReturnType<typeof vi.fn>;
    };
    const { analysis, reforgePlan } = await v3.analyzeSession();

    expect(analysis.total_entries).toBe(2);
    // If there are recommended actions, reforge should build a plan
    if (analysis.recommended_actions.length > 0) {
      expect(reforgeInstance.buildPlan).toHaveBeenCalledWith(
        analysis,
        expect.any(Array),
      );
      expect(reforgePlan).toBeDefined();
    }
  });

  it("analyzeSession skips ReforgePlan when enableReforge=false", async () => {
    const v3 = new OrchestratorV3({ ...DEFAULT_CONFIG, enableReforge: false });

    const reforgeResults = vi.mocked(ReforgeEngine).mock.results;
    const reforgeInstance = reforgeResults[reforgeResults.length - 1].value as {
      buildPlan: ReturnType<typeof vi.fn>;
    };
    const { reforgePlan } = await v3.analyzeSession();

    expect(reforgeInstance.buildPlan).not.toHaveBeenCalled();
    expect(reforgePlan).toBeUndefined();
  });

  // ── selectNextSpeaker ────────────────────────────────────────────────────

  it("selectNextSpeaker delegates to SpeakerSelector and returns next speaker", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const ledger = makeLedger({ next_speaker: "coder" });
    const graph: ConditionalDelegationGraph = {
      coder: [{ from: "coder", to: "reviewer" }],
    };
    const agents = [makeAgent({ name: "coder" }), makeAgent({ name: "reviewer" })];

    const next = v3.selectNextSpeaker(ledger, graph, agents);
    // Unconditional edge from coder → reviewer
    expect(next).toBe("reviewer");
  });

  it("selectNextSpeaker returns null when ledger has no next_speaker", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const ledger = makeLedger({ next_speaker: null });
    const graph: ConditionalDelegationGraph = {};
    const agents: AgentTemplate[] = [];

    expect(v3.selectNextSpeaker(ledger, graph, agents)).toBeNull();
  });

  it("selectNextSpeaker falls back to current speaker when no edge matches", () => {
    const v3 = new OrchestratorV3(DEFAULT_CONFIG);
    const ledger = makeLedger({ next_speaker: "coder" });
    const graph: ConditionalDelegationGraph = {};
    const agents = [makeAgent({ name: "coder" })];

    // No edges in graph — should return current speaker
    expect(v3.selectNextSpeaker(ledger, graph, agents)).toBe("coder");
  });

  // ── Budget enforcement ───────────────────────────────────────────────────

  it("runAgent throws when session budget is exhausted", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    // Tiny budget that will be exhausted immediately
    const v3 = new OrchestratorV3({
      ...DEFAULT_CONFIG,
      sessionBudgetUsd: 0.000001,
    });

    const agent = makeAgent();
    // Drain the budget first
    const envelope = (v3 as unknown as { budgetEnvelope: BudgetEnvelope }).budgetEnvelope;
    envelope.recordActual(0.000001);

    await expect(v3.runAgent(agent, "task")).rejects.toThrow(/budget/i);
  });
});
