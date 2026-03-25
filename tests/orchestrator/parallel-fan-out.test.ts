import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRunResult } from "../../src/api/agent-runner.js";

// Mock runAgent BEFORE importing the module under test
vi.mock("../../src/api/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from "../../src/api/agent-runner.js";
import {
  runParallelFanOut,
  shouldFanOut,
  decomposeTask,
} from "../../src/orchestrator/parallel-fan-out.js";
import type { FanOutConfig } from "../../src/types/budget.js";

const makeResult = (content: string, input = 100, output = 50): AgentRunResult => ({
  agent: "shard-agent",
  model: "haiku",
  response: content,
  inputTokens: input,
  outputTokens: output,
  duration_ms: 10,
  delegations: [],
});

describe("shouldFanOut", () => {
  it("returns true for opus ceiling with decomposable research task", () => {
    expect(shouldFanOut("research the history of AI", "implementation", "opus")).toBe(true);
  });

  it("returns true for sonnet ceiling with decomposable code task", () => {
    expect(shouldFanOut("fix each file in the codebase", "implementation", "sonnet")).toBe(true);
  });

  it("returns false for haiku ceiling (too cheap to fan out)", () => {
    expect(shouldFanOut("research the topic", "utility", "haiku")).toBe(false);
  });

  it("returns false for short simple task regardless of tier", () => {
    expect(shouldFanOut("hello", "utility", "opus")).toBe(false);
  });
});

describe("decomposeTask", () => {
  it("splits a research task into subtopics by 'and' / comma", () => {
    const shards = decomposeTask("research topic A and topic B and topic C");
    expect(shards.length).toBeGreaterThanOrEqual(2);
  });

  it("splits a code task by mentioning multiple files/functions", () => {
    const shards = decomposeTask("fix the login function and the logout function");
    expect(shards.length).toBeGreaterThanOrEqual(2);
  });

  it("returns at least one shard even for a short task", () => {
    const shards = decomposeTask("do something simple");
    expect(shards.length).toBeGreaterThanOrEqual(1);
  });
});

describe("runParallelFanOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches shardCount agents and merges results", async () => {
    const mockRun = vi.mocked(runAgent);
    mockRun.mockResolvedValue(makeResult("shard output"));

    const config: FanOutConfig = {
      task: "research topic A and topic B",
      shardCount: 2,
      shardTier: "haiku",
      mergerTier: "haiku",
    };

    const result = await runParallelFanOut(config);

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(result.mergedContent).toContain("shard output");
    expect(result.totalInputTokens).toBe(200);
    expect(result.totalOutputTokens).toBe(100);
  });

  it("handles partial failures — reports failed shards", async () => {
    const mockRun = vi.mocked(runAgent);
    mockRun
      .mockResolvedValueOnce(makeResult("success shard"))
      .mockRejectedValueOnce(new Error("network error"));

    const config: FanOutConfig = {
      task: "research topic A and topic B",
      shardCount: 2,
      shardTier: "haiku",
      mergerTier: "haiku",
    };

    const result = await runParallelFanOut(config);

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.mergedContent).toContain("success shard");
    expect(result.shardResults[1]).toBeNull();
  });

  it("returns zero tokens when all shards fail", async () => {
    const mockRun = vi.mocked(runAgent);
    mockRun.mockRejectedValue(new Error("fail"));

    const config: FanOutConfig = {
      task: "research",
      shardCount: 2,
      shardTier: "haiku",
      mergerTier: "haiku",
    };

    const result = await runParallelFanOut(config);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(2);
    expect(result.totalInputTokens).toBe(0);
    expect(result.totalOutputTokens).toBe(0);
    expect(result.mergedContent).toBe("");
  });
});
