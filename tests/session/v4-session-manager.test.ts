import { describe, it, expect, beforeEach } from "vitest";
import {
  V4SessionManager,
  type V4Session,
  type SessionCreateInput,
} from "../../src/session/v4-session-manager.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

function makeInput(overrides?: Partial<SessionCreateInput>): SessionCreateInput {
  return {
    taskDescription: "Implement feature X",
    agentId: "cto",
    autonomyTier: 3,
    ...overrides,
  };
}

describe("V4SessionManager", () => {
  let mgr: V4SessionManager;
  beforeEach(() => { mgr = new V4SessionManager(); });

  describe("create", () => {
    it("creates a session with active status", () => {
      const s = mgr.create(makeInput());
      expect(s.status).toBe("active");
      expect(s.sessionId).toBeTruthy();
      expect(s.agentId).toBe("cto");
    });
    it("assigns unique session ids", () => {
      const a = mgr.create(makeInput());
      const b = mgr.create(makeInput());
      expect(a.sessionId).not.toBe(b.sessionId);
    });
    it("sets createdAt and updatedAt", () => {
      const s = mgr.create(makeInput());
      expect(s.createdAt).toBeTruthy();
      expect(s.updatedAt).toBeTruthy();
    });
  });

  describe("get / list", () => {
    it("retrieves session by id", () => {
      const s = mgr.create(makeInput());
      expect(mgr.get(s.sessionId)).not.toBeNull();
    });
    it("returns null for unknown id", () => {
      expect(mgr.get("nope")).toBeNull();
    });
    it("list returns all sessions", () => {
      mgr.create(makeInput());
      mgr.create(makeInput());
      expect(mgr.list()).toHaveLength(2);
    });
    it("listActive returns only active sessions", () => {
      const s = mgr.create(makeInput());
      mgr.create(makeInput());
      mgr.complete(s.sessionId, "done");
      expect(mgr.listActive()).toHaveLength(1);
    });
  });

  describe("persist / resume", () => {
    it("persists an active session (active → persisted)", () => {
      const s = mgr.create(makeInput());
      const persisted = mgr.persist(s.sessionId);
      expect(persisted.status).toBe("persisted");
    });
    it("resume restores a persisted session (persisted → active)", () => {
      const s = mgr.create(makeInput());
      mgr.persist(s.sessionId);
      const resumed = mgr.resume(s.sessionId);
      expect(resumed.status).toBe("active");
      expect(resumed.resumeCount).toBe(1);
    });
    it("throws if persisting non-active session", () => {
      const s = mgr.create(makeInput());
      mgr.complete(s.sessionId, "done");
      expect(() => mgr.persist(s.sessionId)).toThrow(/active/);
    });
    it("throws if resuming non-persisted session", () => {
      const s = mgr.create(makeInput());
      expect(() => mgr.resume(s.sessionId)).toThrow(/persisted/);
    });
  });

  describe("complete", () => {
    it("marks session as completed with result", () => {
      const s = mgr.create(makeInput());
      const completed = mgr.complete(s.sessionId, "Task done");
      expect(completed.status).toBe("completed");
      expect(completed.result).toBe("Task done");
    });
    it("throws if already completed", () => {
      const s = mgr.create(makeInput());
      mgr.complete(s.sessionId, "done");
      expect(() => mgr.complete(s.sessionId, "again")).toThrow(/completed/);
    });
  });

  describe("expire", () => {
    it("expires an active session", () => {
      const s = mgr.create(makeInput());
      const expired = mgr.expire(s.sessionId, "Timeout");
      expect(expired.status).toBe("expired");
      expect(expired.result).toBe("Timeout");
    });
    it("expires a persisted session", () => {
      const s = mgr.create(makeInput());
      mgr.persist(s.sessionId);
      const expired = mgr.expire(s.sessionId, "Stale");
      expect(expired.status).toBe("expired");
    });
    it("throws if already completed", () => {
      const s = mgr.create(makeInput());
      mgr.complete(s.sessionId, "x");
      expect(() => mgr.expire(s.sessionId, "y")).toThrow();
    });
  });

  describe("resource cleanup", () => {
    it("cleanup removes expired sessions older than threshold", () => {
      const s = mgr.create(makeInput());
      mgr.expire(s.sessionId, "old");
      // Force the expired session to look old
      const session = mgr.get(s.sessionId)!;
      (session as any)._forceUpdatedAt = new Date(Date.now() - 86400001).toISOString();
      mgr._setForTest(s.sessionId, { ...session, updatedAt: new Date(Date.now() - 86400001).toISOString() });
      const cleaned = mgr.cleanup(86400000); // 24h threshold
      expect(cleaned).toBe(1);
      expect(mgr.get(s.sessionId)).toBeNull();
    });
    it("cleanup does not remove active sessions", () => {
      mgr.create(makeInput());
      const cleaned = mgr.cleanup(0);
      expect(cleaned).toBe(0);
    });
  });

  describe("cross-session context (Sprint 4.2a)", () => {
    it("addContext attaches context data to a session", () => {
      const s = mgr.create(makeInput());
      mgr.addContext(s.sessionId, "prev-session-123", "Learned: always validate inputs");
      const session = mgr.get(s.sessionId)!;
      expect(session.contextChain).toHaveLength(1);
      expect(session.contextChain[0].sourceSessionId).toBe("prev-session-123");
    });
    it("context chains across multiple sessions", () => {
      const s1 = mgr.create(makeInput({ taskDescription: "Phase 1" }));
      mgr.complete(s1.sessionId, "Phase 1 done");

      const s2 = mgr.create(makeInput({ taskDescription: "Phase 2" }));
      mgr.addContext(s2.sessionId, s1.sessionId, "Phase 1 learnings: use TDD");
      mgr.complete(s2.sessionId, "Phase 2 done");

      const s3 = mgr.create(makeInput({ taskDescription: "Phase 3" }));
      mgr.addContext(s3.sessionId, s1.sessionId, "Phase 1 learnings");
      mgr.addContext(s3.sessionId, s2.sessionId, "Phase 2 learnings");

      const session = mgr.get(s3.sessionId)!;
      expect(session.contextChain).toHaveLength(2);
    });
    it("getContextChain returns threaded context", () => {
      const s = mgr.create(makeInput());
      mgr.addContext(s.sessionId, "old-1", "context A");
      mgr.addContext(s.sessionId, "old-2", "context B");
      const chain = mgr.getContextChain(s.sessionId);
      expect(chain).toHaveLength(2);
      expect(chain[0].content).toBe("context A");
    });
  });

  describe("timeout policies by autonomy tier", () => {
    it("tier 1 (Supervised) has shorter timeout", () => {
      const t1 = mgr.getTimeoutMs(1);
      const t4 = mgr.getTimeoutMs(4);
      expect(t1).toBeLessThan(t4);
    });
    it("all tiers have positive timeouts", () => {
      for (const tier of [1, 2, 3, 4]) {
        expect(mgr.getTimeoutMs(tier)).toBeGreaterThan(0);
      }
    });
  });

  describe("immutability", () => {
    it("returned sessions are copies", () => {
      const s = mgr.create(makeInput());
      const retrieved = mgr.get(s.sessionId)!;
      retrieved.status = "expired" as any;
      expect(mgr.get(s.sessionId)!.status).toBe("active");
    });
  });

  describe("serialization", () => {
    it("toJSON / fromJSON round-trip preserves all sessions", () => {
      mgr.create(makeInput({ taskDescription: "A" }));
      const s2 = mgr.create(makeInput({ taskDescription: "B" }));
      mgr.addContext(s2.sessionId, "old", "ctx");
      mgr.persist(s2.sessionId);

      const json = mgr.toJSON();
      const restored = V4SessionManager.fromJSON(json);
      expect(restored.list()).toHaveLength(2);
      const restored2 = restored.get(s2.sessionId)!;
      expect(restored2.status).toBe("persisted");
      expect(restored2.contextChain).toHaveLength(1);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits session lifecycle events when bus is provided", () => {
      const bus = new V4MessageBus();
      const busMgr = new V4SessionManager(bus);

      const s = busMgr.create(makeInput());
      expect(bus.getHistoryForTopic("session.created")).toHaveLength(1);

      busMgr.persist(s.sessionId);
      expect(bus.getHistoryForTopic("session.persisted")).toHaveLength(1);

      busMgr.resume(s.sessionId);
      expect(bus.getHistoryForTopic("session.resumed")).toHaveLength(1);

      busMgr.complete(s.sessionId, "done");
      expect(bus.getHistoryForTopic("session.completed")).toHaveLength(1);

      // Test expire
      const s2 = busMgr.create(makeInput());
      busMgr.expire(s2.sessionId, "timeout");
      expect(bus.getHistoryForTopic("session.expired")).toHaveLength(1);
    });
  });
});
