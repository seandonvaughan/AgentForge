import { describe, it, expect, beforeEach } from "vitest";
import { ConcurrencyManager } from "../../src/lifecycle/concurrency-manager.js";
import { SENIORITY_CONFIG } from "../../src/types/lifecycle.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConcurrencyManager", () => {
  let manager: ConcurrencyManager;

  beforeEach(() => {
    manager = new ConcurrencyManager();
  });

  // -------------------------------------------------------------------------
  // allocateSlot()
  // -------------------------------------------------------------------------

  describe("allocateSlot()", () => {
    it("creates and returns a slot for an agent within capacity", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "senior");

      expect(slot).not.toBeNull();
      expect(slot!.agentId).toBe("agent-001");
      expect(slot!.taskId).toBe("task-1");
      expect(slot!.status).toBe("active");
    });

    it("assigns a unique slotId", () => {
      const slot1 = manager.allocateSlot("agent-001", "task-1", "senior");
      const slot2 = manager.allocateSlot("agent-001", "task-2", "senior");

      expect(slot1!.slotId).not.toBe(slot2!.slotId);
    });

    it("slot has empty workingFiles on creation", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid");

      expect(slot!.contextSnapshot.workingFiles).toEqual([]);
    });

    it("slot teamKnowledge defaults to empty when none provided", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid");

      expect(slot!.contextSnapshot.teamKnowledge).toEqual([]);
    });

    it("slot includes provided teamKnowledge", () => {
      const knowledge = [
        {
          id: "k1",
          teamId: "backend-team",
          category: "pattern" as const,
          content: "Always use transactions",
          source: "agent-db",
          confidence: 0.9,
          references: [],
          createdAt: new Date().toISOString(),
          lastValidated: new Date().toISOString(),
        },
      ];

      const slot = manager.allocateSlot("agent-001", "task-1", "mid", knowledge);

      expect(slot!.contextSnapshot.teamKnowledge).toHaveLength(1);
      expect(slot!.contextSnapshot.teamKnowledge[0].id).toBe("k1");
    });

    it("returns null when agent is at maximum capacity for their seniority", () => {
      // junior has maxConcurrentTasks = 1
      manager.allocateSlot("junior-agent", "task-1", "junior");

      const rejected = manager.allocateSlot("junior-agent", "task-2", "junior");
      expect(rejected).toBeNull();
    });

    it("allows multiple slots up to but not exceeding seniority cap", () => {
      // senior has maxConcurrentTasks = 3
      const s1 = manager.allocateSlot("senior-agent", "task-1", "senior");
      const s2 = manager.allocateSlot("senior-agent", "task-2", "senior");
      const s3 = manager.allocateSlot("senior-agent", "task-3", "senior");
      const s4 = manager.allocateSlot("senior-agent", "task-4", "senior");

      expect(s1).not.toBeNull();
      expect(s2).not.toBeNull();
      expect(s3).not.toBeNull();
      expect(s4).toBeNull();
    });

    it("different agents do not share slot counts", () => {
      // Exhaust junior capacity for agent-a
      manager.allocateSlot("agent-a", "task-1", "junior");

      // agent-b should still get a slot
      const slot = manager.allocateSlot("agent-b", "task-1", "junior");
      expect(slot).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // releaseSlot()
  // -------------------------------------------------------------------------

  describe("releaseSlot()", () => {
    it("marks the slot as 'completed'", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid")!;
      const released = manager.releaseSlot(slot.slotId, "completed");

      expect(released).not.toBeNull();
      expect(released!.status).toBe("completed");
    });

    it("marks the slot as 'failed'", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid")!;
      const released = manager.releaseSlot(slot.slotId, "failed");

      expect(released).not.toBeNull();
      expect(released!.status).toBe("failed");
    });

    it("sets completedAt to an ISO timestamp", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid")!;
      const released = manager.releaseSlot(slot.slotId, "completed");

      expect(released!.completedAt).toBeDefined();
      expect(() => new Date(released!.completedAt!)).not.toThrow();
    });

    it("frees up a concurrency slot after release", () => {
      // junior has max 1 slot
      const slot = manager.allocateSlot("agent-jr", "task-1", "junior")!;
      expect(manager.allocateSlot("agent-jr", "task-2", "junior")).toBeNull();

      manager.releaseSlot(slot.slotId, "completed");

      // Now a new slot should be allocatable
      const newSlot = manager.allocateSlot("agent-jr", "task-2", "junior");
      expect(newSlot).not.toBeNull();
    });

    it("returns null for an unknown slotId", () => {
      const result = manager.releaseSlot("nonexistent-slot-id", "completed");
      expect(result).toBeNull();
    });

    it("released slot is no longer in getActiveSlots()", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid")!;
      manager.releaseSlot(slot.slotId, "completed");

      const active = manager.getActiveSlots("agent-001");
      expect(active.find((s) => s.slotId === slot.slotId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getActiveSlots()
  // -------------------------------------------------------------------------

  describe("getActiveSlots()", () => {
    it("returns only active slots for the given agent", () => {
      const s1 = manager.allocateSlot("agent-multi", "task-1", "senior")!;
      const s2 = manager.allocateSlot("agent-multi", "task-2", "senior")!;
      manager.releaseSlot(s2.slotId, "completed");

      const active = manager.getActiveSlots("agent-multi");
      expect(active).toHaveLength(1);
      expect(active[0].slotId).toBe(s1.slotId);
    });

    it("returns an empty array when the agent has no active slots", () => {
      const result = manager.getActiveSlots("idle-agent");
      expect(result).toEqual([]);
    });

    it("does not include slots for other agents", () => {
      manager.allocateSlot("agent-a", "task-1", "mid");
      manager.allocateSlot("agent-b", "task-1", "mid");

      const activeForA = manager.getActiveSlots("agent-a");
      expect(activeForA.every((s) => s.agentId === "agent-a")).toBe(true);
    });

    it("returns all active slots when multiple are open", () => {
      manager.allocateSlot("multi-slot", "t1", "lead");
      manager.allocateSlot("multi-slot", "t2", "lead");
      manager.allocateSlot("multi-slot", "t3", "lead");

      const active = manager.getActiveSlots("multi-slot");
      expect(active).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // checkConflicts()
  // -------------------------------------------------------------------------

  describe("checkConflicts()", () => {
    it("detects file overlap between an active slot and target files", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "senior")!;
      manager.updateWorkingFiles(slot.slotId, ["src/server.ts", "src/routes.ts"]);

      const result = manager.checkConflicts("agent-001", ["src/server.ts"]);

      expect(result.hasConflict).toBe(true);
      expect(result.conflictingSlots).toContain(slot.slotId);
    });

    it("reports no conflict when target files differ from active slot files", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "senior")!;
      manager.updateWorkingFiles(slot.slotId, ["src/server.ts"]);

      const result = manager.checkConflicts("agent-001", ["src/unrelated.ts"]);

      expect(result.hasConflict).toBe(false);
      expect(result.conflictingSlots).toHaveLength(0);
    });

    it("reports no conflict when the agent has no active slots", () => {
      const result = manager.checkConflicts("inactive-agent", ["any/file.ts"]);

      expect(result.hasConflict).toBe(false);
      expect(result.conflictingSlots).toEqual([]);
    });

    it("reports no conflict when no target files are provided", () => {
      const slot = manager.allocateSlot("agent-001", "task-1", "mid")!;
      manager.updateWorkingFiles(slot.slotId, ["src/file.ts"]);

      const result = manager.checkConflicts("agent-001", []);

      expect(result.hasConflict).toBe(false);
    });

    it("reports multiple conflicting slots when files overlap across them", () => {
      const s1 = manager.allocateSlot("agent-001", "task-1", "senior")!;
      const s2 = manager.allocateSlot("agent-001", "task-2", "senior")!;
      manager.updateWorkingFiles(s1.slotId, ["shared.ts"]);
      manager.updateWorkingFiles(s2.slotId, ["shared.ts"]);

      const result = manager.checkConflicts("agent-001", ["shared.ts"]);

      expect(result.hasConflict).toBe(true);
      expect(result.conflictingSlots).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // getCapacity()
  // -------------------------------------------------------------------------

  describe("getCapacity()", () => {
    it("returns max as seniority cap, used as 0 and available as max when idle", () => {
      const cap = manager.getCapacity("idle-agent", "senior");
      const expectedMax = SENIORITY_CONFIG["senior"].maxConcurrentTasks;

      expect(cap.max).toBe(expectedMax);
      expect(cap.used).toBe(0);
      expect(cap.available).toBe(expectedMax);
    });

    it("increments used and decrements available as slots are allocated", () => {
      manager.allocateSlot("capacity-agent", "task-1", "mid");

      const cap = manager.getCapacity("capacity-agent", "mid");
      const expectedMax = SENIORITY_CONFIG["mid"].maxConcurrentTasks;

      expect(cap.used).toBe(1);
      expect(cap.available).toBe(expectedMax - 1);
    });

    it("shows available = 0 when at capacity", () => {
      // junior can only have 1 slot
      manager.allocateSlot("jr-cap", "task-1", "junior");

      const cap = manager.getCapacity("jr-cap", "junior");
      expect(cap.used).toBe(1);
      expect(cap.available).toBe(0);
    });

    it("increases available after a slot is released", () => {
      const slot = manager.allocateSlot("agent-re", "task-1", "junior")!;
      manager.releaseSlot(slot.slotId, "completed");

      const cap = manager.getCapacity("agent-re", "junior");
      expect(cap.used).toBe(0);
      expect(cap.available).toBe(SENIORITY_CONFIG["junior"].maxConcurrentTasks);
    });
  });

  // -------------------------------------------------------------------------
  // mergeCompletedSlots()
  // -------------------------------------------------------------------------

  describe("mergeCompletedSlots()", () => {
    it("collects task memories from completed slots", () => {
      const slot = manager.allocateSlot("agent-merge", "task-1", "mid")!;

      // Inject a task memory directly into the slot's contextSnapshot
      const mem = {
        taskId: "task-1",
        timestamp: new Date().toISOString(),
        objective: "build feature",
        approach: "TDD",
        outcome: "success" as const,
        lessonsLearned: [],
        filesModified: [],
        collaborators: [],
        difficulty: 2,
        tokensUsed: 100,
      };
      slot.contextSnapshot.taskMemories.push(mem);

      manager.releaseSlot(slot.slotId, "completed");

      const { mergedMemories } = manager.mergeCompletedSlots("agent-merge");
      expect(mergedMemories).toHaveLength(1);
      expect(mergedMemories[0].taskId).toBe("task-1");
    });

    it("detects file conflicts across completed slots", () => {
      const s1 = manager.allocateSlot("agent-fc", "task-1", "senior")!;
      const s2 = manager.allocateSlot("agent-fc", "task-2", "senior")!;
      manager.updateWorkingFiles(s1.slotId, ["shared/file.ts"]);
      manager.updateWorkingFiles(s2.slotId, ["shared/file.ts"]);

      manager.releaseSlot(s1.slotId, "completed");
      manager.releaseSlot(s2.slotId, "completed");

      const { fileConflicts } = manager.mergeCompletedSlots("agent-fc");
      expect(fileConflicts).toContain("shared/file.ts");
    });

    it("does not report conflicts for files touched by only one slot", () => {
      const s1 = manager.allocateSlot("agent-noconf", "task-1", "senior")!;
      const s2 = manager.allocateSlot("agent-noconf", "task-2", "senior")!;
      manager.updateWorkingFiles(s1.slotId, ["file-a.ts"]);
      manager.updateWorkingFiles(s2.slotId, ["file-b.ts"]);

      manager.releaseSlot(s1.slotId, "completed");
      manager.releaseSlot(s2.slotId, "completed");

      const { fileConflicts } = manager.mergeCompletedSlots("agent-noconf");
      expect(fileConflicts).toHaveLength(0);
    });

    it("cleans up completed slots from internal state after merge", () => {
      const slot = manager.allocateSlot("agent-clean", "task-1", "junior")!;
      manager.releaseSlot(slot.slotId, "completed");

      manager.mergeCompletedSlots("agent-clean");

      // After cleanup, slot should no longer be accessible
      expect(manager.getSlot(slot.slotId)).toBeNull();
    });

    it("returns empty memories and conflicts when no completed slots exist", () => {
      // Create an active (not yet released) slot
      manager.allocateSlot("agent-active-only", "task-1", "junior");

      const { mergedMemories, fileConflicts } =
        manager.mergeCompletedSlots("agent-active-only");

      expect(mergedMemories).toHaveLength(0);
      expect(fileConflicts).toHaveLength(0);
    });

    it("includes memories from failed slots as well as completed ones", () => {
      const slot = manager.allocateSlot("agent-fail", "task-1", "junior")!;
      const mem = {
        taskId: "task-1",
        timestamp: new Date().toISOString(),
        objective: "attempt",
        approach: "",
        outcome: "failure" as const,
        lessonsLearned: [],
        filesModified: [],
        collaborators: [],
        difficulty: 1,
        tokensUsed: 50,
      };
      slot.contextSnapshot.taskMemories.push(mem);

      manager.releaseSlot(slot.slotId, "failed");

      const { mergedMemories } = manager.mergeCompletedSlots("agent-fail");
      expect(mergedMemories).toHaveLength(1);
    });
  });
});
