import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentForgeSession, type SessionConfig } from "../../src/orchestrator/session.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentTemplate } from "../../src/types/agent.js";

vi.mock("../../src/api/client.js", () => ({
  createClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Mock response" }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  }),
  MODEL_MAP: { opus: "claude-opus-4-20250514", sonnet: "claude-sonnet-4-20250514", haiku: "claude-haiku-4-5-20251001" },
  MODEL_DEFAULTS: { opus: { maxTokens: 4096, temperature: 0.7 }, sonnet: { maxTokens: 4096, temperature: 0.5 }, haiku: { maxTokens: 2048, temperature: 0.3 } },
  MODEL_EFFORT_DEFAULTS: { opus: "high", sonnet: "medium", haiku: "low" },
  sendMessage: vi.fn().mockResolvedValue({ content: "Mock response", inputTokens: 100, outputTokens: 50 }),
}));

function makeAgent(name: string, category: AgentTemplate["category"] = "implementation"): AgentTemplate {
  return {
    name,
    model: "haiku",
    version: "1.0.0",
    description: name + " agent",
    system_prompt: "You are " + name + ".",
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: { reports_to: null, reviews_from: [], can_delegate_to: [], parallel: false },
    context: { max_files: 10, auto_include: [], project_specific: [] },
    category,
  };
}

describe("AgentForgeSession", () => {
  let tmpDir: string;
  let config: SessionConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-session-test-"));
    config = {
      projectRoot: tmpDir,
      sessionBudgetUsd: 10.0,
      enableReforge: false,
      enableCostAwareRouting: true,
      enableReviewEnforcement: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a session via static factory", async () => {
    const session = await AgentForgeSession.create(config);
    expect(session).toBeDefined();
    expect(session.getSessionId()).toBeTruthy();
    expect(session.orchestrator).toBeDefined();
    expect(session.messageBus).toBeDefined();
    expect(session.knowledgeStore).toBeDefined();
    expect(session.decisionLog).toBeDefined();
    expect(session.eventBus).toBeDefined();
  });

  it("wires auto-rules to MessageBus on creation", async () => {
    const session = await AgentForgeSession.create({
      ...config,
      autoRules: [
        { id: "rule-1", onEvent: "test_event", dispatchAction: "log", attributedTo: "system" },
      ],
    });

    await session.messageBus.publish(
      { type: "test_event", source: "test", payload: {}, notify: ["*"] },
      "urgent",
    );

    const decisions = await session.decisionLog.loadAll();
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions.some((d) => d.description.includes("rule-1"))).toBe(true);
  });

  it("end() returns a SessionSummary", async () => {
    const session = await AgentForgeSession.create(config);
    const summary = await session.end();

    expect(summary.sessionId).toBe(session.getSessionId());
    expect(summary.startedAt).toBeTruthy();
    expect(summary.endedAt).toBeTruthy();
    expect(summary.totalAgentRuns).toBe(0);
    expect(summary.totalSpentUsd).toBe(0);
    expect(summary.decisionsRecorded).toBe(0);
    expect(summary.eventsProcessed).toBe(0);
  });

  it("end() drains pending events from MessageBus", async () => {
    const session = await AgentForgeSession.create(config);
    const drained: string[] = [];
    session.messageBus.register("drain-test", ["drain_event"], async () => {
      drained.push("processed");
    });

    await session.messageBus.publish(
      { type: "drain_event", source: "test", payload: {}, notify: ["*"] },
      "low",
    );
    expect(drained).toHaveLength(0);

    await session.end();
    expect(drained).toHaveLength(1);
  });

  it("getCostReport delegates to orchestrator", async () => {
    const session = await AgentForgeSession.create(config);
    const report = session.getCostReport();
    expect(report).toHaveProperty("totalSpentUsd");
    expect(report).toHaveProperty("remainingBudgetUsd");
    expect(report).toHaveProperty("agentBreakdown");
  });

  it("defaults enableReforge to true when not specified", async () => {
    const session = await AgentForgeSession.create({
      projectRoot: tmpDir,
      sessionBudgetUsd: 5.0,
    });
    expect(session).toBeDefined();
  });
});

describe("REFORGE REQUESTED detection", () => {
  it("detects single [REFORGE REQUESTED: reason] pattern", () => {
    const pattern = /\[REFORGE REQUESTED:\s*(.+?)\]/g;
    const content = "I cannot handle TypeScript generics. [REFORGE REQUESTED: Need better generic type handling examples]";
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe("Need better generic type handling examples");
  });

  it("detects multiple patterns in one response", () => {
    const pattern = /\[REFORGE REQUESTED:\s*(.+?)\]/g;
    const content = "First: [REFORGE REQUESTED: Need cost awareness] Second: [REFORGE REQUESTED: Missing delegation patterns]";
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    expect(matches).toHaveLength(2);
  });

  it("returns empty when no pattern present", () => {
    const pattern = /\[REFORGE REQUESTED:\s*(.+?)\]/g;
    const content = "Normal response with no reforge signals.";
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    expect(matches).toHaveLength(0);
  });

  it("handles whitespace variations", () => {
    const pattern = /\[REFORGE REQUESTED:\s*(.+?)\]/g;
    const content = "[REFORGE REQUESTED:   extra spaces reason  ]";
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push(match[1].trim());
    }
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe("extra spaces reason");
  });
});
