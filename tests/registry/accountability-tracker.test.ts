import { describe, it, expect, beforeEach } from "vitest";
import { AccountabilityTracker } from "../../src/registry/accountability-tracker.js";
import type { RaciEntry } from "../../src/registry/accountability-tracker.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

function raci(agentId: string, role: RaciEntry["role"]): RaciEntry {
  return { agentId, role };
}

function buildTask(tracker: AccountabilityTracker, title = "Feature X") {
  return tracker.registerTask(title, "Build feature X", [
    raci("agent-cto", "accountable"),
    raci("agent-coder", "responsible"),
    raci("agent-architect", "consulted"),
    raci("agent-coo", "informed"),
  ]);
}

describe("AccountabilityTracker", () => {
  let tracker: AccountabilityTracker;

  beforeEach(() => {
    tracker = new AccountabilityTracker();
  });

  // --- registerTask ---

  describe("registerTask", () => {
    it("registers a task and returns the record", () => {
      const record = buildTask(tracker);
      expect(record.taskId).toBeTruthy();
      expect(record.title).toBe("Feature X");
      expect(record.accountableAgentId).toBe("agent-cto");
      expect(record.status).toBe("open");
    });

    it("throws if no accountable agent", () => {
      expect(() =>
        tracker.registerTask("Bad task", "desc", [
          raci("agent-coder", "responsible"),
        ])
      ).toThrow(/exactly one accountable/);
    });

    it("throws if multiple accountable agents", () => {
      expect(() =>
        tracker.registerTask("Bad task", "desc", [
          raci("agent-a", "accountable"),
          raci("agent-b", "accountable"),
        ])
      ).toThrow(/2 accountable/);
    });

    it("accepts a caller-provided task ID", () => {
      const record = tracker.registerTask("Feature Y", "desc", [
        raci("agent-cto", "accountable"),
      ], "fixed-id-123");
      expect(record.taskId).toBe("fixed-id-123");
    });

    it("throws on duplicate task ID", () => {
      tracker.registerTask("Task A", "desc", [raci("agent-a", "accountable")], "id-1");
      expect(() =>
        tracker.registerTask("Task B", "desc", [raci("agent-b", "accountable")], "id-1")
      ).toThrow(/already exists/);
    });
  });

  // --- startTask ---

  describe("startTask", () => {
    it("transitions open → in_progress", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      expect(tracker.getTask(record.taskId)!.status).toBe("in_progress");
    });

    it("allows accountable agent to start the task", () => {
      const record = buildTask(tracker);
      expect(() => tracker.startTask(record.taskId, "agent-cto")).not.toThrow();
    });

    it("throws if agent is not responsible or accountable", () => {
      const record = buildTask(tracker);
      expect(() => tracker.startTask(record.taskId, "agent-architect")).toThrow(
        /not responsible or accountable/
      );
    });

    it("throws if task is not open", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      expect(() => tracker.startTask(record.taskId, "agent-coder")).toThrow(
        /in_progress/
      );
    });
  });

  // --- completeTask ---

  describe("completeTask", () => {
    it("transitions in_progress → completed", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      tracker.completeTask(record.taskId, "agent-coder");
      const completed = tracker.getTask(record.taskId)!;
      expect(completed.status).toBe("completed");
      expect(completed.completedByAgentId).toBe("agent-coder");
      expect(completed.completedAt).toBeTruthy();
    });

    it("allows accountable agent to complete", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      expect(() =>
        tracker.completeTask(record.taskId, "agent-cto")
      ).not.toThrow();
    });

    it("throws if agent is not responsible or accountable", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      expect(() =>
        tracker.completeTask(record.taskId, "agent-architect")
      ).toThrow(/not accountable or responsible/);
    });

    it("throws if task is not in_progress", () => {
      const record = buildTask(tracker);
      expect(() =>
        tracker.completeTask(record.taskId, "agent-coder")
      ).toThrow(/in_progress/);
    });
  });

  // --- cancelTask ---

  describe("cancelTask", () => {
    it("cancels an open task", () => {
      const record = buildTask(tracker);
      tracker.cancelTask(record.taskId);
      expect(tracker.getTask(record.taskId)!.status).toBe("cancelled");
    });

    it("cancels an in_progress task", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      tracker.cancelTask(record.taskId);
      expect(tracker.getTask(record.taskId)!.status).toBe("cancelled");
    });

    it("throws when cancelling a completed task", () => {
      const record = buildTask(tracker);
      tracker.startTask(record.taskId, "agent-coder");
      tracker.completeTask(record.taskId, "agent-coder");
      expect(() => tracker.cancelTask(record.taskId)).toThrow(/completed/);
    });
  });

  // --- getAccountableFor ---

  describe("getAccountableFor", () => {
    it("returns all tasks where agent is accountable", () => {
      buildTask(tracker, "Task A");
      buildTask(tracker, "Task B");
      tracker.registerTask("Task C", "desc", [
        raci("agent-ceo", "accountable"),
        raci("agent-coder", "responsible"),
      ]);
      const tasks = tracker.getAccountableFor("agent-cto");
      expect(tasks).toHaveLength(2);
    });

    it("returns empty for agent with no accountable tasks", () => {
      expect(tracker.getAccountableFor("nobody")).toHaveLength(0);
    });
  });

  // --- getInvolvedIn ---

  describe("getInvolvedIn", () => {
    it("returns tasks where agent has any RACI role", () => {
      buildTask(tracker);
      const involved = tracker.getInvolvedIn("agent-architect");
      expect(involved).toHaveLength(1);
      expect(involved[0].title).toBe("Feature X");
    });

    it("returns empty for uninvolved agent", () => {
      buildTask(tracker);
      expect(tracker.getInvolvedIn("random-agent")).toHaveLength(0);
    });
  });

  // --- getActiveTasks ---

  describe("getActiveTasks", () => {
    it("returns open and in_progress tasks", () => {
      const r1 = buildTask(tracker, "Task A");
      const r2 = buildTask(tracker, "Task B");
      tracker.startTask(r2.taskId, "agent-coder");
      buildTask(tracker, "Task C");
      tracker.startTask(r1.taskId, "agent-coder");
      tracker.completeTask(r1.taskId, "agent-coder");
      const active = tracker.getActiveTasks("agent-coder");
      // Task A is completed, Task B in_progress, Task C open
      const statuses = active.map((t) => t.status);
      expect(statuses).not.toContain("completed");
      expect(statuses).toContain("in_progress");
      expect(statuses).toContain("open");
    });
  });

  // --- generateRaciMatrix ---

  describe("generateRaciMatrix", () => {
    it("generates matrix for given task IDs", () => {
      const t1 = buildTask(tracker, "Task A");
      const t2 = tracker.registerTask("Task B", "desc", [
        raci("agent-cto", "accountable"),
        raci("agent-architect", "responsible"),
      ]);
      const matrices = tracker.generateRaciMatrix([t1.taskId, t2.taskId]);
      expect(matrices).toHaveLength(2);
      const m1 = matrices[0];
      expect(m1.agents).toContain("agent-cto");
      expect(m1.matrix["agent-cto"][t1.taskId]).toBe("accountable");
    });

    it("throws for unknown task ID", () => {
      expect(() => tracker.generateRaciMatrix(["no-such-id"])).toThrow(/not found/);
    });
  });

  // --- immutability ---

  describe("immutability", () => {
    it("mutations to returned record do not affect tracker", () => {
      const record = buildTask(tracker);
      const retrieved = tracker.getTask(record.taskId)!;
      retrieved.raciEntries[0].agentId = "hacked";
      const fresh = tracker.getTask(record.taskId)!;
      expect(fresh.raciEntries[0].agentId).toBe("agent-cto");
    });
  });

  // --- size ---

  describe("size", () => {
    it("tracks total registered tasks", () => {
      buildTask(tracker);
      buildTask(tracker, "Task B");
      expect(tracker.size()).toBe(2);
    });
  });

  // --- bus integration ---

  describe("bus integration", () => {
    it("emits accountability.task.registered and accountability.task.completed when bus is provided", () => {
      const bus = new V4MessageBus();
      const busTracker = new AccountabilityTracker(bus);
      const record = busTracker.registerTask("Task A", "desc", [
        raci("agent-cto", "accountable"),
        raci("agent-coder", "responsible"),
      ]);
      expect(bus.getHistoryForTopic("accountability.task.registered")).toHaveLength(1);

      busTracker.startTask(record.taskId, "agent-coder");
      busTracker.completeTask(record.taskId, "agent-coder");
      expect(bus.getHistoryForTopic("accountability.task.completed")).toHaveLength(1);
    });
  });
});
