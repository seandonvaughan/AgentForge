import { describe, it, expect, beforeEach } from "vitest";
import {
  AutonomousSprintFramework,
  type SprintPhase,
} from "../../src/autonomous/sprint-framework.js";

describe("AutonomousSprintFramework", () => {
  let fw: AutonomousSprintFramework;
  beforeEach(() => { fw = new AutonomousSprintFramework(); });

  describe("createSprint", () => {
    it("creates a sprint in audit phase", () => {
      const s = fw.createSprint("4.3", "Autonomous v4.3", 300, 37);
      expect(s.version).toBe("4.3");
      expect(s.phase).toBe("audit");
      expect(s.budget).toBe(300);
      expect(s.teamSize).toBe(37);
    });
    it("assigns unique sprint ids", () => {
      const a = fw.createSprint("4.3", "A", 100, 10);
      const b = fw.createSprint("4.4", "B", 100, 10);
      expect(a.sprintId).not.toBe(b.sprintId);
    });
  });

  describe("phase advancement", () => {
    it("advances through all 9 phases in order", () => {
      const s = fw.createSprint("4.3", "Test", 100, 10);
      const expected: SprintPhase[] = [
        "audit", "plan", "assign", "execute", "test", "review", "gate", "release", "learn",
      ];
      expect(fw.getPhase(s.sprintId)).toBe("audit");
      for (let i = 1; i < expected.length; i++) {
        fw.advancePhase(s.sprintId);
        expect(fw.getPhase(s.sprintId)).toBe(expected[i]);
      }
    });
    it("throws on advancing past final phase", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      for (let i = 0; i < 8; i++) fw.advancePhase(s.sprintId);
      expect(() => fw.advancePhase(s.sprintId)).toThrow(/final phase/);
    });
  });

  describe("audit", () => {
    it("records audit findings", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      fw.recordAuditFindings(s.sprintId, ["Search accuracy at 95%", "No CI pipeline"]);
      const sprint = fw.getSprint(s.sprintId)!;
      expect(sprint.auditFindings).toHaveLength(2);
    });
  });

  describe("planning", () => {
    it("adds items with priority and assignee", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      const item = fw.addItem(s.sprintId, {
        title: "Add embedding search",
        description: "Replace TF-IDF with embeddings",
        priority: "P0",
        assignee: "search-engineer",
      });
      expect(item.id).toBeTruthy();
      expect(item.status).toBe("planned");
      expect(fw.getSprint(s.sprintId)!.items).toHaveLength(1);
    });
    it("sets success criteria", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      fw.setSuccessCriteria(s.sprintId, ["All tests pass", "Dashboard reads real data"]);
      expect(fw.getSprint(s.sprintId)!.successCriteria).toHaveLength(2);
    });
  });

  describe("execution", () => {
    it("start → complete lifecycle", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      const item = fw.addItem(s.sprintId, {
        title: "Task 1", description: "D", priority: "P0", assignee: "coder",
      });
      fw.startItem(s.sprintId, item.id);
      expect(fw.getSprint(s.sprintId)!.items[0].status).toBe("in_progress");
      fw.completeItem(s.sprintId, item.id);
      const completed = fw.getSprint(s.sprintId)!.items[0];
      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeTruthy();
    });
    it("block and defer items", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      const a = fw.addItem(s.sprintId, { title: "A", description: "", priority: "P0", assignee: "x" });
      const b = fw.addItem(s.sprintId, { title: "B", description: "", priority: "P2", assignee: "y" });
      fw.blockItem(s.sprintId, a.id);
      fw.deferItem(s.sprintId, b.id);
      const sprint = fw.getSprint(s.sprintId)!;
      expect(sprint.items[0].status).toBe("blocked");
      expect(sprint.items[1].status).toBe("deferred");
    });
  });

  describe("progress tracking", () => {
    it("calculates completion percentage", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      fw.addItem(s.sprintId, { title: "A", description: "", priority: "P0", assignee: "x" });
      const b = fw.addItem(s.sprintId, { title: "B", description: "", priority: "P0", assignee: "y" });
      fw.completeItem(s.sprintId, b.id);
      const progress = fw.getProgress(s.sprintId);
      expect(progress.completed).toBe(1);
      expect(progress.total).toBe(2);
      expect(progress.pct).toBe(50);
    });
    it("returns 0% for empty sprint", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      expect(fw.getProgress(s.sprintId).pct).toBe(0);
    });
  });

  describe("gate result", () => {
    it("records sprint result with verdict", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      const result = fw.recordResult(s.sprintId, {
        phase: "gate",
        itemsCompleted: 15,
        itemsTotal: 18,
        testsPassing: 1500,
        testsTotal: 1500,
        budgetUsed: 250,
        gateVerdict: "approved",
        learnings: ["Parallel agents cut time 3x"],
      });
      expect(result.gateVerdict).toBe("approved");
      expect(result.version).toBe("4.3");
    });
  });

  describe("serialization", () => {
    it("toJSON / fromJSON round-trip", () => {
      const s = fw.createSprint("4.3", "Sprint", 200, 37);
      fw.addItem(s.sprintId, { title: "Item", description: "D", priority: "P0", assignee: "coder" });
      fw.recordAuditFindings(s.sprintId, ["Finding 1"]);
      const json = fw.toJSON();
      const restored = AutonomousSprintFramework.fromJSON(json);
      const sprint = restored.getSprint(s.sprintId)!;
      expect(sprint.version).toBe("4.3");
      expect(sprint.items).toHaveLength(1);
      expect(sprint.auditFindings).toHaveLength(1);
    });
  });

  describe("query", () => {
    it("listSprints returns all sprints", () => {
      fw.createSprint("4.3", "A", 100, 10);
      fw.createSprint("4.4", "B", 100, 10);
      expect(fw.listSprints()).toHaveLength(2);
    });
    it("getSprint returns null for unknown id", () => {
      expect(fw.getSprint("nope")).toBeNull();
    });
    it("getPhaseOrder returns all 9 phases", () => {
      expect(fw.getPhaseOrder()).toHaveLength(9);
    });
  });

  describe("immutability", () => {
    it("returned sprints are copies", () => {
      const s = fw.createSprint("4.3", "T", 100, 10);
      const retrieved = fw.getSprint(s.sprintId)!;
      retrieved.version = "MUTATED";
      expect(fw.getSprint(s.sprintId)!.version).toBe("4.3");
    });
  });

  describe("full autonomous cycle simulation", () => {
    it("completes 9-phase cycle with items", () => {
      const s = fw.createSprint("4.3", "Autonomous v4.3", 300, 37);

      // Audit
      fw.recordAuditFindings(s.sprintId, ["Dashboard needs real data", "Search needs embeddings"]);
      fw.advancePhase(s.sprintId);

      // Plan
      const item1 = fw.addItem(s.sprintId, {
        title: "Live dashboard", description: "Real data binding",
        priority: "P0", assignee: "frontend-dev",
      });
      const item2 = fw.addItem(s.sprintId, {
        title: "Embedding search", description: "Replace TF-IDF",
        priority: "P0", assignee: "search-engineer",
      });
      fw.setSuccessCriteria(s.sprintId, ["Dashboard reads real data", ">98% search accuracy"]);
      fw.advancePhase(s.sprintId);

      // Assign (items already assigned above)
      fw.advancePhase(s.sprintId);

      // Execute
      fw.startItem(s.sprintId, item1.id);
      fw.startItem(s.sprintId, item2.id);
      fw.completeItem(s.sprintId, item1.id);
      fw.completeItem(s.sprintId, item2.id);
      fw.advancePhase(s.sprintId);

      // Test
      fw.advancePhase(s.sprintId);

      // Review
      fw.advancePhase(s.sprintId);

      // Gate
      fw.recordResult(s.sprintId, {
        phase: "gate", itemsCompleted: 2, itemsTotal: 2,
        testsPassing: 1500, testsTotal: 1500,
        budgetUsed: 200, gateVerdict: "approved",
        learnings: ["Autonomous planning works"],
      });
      fw.advancePhase(s.sprintId);

      // Release
      fw.advancePhase(s.sprintId);

      // Learn
      expect(fw.getPhase(s.sprintId)).toBe("learn");
      expect(fw.getProgress(s.sprintId).pct).toBe(100);
      expect(fw.getResult(s.sprintId)!.gateVerdict).toBe("approved");
    });
  });
});
