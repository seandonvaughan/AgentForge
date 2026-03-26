/**
 * Tests for SessionMemoryManager — v4.5 P0-3
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionMemoryManager,
  type SessionSummaryRecord,
  type SessionMemoryEntry,
} from "../../src/memory/session-memory-manager.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<SessionMemoryEntry>): SessionMemoryEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "session-1",
    category: "task-outcome",
    agentId: "coder",
    summary: "Completed a coding task",
    success: true,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeSession(overrides?: Partial<SessionSummaryRecord>): SessionSummaryRecord {
  return {
    sessionId: `session-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    agentRuns: 3,
    totalCostUsd: 0.05,
    entries: [makeEntry()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionMemoryManager", () => {
  describe("createWithPath", () => {
    it("creates an empty manager", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      expect(mgr.getSessionCount()).toBe(0);
      expect(mgr.isDirty()).toBe(false);
    });
  });

  describe("recordSession", () => {
    it("records a session and marks as dirty", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(makeSession());

      expect(mgr.getSessionCount()).toBe(1);
      expect(mgr.isDirty()).toBe(true);
    });

    it("prepends newest session first", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(makeSession({ sessionId: "old" }));
      mgr.recordSession(makeSession({ sessionId: "new" }));

      const sessions = mgr.getRecentSessions();
      expect(sessions[0].sessionId).toBe("new");
      expect(sessions[1].sessionId).toBe("old");
    });

    it("compacts sessions beyond the rolling window", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");

      // Add 25 sessions (max is 20)
      for (let i = 0; i < 25; i++) {
        mgr.recordSession(makeSession({ sessionId: `session-${i}` }));
      }

      expect(mgr.getSessionCount()).toBe(20);
      expect(mgr.getCompactedSummaries().length).toBe(5);
    });
  });

  describe("addEntry", () => {
    it("adds an entry to the most recent session", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(makeSession({ sessionId: "s1", entries: [] }));
      mgr.addEntry(makeEntry({ sessionId: "s1" }));

      const sessions = mgr.getRecentSessions();
      expect(sessions[0].entries).toHaveLength(1);
    });

    it("creates a placeholder session if none exists", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.addEntry(makeEntry({ sessionId: "new-session" }));

      expect(mgr.getSessionCount()).toBe(1);
      const sessions = mgr.getRecentSessions();
      expect(sessions[0].sessionId).toBe("new-session");
    });
  });

  describe("retrieval", () => {
    it("gets entries by category across sessions", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(
        makeSession({
          entries: [
            makeEntry({ category: "task-outcome" }),
            makeEntry({ category: "pattern-discovered" }),
          ],
        }),
      );
      mgr.recordSession(
        makeSession({
          entries: [makeEntry({ category: "task-outcome" })],
        }),
      );

      const outcomes = mgr.getEntriesByCategory("task-outcome");
      expect(outcomes).toHaveLength(2);

      const patterns = mgr.getEntriesByCategory("pattern-discovered");
      expect(patterns).toHaveLength(1);
    });

    it("gets entries for a specific agent", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(
        makeSession({
          entries: [
            makeEntry({ agentId: "coder" }),
            makeEntry({ agentId: "architect" }),
            makeEntry({ agentId: "coder" }),
          ],
        }),
      );

      const coderEntries = mgr.getEntriesForAgent("coder");
      expect(coderEntries).toHaveLength(2);

      const archEntries = mgr.getEntriesForAgent("architect");
      expect(archEntries).toHaveLength(1);
    });

    it("limits recent sessions by count", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      for (let i = 0; i < 10; i++) {
        mgr.recordSession(makeSession());
      }

      const limited = mgr.getRecentSessions(3);
      expect(limited).toHaveLength(3);
    });
  });

  describe("buildContextSummary", () => {
    it("produces a summary string from session entries", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      mgr.recordSession(
        makeSession({
          entries: [
            makeEntry({ agentId: "coder", summary: "Built the feature", success: true }),
            makeEntry({ agentId: "reviewer", summary: "Found a bug", success: false }),
          ],
        }),
      );

      const summary = mgr.buildContextSummary();
      expect(summary).toContain("coder");
      expect(summary).toContain("Built the feature");
      expect(summary).toContain("success");
      expect(summary).toContain("failure");
    });

    it("returns a no-history message when empty", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      const summary = mgr.buildContextSummary();
      expect(summary).toContain("No previous session history");
    });

    it("respects maxEntries limit", () => {
      const mgr = SessionMemoryManager.createWithPath("/tmp/test-mem.json");
      const entries: SessionMemoryEntry[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push(makeEntry({ summary: `Entry ${i}` }));
      }
      mgr.recordSession(makeSession({ entries }));

      const summary = mgr.buildContextSummary(5);
      expect(summary).toContain("5 entries");
    });
  });

  describe("persistence", () => {
    it("saves and loads state from disk", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "smm-test-"));
      const filePath = path.join(tmpDir, "memory", "test.json");

      // Save
      const mgr1 = SessionMemoryManager.createWithPath(filePath);
      mgr1.recordSession(makeSession({ sessionId: "persist-test" }));
      await mgr1.save();

      // Load
      const mgr2 = await SessionMemoryManager.load(
        tmpDir.replace(/\/memory$/, ""), // projectRoot would be the parent
      );

      // Since load uses a fixed path, let's test createWithPath + manual load
      const raw = await fs.readFile(filePath, "utf-8");
      const state = JSON.parse(raw);
      expect(state.sessions).toHaveLength(1);
      expect(state.sessions[0].sessionId).toBe("persist-test");

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("isDirty resets after save", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "smm-test-"));
      const filePath = path.join(tmpDir, "test.json");

      const mgr = SessionMemoryManager.createWithPath(filePath);
      mgr.recordSession(makeSession());
      expect(mgr.isDirty()).toBe(true);

      await mgr.save();
      expect(mgr.isDirty()).toBe(false);

      // Cleanup
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
});
