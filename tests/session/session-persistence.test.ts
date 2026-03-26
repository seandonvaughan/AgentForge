import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPersistence } from "../../src/session/session-persistence.js";
import type { V4Session } from "../../src/session/v4-session-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides?: Partial<V4Session>): V4Session {
  const now = new Date().toISOString();
  return {
    sessionId: "sess-abc-123",
    agentId: "cto",
    taskDescription: "Assess technical feasibility of v4.4",
    autonomyTier: 3,
    status: "active",
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
    contextChain: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionPersistence", () => {
  let dir: string;
  let persistence: SessionPersistence;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-session-test-"));
    persistence = new SessionPersistence(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // loadIndex — empty state
  // -------------------------------------------------------------------------

  describe("loadIndex", () => {
    it("returns [] when index.json does not exist", async () => {
      const index = await persistence.loadIndex();
      expect(index).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // loadSession — not found
  // -------------------------------------------------------------------------

  describe("loadSession", () => {
    it("returns null when session file does not exist", async () => {
      const result = await persistence.loadSession("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // save — writes individual record
  // -------------------------------------------------------------------------

  describe("save", () => {
    it("creates the output directory if missing", async () => {
      const nested = new SessionPersistence(join(dir, "deep", "nested"));
      const session = makeSession();
      await nested.save(session);
      const loaded = await nested.loadSession(session.sessionId);
      expect(loaded).not.toBeNull();
    });

    it("writes a full session record to <sessionId>.json", async () => {
      const session = makeSession({ status: "completed", result: "Done!" });
      await persistence.save(session);

      const record = await persistence.loadSession(session.sessionId);
      expect(record).not.toBeNull();
      expect(record!.sessionId).toBe("sess-abc-123");
      expect(record!.agentId).toBe("cto");
      expect(record!.task).toBe("Assess technical feasibility of v4.4");
      expect(record!.response).toBe("Done!");
      expect(record!.status).toBe("completed");
    });

    it("sets completedAt when session is completed", async () => {
      const session = makeSession({ status: "completed", result: "Done" });
      await persistence.save(session);
      const record = await persistence.loadSession(session.sessionId);
      expect(record!.completedAt).toBeTruthy();
    });

    it("does not set completedAt when session is active", async () => {
      const session = makeSession({ status: "active" });
      await persistence.save(session);
      const record = await persistence.loadSession(session.sessionId);
      expect(record!.completedAt).toBeUndefined();
    });

    it("sets completedAt when session is expired", async () => {
      const session = makeSession({ status: "expired", result: "Timeout" });
      await persistence.save(session);
      const record = await persistence.loadSession(session.sessionId);
      expect(record!.completedAt).toBeTruthy();
    });

    it("preserves autonomyTier and resumeCount", async () => {
      const session = makeSession({ autonomyTier: 4, resumeCount: 2 });
      await persistence.save(session);
      const record = await persistence.loadSession(session.sessionId);
      expect(record!.autonomyTier).toBe(4);
      expect(record!.resumeCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // save — index management
  // -------------------------------------------------------------------------

  describe("index.json", () => {
    it("creates index.json with one entry on first save", async () => {
      const session = makeSession();
      await persistence.save(session);

      const index = await persistence.loadIndex();
      expect(index).toHaveLength(1);
      expect(index[0].sessionId).toBe("sess-abc-123");
      expect(index[0].agentId).toBe("cto");
    });

    it("appends entries for different sessions", async () => {
      const s1 = makeSession({ sessionId: "s1", agentId: "cto" });
      const s2 = makeSession({ sessionId: "s2", agentId: "architect" });
      await persistence.save(s1);
      await persistence.save(s2);

      const index = await persistence.loadIndex();
      expect(index).toHaveLength(2);
      expect(index.map((s) => s.sessionId)).toContain("s1");
      expect(index.map((s) => s.sessionId)).toContain("s2");
    });

    it("updates existing entry on re-save (idempotent)", async () => {
      const session = makeSession({ status: "active" });
      await persistence.save(session);

      const updated = { ...session, status: "completed" as const, result: "done" };
      await persistence.save(updated);

      const index = await persistence.loadIndex();
      expect(index).toHaveLength(1);
      expect(index[0].status).toBe("completed");
    });

    it("truncates task to 120 chars in summary", async () => {
      const longTask = "x".repeat(200);
      const session = makeSession({ taskDescription: longTask });
      await persistence.save(session);

      const index = await persistence.loadIndex();
      expect(index[0].task.length).toBe(120);
    });

    it("summary includes completedAt when session is completed", async () => {
      const session = makeSession({ status: "completed", result: "ok" });
      await persistence.save(session);

      const index = await persistence.loadIndex();
      expect(index[0].completedAt).toBeTruthy();
    });

    it("summary omits completedAt when session is active", async () => {
      const session = makeSession({ status: "active" });
      await persistence.save(session);

      const index = await persistence.loadIndex();
      expect(index[0].completedAt).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // round-trip
  // -------------------------------------------------------------------------

  describe("round-trip", () => {
    it("save then loadSession returns identical data", async () => {
      const session = makeSession({
        sessionId: "rt-001",
        agentId: "architect",
        taskDescription: "Design the storage layer",
        status: "completed",
        result: "Layer designed successfully",
        autonomyTier: 2,
        resumeCount: 1,
      });
      await persistence.save(session);
      const record = await persistence.loadSession("rt-001");

      expect(record!.sessionId).toBe("rt-001");
      expect(record!.agentId).toBe("architect");
      expect(record!.task).toBe("Design the storage layer");
      expect(record!.response).toBe("Layer designed successfully");
      expect(record!.status).toBe("completed");
    });

    it("multiple sessions survive independent reads", async () => {
      const sessions = ["alpha", "beta", "gamma"].map((id) =>
        makeSession({ sessionId: id, agentId: id })
      );
      for (const s of sessions) await persistence.save(s);

      for (const s of sessions) {
        const loaded = await persistence.loadSession(s.sessionId);
        expect(loaded!.agentId).toBe(s.agentId);
      }

      const index = await persistence.loadIndex();
      expect(index).toHaveLength(3);
    });
  });
});
