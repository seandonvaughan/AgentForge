import { describe, it, expect } from "vitest";
import type { AutoRule, SessionSummary } from "../../src/types/session.js";

describe("Session types", () => {
  it("AutoRule has required fields", () => {
    const rule: AutoRule = {
      id: "rule-1",
      onEvent: "security_alert",
      dispatchAction: "jira:create_issue",
      attributedTo: "security-vulnerability-tester",
    };
    expect(rule.id).toBe("rule-1");
    expect(rule.condition).toBeUndefined();
  });

  it("AutoRule accepts optional condition", () => {
    const rule: AutoRule = {
      id: "rule-2",
      onEvent: "budget_warning",
      condition: "payload.percentUsed > 80",
      dispatchAction: "slack:post_message",
      attributedTo: "cost-tracker-dev",
    };
    expect(rule.condition).toBe("payload.percentUsed > 80");
  });

  it("SessionSummary has all metric fields", () => {
    const summary: SessionSummary = {
      sessionId: "session-123",
      startedAt: "2026-03-25T00:00:00.000Z",
      endedAt: "2026-03-25T01:00:00.000Z",
      totalAgentRuns: 15,
      totalSpentUsd: 2.50,
      decisionsRecorded: 12,
      knowledgeEntriesCreated: 8,
      reforgeActionsApplied: 2,
      eventsProcessed: 45,
    };
    expect(summary.totalAgentRuns).toBe(15);
    expect(summary.reforgeActionsApplied).toBe(2);
  });

  it("SessionSummary supports zero values for new sessions", () => {
    const summary: SessionSummary = {
      sessionId: "empty-session",
      startedAt: "2026-03-25T00:00:00.000Z",
      endedAt: "2026-03-25T00:00:01.000Z",
      totalAgentRuns: 0,
      totalSpentUsd: 0,
      decisionsRecorded: 0,
      knowledgeEntriesCreated: 0,
      reforgeActionsApplied: 0,
      eventsProcessed: 0,
    };
    expect(summary.totalAgentRuns).toBe(0);
  });
});
