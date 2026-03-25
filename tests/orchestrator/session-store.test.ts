import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionStore } from "../../src/orchestrator/session-store.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ProgressLedger } from "../../src/types/orchestration.js";

function makeLedger(taskId: string): ProgressLedger {
  return {
    task_id: taskId,
    objective: "Test objective for " + taskId,
    facts: {
      given: ["TypeScript project", "540 tests"],
      to_look_up: ["performance bottleneck"],
      to_derive: ["optimal model routing"],
      educated_guesses: [],
    },
    plan: ["Analyze code", "Propose routing"],
    steps_completed: ["Analyzed code"],
    current_step: null,
    is_request_satisfied: false,
    is_in_loop: false,
    is_progress_being_made: true,
    confidence: 0.8,
    next_speaker: "cost-engine-designer",
    instruction: "Continue with analysis",
  };
}

describe("SessionStore", () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-session-test-"));
    store = new SessionStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("saveSnapshot creates a JSON file in .agentforge/sessions/", async () => {
    const ledger = makeLedger("task-001");
    await store.saveSnapshot(ledger);

    const sessionsDir = path.join(tmpDir, ".agentforge", "sessions");
    const files = await fs.readdir(sessionsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^task-001.*\.json$/);
  });

  it("loadLatest returns the most recent snapshot for a task", async () => {
    const ledger1 = makeLedger("task-002");
    await store.saveSnapshot(ledger1);

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));

    const ledger2 = { ...makeLedger("task-002"), steps_completed: ["Step 1", "Step 2"] };
    await store.saveSnapshot(ledger2);

    const loaded = await store.loadLatest("task-002");
    expect(loaded).not.toBeNull();
    expect(loaded!.steps_completed).toHaveLength(2);
  });

  it("loadLatest returns null for non-existent task", async () => {
    const result = await store.loadLatest("nonexistent");
    expect(result).toBeNull();
  });

  it("loadAllSnapshots returns all snapshots across tasks", async () => {
    await store.saveSnapshot(makeLedger("task-a"));
    await store.saveSnapshot(makeLedger("task-b"));
    await store.saveSnapshot(makeLedger("task-c"));

    const all = await store.loadAllSnapshots();
    expect(all).toHaveLength(3);
  });

  it("loadAllSnapshots returns empty array when no sessions exist", async () => {
    const all = await store.loadAllSnapshots();
    expect(all).toHaveLength(0);
  });

  it("loadLatest does not match task IDs that are prefixes of another", async () => {
    await store.saveSnapshot(makeLedger("task-1"));
    await new Promise((r) => setTimeout(r, 10));
    await store.saveSnapshot(makeLedger("task-10"));
    const loaded = await store.loadLatest("task-1");
    expect(loaded!.task_id).toBe("task-1");
  });

  it("round-trips ProgressLedger data correctly", async () => {
    const original = makeLedger("round-trip");
    original.is_in_loop = true;
    original.facts.educated_guesses = ["Maybe the scanner is slow"];

    await store.saveSnapshot(original);
    const loaded = await store.loadLatest("round-trip");

    expect(loaded).toEqual(original);
  });
});
