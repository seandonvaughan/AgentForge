import { describe, it, expect, beforeEach } from "vitest";
import { FeedRenderer } from "../../src/orchestrator/feed-renderer.js";
import type { TeamModeMessage } from "../../src/types/team-mode.js";

function makeMessage(overrides: Partial<TeamModeMessage> = {}): TeamModeMessage {
  return {
    id: "msg-001",
    from: "agent:cto",
    to: "agent:core-lead",
    type: "task",
    content: "Build the auth module",
    priority: "normal",
    timestamp: "2026-03-25T15:00:00Z",
    ...overrides,
  };
}

describe("FeedRenderer", () => {
  let renderer: FeedRenderer;

  beforeEach(() => {
    renderer = new FeedRenderer();
  });

  describe("formatMessage", () => {
    it("should format a task message", () => {
      const msg = makeMessage({ type: "task" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("cto");
      expect(line).toContain("core-lead");
      expect(line).toContain("Build the auth module");
    });

    it("should format a decision message", () => {
      const msg = makeMessage({ type: "decision", content: "Use JWT for auth" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("decision");
      expect(line).toContain("Use JWT for auth");
    });

    it("should format a result message", () => {
      const msg = makeMessage({ type: "result", from: "agent:coder-a", to: "agent:core-lead", content: "Implementation complete" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("coder-a");
    });

    it("should format an escalation message", () => {
      const msg = makeMessage({ type: "escalation", from: "agent:core-lead", to: "agent:cto", content: "Need architectural guidance" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("escalation");
    });

    it("should format a status message", () => {
      const msg = makeMessage({ type: "status", from: "agent:coder-a", to: "conduit:user", content: "50% through implementation" });
      const line = renderer.formatMessage(msg);
      expect(line).toContain("coder-a");
    });
  });

  describe("toFeedEntry", () => {
    it("should convert message to feed entry", () => {
      const msg = makeMessage();
      const entry = renderer.toFeedEntry(msg);
      expect(entry.source).toBe("agent:cto");
      expect(entry.target).toBe("agent:core-lead");
      expect(entry.type).toBe("task");
      expect(entry.summary).toBeDefined();
      expect(entry.content).toBe("Build the auth module");
      expect(entry.timestamp).toBe("2026-03-25T15:00:00Z");
    });
  });

  describe("getDisplayTier", () => {
    it("should return full for urgent messages", () => {
      const msg = makeMessage({ priority: "urgent" });
      expect(renderer.getDisplayTier(msg)).toBe("full");
    });

    it("should return full for escalation", () => {
      expect(renderer.getDisplayTier(makeMessage({ type: "escalation" }))).toBe("full");
    });

    it("should return full for decision", () => {
      expect(renderer.getDisplayTier(makeMessage({ type: "decision" }))).toBe("full");
    });

    it("should return oneliner for task", () => {
      expect(renderer.getDisplayTier(makeMessage({ type: "task" }))).toBe("oneliner");
    });

    it("should return oneliner for result", () => {
      expect(renderer.getDisplayTier(makeMessage({ type: "result" }))).toBe("oneliner");
    });

    it("should return marker for status", () => {
      expect(renderer.getDisplayTier(makeMessage({ type: "status" }))).toBe("marker");
    });

    it("should return full for direct from user", () => {
      const msg = makeMessage({ type: "direct", from: "conduit:user" });
      expect(renderer.getDisplayTier(msg)).toBe("full");
    });

    it("should return oneliner for direct from agent", () => {
      const msg = makeMessage({ type: "direct", from: "agent:cto" });
      expect(renderer.getDisplayTier(msg)).toBe("oneliner");
    });
  });

  describe("formatByTier", () => {
    it("should return full format for escalation", () => {
      const msg = makeMessage({ type: "escalation", content: "Need guidance" });
      const result = renderer.formatByTier(msg);
      expect(result).toContain("escalation");
    });

    it("should return compact one-liner for task", () => {
      const msg = makeMessage({ type: "task", content: "Build auth" });
      const result = renderer.formatByTier(msg);
      expect(result).not.toBeNull();
      expect(result).toContain("cto");
    });

    it("should return dot-marker for status", () => {
      const msg = makeMessage({ type: "status", from: "agent:coder-a" });
      const result = renderer.formatByTier(msg);
      expect(result).toContain("·");
      expect(result).toContain("coder-a");
    });
  });

  describe("formatCostMilestone", () => {
    it("should return null below 50%", () => {
      expect(renderer.formatCostMilestone(1.0, 10.0)).toBeNull();
    });

    it("should return milestone at 50%", () => {
      const result = renderer.formatCostMilestone(5.0, 10.0);
      expect(result).not.toBeNull();
      expect(result).toContain("50%");
    });

    it("should return milestone at 75%", () => {
      const result = renderer.formatCostMilestone(7.5, 10.0);
      expect(result).not.toBeNull();
      expect(result).toContain("75%");
    });

    it("should return warning at 90%", () => {
      const result = renderer.formatCostMilestone(9.0, 10.0);
      expect(result).not.toBeNull();
      expect(result).toContain("90%");
    });
  });

  describe("feed accumulation", () => {
    it("should accumulate entries", () => {
      renderer.addMessage(makeMessage({ id: "1" }));
      renderer.addMessage(makeMessage({ id: "2" }));
      expect(renderer.getEntries()).toHaveLength(2);
    });

    it("should return entries in order", () => {
      renderer.addMessage(makeMessage({ id: "1", timestamp: "2026-03-25T15:00:00Z" }));
      renderer.addMessage(makeMessage({ id: "2", timestamp: "2026-03-25T15:01:00Z" }));
      const entries = renderer.getEntries();
      expect(entries[0]!.timestamp).toBe("2026-03-25T15:00:00Z");
      expect(entries[1]!.timestamp).toBe("2026-03-25T15:01:00Z");
    });
  });
});