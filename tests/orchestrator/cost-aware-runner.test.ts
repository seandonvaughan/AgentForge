import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRunResult } from "../../src/api/agent-runner.js";

vi.mock("../../src/api/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "../../src/api/agent-runner.js";
import { runCostAware } from "../../src/orchestrator/cost-aware-runner.js";
import { BudgetEnvelope } from "../../src/budget/budget-envelope.js";
import type { AgentTemplate } from "../../src/types/agent.js";

const mockAgent: AgentTemplate = {
  name: "test-agent",
  model: "haiku",
  version: "1.0.0",
  description: "test",
  system_prompt: "You are a test agent.",
  skills: [],
  triggers: { file_patterns: [], keywords: [] },
  collaboration: { reports_to: null, reviews_from: [], can_delegate_to: [], parallel: false },
  context: { max_files: 0, auto_include: [], project_specific: [] },
  category: "utility",
};

const makeRunResult = (response = "done", input = 50, output = 30): AgentRunResult => ({
  agent: "test-agent",
  model: "haiku",
  response,
  inputTokens: input,
  outputTokens: output,
  duration_ms: 10,
  delegations: [],
});

describe("runCostAware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the agent and returns content when budget allows", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("result text"));

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({
      agent: mockAgent,
      task: "do some work",
      envelope,
    });

    expect(result.content).toBe("result text");
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(30);
  });

  it("blocks execution when budget is exhausted", async () => {
    const envelope = new BudgetEnvelope(0.000001);
    envelope.recordActual(0.000001); // exhaust budget

    await expect(
      runCostAware({ agent: mockAgent, task: "expensive task", envelope }),
    ).rejects.toThrow(/budget/i);

    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it("records actual spend into envelope after run", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok", 1_000_000, 500_000));

    const envelope = new BudgetEnvelope(1000);
    await runCostAware({ agent: mockAgent, task: "work", envelope });

    const report = envelope.getSpendReport();
    expect(report.totalSpentUsd).toBeGreaterThan(0);
  });

  it("returns routingDecision with assigned tier", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({ agent: mockAgent, task: "simple task", envelope });

    expect(result.routingDecision).toBeDefined();
    expect(["haiku", "sonnet", "opus"]).toContain(result.routingDecision.assignedTier);
  });

  it("sets escalated=true when response contains low-confidence language", async () => {
    vi.mocked(runAgent).mockResolvedValue(
      makeRunResult("I'm not entirely sure about this approach"),
    );

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({ agent: mockAgent, task: "analyze this", envelope });

    expect(result.escalated).toBe(true);
  });

  it("sets escalated=false when response is confident", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("The answer is definitely 42."));

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({ agent: mockAgent, task: "simple question", envelope });

    expect(result.escalated).toBe(false);
  });

  it("sets usedFanOut=false when allowFanOut is not set", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({ agent: mockAgent, task: "short task", envelope });

    expect(result.usedFanOut).toBe(false);
  });

  it("returns budgetCheck with action=proceed for small task on large budget", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("ok"));

    const envelope = new BudgetEnvelope(100);
    const result = await runCostAware({ agent: mockAgent, task: "tiny task", envelope });

    expect(result.budgetCheck.action).toBe("proceed");
    expect(result.budgetCheck.allowed).toBe(true);
  });

  it("uses haiku as default fanOut shard tier", async () => {
    vi.mocked(runAgent).mockResolvedValue(makeRunResult("shard result"));

    const sonnetAgent: AgentTemplate = { ...mockAgent, model: "sonnet", category: "implementation" };
    const envelope = new BudgetEnvelope(100);

    const result = await runCostAware({
      agent: sonnetAgent,
      task: "research topic A and topic B and topic C with extensive detail",
      envelope,
      allowFanOut: true,
      fanOutShardTier: "haiku",
    });

    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });
});
