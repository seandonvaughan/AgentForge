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