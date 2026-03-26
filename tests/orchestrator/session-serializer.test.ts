import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionSerializer } from "../../src/orchestrator/session-serializer.js";
import type { HibernatedSession } from "../../src/types/team-mode.js";
import type { TeamManifest } from "../../src/types/team.js";

function makeManifest(): TeamManifest {
  return {
    name: "Test Team",
    forged_at: "2026-01-01",
    forged_by: "test",
    project_hash: "abc123",
    agents: {
      strategic: ["cto"],
      implementation: ["core-lead"],
      quality: [],
      utility: [],
    },
    model_routing: { opus: ["cto"], sonnet: ["core-lead"], haiku: [] },
    delegation_graph: { cto: ["core-lead"], "core-lead": [] },
  };
}

function makeSnapshot(): HibernatedSession {
  return {
    sessionId: "test-session-id",
    hibernatedAt: "2026-03-25T15:00:00Z",
    projectRoot: "/tmp/test-project",
    teamManifest: makeManifest(),
    autonomyLevel: "full",
    feedEntries: [
      {
        timestamp: "2026-03-25T15:00:00Z",
        source: "conduit:user",
        target: "agent:cto",
        type: "task",
        summary: "Build the auth module",
        content: "Build the auth module",
      },
    ],
    gitCommitAtHibernation: "abc1234",
    sessionBudgetUsd: 10.0,
    spentUsd: 2.5,
  };
}

describe("SessionSerializer", () => {
  let tmpDir: string;
  let serializer: SessionSerializer;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-serializer-test-"));
    serializer = new SessionSerializer(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("save", () => {
    it("should write a JSON file to the sessions directory", async () => {
      const snapshot = makeSnapshot();
      await serializer.save(snapshot);

      const sessionsDir = path.join(tmpDir, ".agentforge", "sessions");
      const files = await fs.readdir(sessionsDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/session-.*\.json$/);
    });

    it("should write valid JSON containing the snapshot", async () => {
      const snapshot = makeSnapshot();
      await serializer.save(snapshot);

      const sessionsDir = path.join(tmpDir, ".agentforge", "sessions");
      const files = await fs.readdir(sessionsDir);
      const content = await fs.readFile(path.join(sessionsDir, files[0]!), "utf-8");
      const parsed = JSON.parse(content) as HibernatedSession;

      expect(parsed.sessionId).toBe("test-session-id");
      expect(parsed.autonomyLevel).toBe("full");
      expect(parsed.spentUsd).toBe(2.5);
    });
  });

  describe("load", () => {
    it("should load the most recent session", async () => {
      const snapshot = makeSnapshot();
      await serializer.save(snapshot);

      const loaded = await serializer.loadLatest();
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe("test-session-id");
    });

    it("should return null when no sessions exist", async () => {
      const loaded = await serializer.loadLatest();
      expect(loaded).toBeNull();
    });

    it("should load by session ID", async () => {
      const snapshot = makeSnapshot();
      await serializer.save(snapshot);

      const loaded = await serializer.loadById("test-session-id");
      expect(loaded).not.toBeNull();
      expect(loaded!.hibernatedAt).toBe("2026-03-25T15:00:00Z");
    });

    it("should return null for unknown session ID", async () => {
      const loaded = await serializer.loadById("nonexistent");
      expect(loaded).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all saved sessions", async () => {
      await serializer.save({ ...makeSnapshot(), sessionId: "session-1" });
      await serializer.save({ ...makeSnapshot(), sessionId: "session-2" });

      const sessions = await serializer.list();
      expect(sessions).toHaveLength(2);
    });

    it("should return empty array when no sessions exist", async () => {
      const sessions = await serializer.list();
      expect(sessions).toEqual([]);
    });

    it("should list sessions sorted newest first", async () => {
      await serializer.save({ ...makeSnapshot(), sessionId: "session-1", hibernatedAt: "2026-03-25T14:00:00Z" });
      await serializer.save({ ...makeSnapshot(), sessionId: "session-2", hibernatedAt: "2026-03-25T15:00:00Z" });

      const sessions = await serializer.list();
      expect(sessions[0]!.sessionId).toBe("session-2");
    });
  });

  describe("delete", () => {
    it("should delete a session by ID", async () => {
      const snapshot = makeSnapshot();
      await serializer.save(snapshot);

      await serializer.deleteById("test-session-id");

      const loaded = await serializer.loadById("test-session-id");
      expect(loaded).toBeNull();
    });

    it("should not throw when deleting nonexistent session", async () => {
      await expect(serializer.deleteById("nonexistent")).resolves.not.toThrow();
    });
  });
});
