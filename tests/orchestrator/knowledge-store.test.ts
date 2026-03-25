import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { KnowledgeStore } from "../../src/orchestrator/knowledge-store.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("KnowledgeStore", () => {
  let tmpDir: string;
  let store: KnowledgeStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-knowledge-test-"));
    store = new KnowledgeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Session Scope (in-memory) ───────────────────────────────────────────

  it("stores and retrieves session-scope entries in memory", async () => {
    await store.set("session", "test-key", { hello: "world" }, "agent-a");
    const entry = await store.get("session", "test-key");
    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual({ hello: "world" });
    expect(entry!.createdBy).toBe("agent-a");
    expect(entry!.scope).toBe("session");
  });

  it("returns null for non-existent session-scope keys", async () => {
    const entry = await store.get("session", "nope");
    expect(entry).toBeNull();
  });

  it("updates existing session-scope entries preserving createdBy and createdAt", async () => {
    const first = await store.set("session", "k", "v1", "agent-a");
    const second = await store.set("session", "k", "v2", "agent-b");
    expect(second.value).toBe("v2");
    expect(second.createdBy).toBe("agent-a"); // Original creator preserved
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.id).toBe(first.id);
  });

  it("clears session-scope entries", async () => {
    await store.set("session", "k", "v", "agent-a");
    store.clearSession();
    const entry = await store.get("session", "k");
    expect(entry).toBeNull();
  });

  // ── Project Scope (persisted) ───────────────────────────────────────────

  it("persists project-scope entries to disk", async () => {
    await store.set("project", "config:theme", "dark", "vp-product");
    const entry = await store.get("project", "config:theme");
    expect(entry).not.toBeNull();
    expect(entry!.value).toBe("dark");

    // Verify file exists on disk
    const dir = path.join(tmpDir, ".agentforge", "knowledge", "project");
    const files = await fs.readdir(dir);
    expect(files.length).toBe(1);
  });

  it("returns null for non-existent project-scope keys", async () => {
    const entry = await store.get("project", "nope");
    expect(entry).toBeNull();
  });

  // ── Entity Scope (persisted) ────────────────────────────────────────────

  it("persists entity-scope entries to disk", async () => {
    await store.set("entity", "cost-tracker:trends", [1, 2, 3], "cost-tracker-dev");
    const entry = await store.get("entity", "cost-tracker:trends");
    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual([1, 2, 3]);
  });

  // ── Query ───────────────────────────────────────────────────────────────

  it("queries session-scope entries by tag", async () => {
    await store.set("session", "a", 1, "agent-a", ["cost"]);
    await store.set("session", "b", 2, "agent-b", ["routing"]);
    await store.set("session", "c", 3, "agent-c", ["cost", "routing"]);

    const costEntries = await store.query("session", { tags: ["cost"] });
    expect(costEntries).toHaveLength(2);
  });

  it("queries session-scope entries by creator", async () => {
    await store.set("session", "a", 1, "agent-a");
    await store.set("session", "b", 2, "agent-b");

    const entries = await store.query("session", { createdBy: "agent-a" });
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe("a");
  });

  it("queries project-scope entries from disk", async () => {
    await store.set("project", "x", 1, "agent-a", ["tag-1"]);
    await store.set("project", "y", 2, "agent-b", ["tag-2"]);

    const all = await store.query("project");
    expect(all).toHaveLength(2);
  });

  it("returns empty array when querying empty scope", async () => {
    const result = await store.query("project");
    expect(result).toEqual([]);
  });

  // ── Delete ──────────────────────────────────────────────────────────────

  it("deletes session-scope entries", async () => {
    await store.set("session", "k", "v", "agent-a");
    const deleted = await store.delete("session", "k");
    expect(deleted).toBe(true);
    expect(await store.get("session", "k")).toBeNull();
  });

  it("returns false when deleting non-existent session key", async () => {
    const deleted = await store.delete("session", "nope");
    expect(deleted).toBe(false);
  });

  it("deletes project-scope entries from disk", async () => {
    await store.set("project", "k", "v", "agent-a");
    const deleted = await store.delete("project", "k");
    expect(deleted).toBe(true);
    expect(await store.get("project", "k")).toBeNull();
  });

  // ── Metrics ─────────────────────────────────────────────────────────────

  it("tracks entries created count", async () => {
    expect(store.getEntriesCreatedCount()).toBe(0);
    await store.set("session", "a", 1, "agent-a");
    expect(store.getEntriesCreatedCount()).toBe(1);
    // Update doesn't increment
    await store.set("session", "a", 2, "agent-a");
    expect(store.getEntriesCreatedCount()).toBe(1);
    // New key does increment
    await store.set("session", "b", 1, "agent-a");
    expect(store.getEntriesCreatedCount()).toBe(2);
  });
});
