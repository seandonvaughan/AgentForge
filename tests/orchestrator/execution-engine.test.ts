import { describe, it, expect, beforeEach } from "vitest";
import { ExecutionEngine } from "../../src/orchestrator/execution-engine.js";
import type { TeamManifest } from "../../src/types/team.js";

const manifest: TeamManifest = {
  name: "Test Team",
  forged_at: "2025-01-01T00:00:00Z",
  forged_by: "test",
  project_hash: "abc123",
  agents: {
    strategic: ["architect"],
    implementation: ["coder"],
    quality: ["test-engineer"],
    utility: ["file-reader"],
  },
  model_routing: {
    opus: ["architect"],
    sonnet: ["coder", "test-engineer"],
    haiku: ["file-reader"],
  },
  delegation_graph: {
    architect: ["coder"],
    coder: ["test-engineer", "file-reader"],
    "test-engineer": [],
    "file-reader": [],
  },
};

describe("execution-engine", () => {
  let engine: ExecutionEngine;

  beforeEach(() => {
    engine = new ExecutionEngine(manifest);
  });

  describe("createExecution", () => {
    it("should create an execution with a unique ID", () => {
      const exec = engine.createExecution("coder", "implement login");

      expect(exec.id).toBeTruthy();
      expect(typeof exec.id).toBe("string");
      expect(exec.agent).toBe("coder");
      expect(exec.task).toBe("implement login");
      expect(exec.status).toBe("pending");
      expect(exec.started_at).toBeNull();
      expect(exec.completed_at).toBeNull();
      expect(exec.result).toBeNull();
      expect(exec.delegations).toEqual([]);
    });

    it("should generate unique IDs for multiple executions", () => {
      const exec1 = engine.createExecution("coder", "task 1");
      const exec2 = engine.createExecution("coder", "task 2");
      const exec3 = engine.createExecution("architect", "task 3");

      const ids = new Set([exec1.id, exec2.id, exec3.id]);
      expect(ids.size).toBe(3);
    });
  });

  describe("planExecution", () => {
    it("should place independent tasks in the same parallel group", () => {
      // test-engineer and file-reader have no delegation relationship between them
      const task1 = engine.createExecution("test-engineer", "write tests");
      const task2 = engine.createExecution("file-reader", "read config");

      const plan = engine.planExecution([task1, task2]);

      expect(plan.tasks).toHaveLength(2);
      // Both should be in the first parallel group since they are independent
      expect(plan.parallel_groups).toHaveLength(1);
      expect(plan.parallel_groups[0]).toContain(task1.id);
      expect(plan.parallel_groups[0]).toContain(task2.id);
    });

    it("should separate dependent tasks into different groups", () => {
      // architect can delegate to coder, so coder depends on architect
      const architectTask = engine.createExecution(
        "architect",
        "plan the feature"
      );
      const coderTask = engine.createExecution("coder", "implement feature");

      const plan = engine.planExecution([architectTask, coderTask]);

      expect(plan.parallel_groups.length).toBeGreaterThanOrEqual(2);
      // architect should be in group 0, coder in group 1
      expect(plan.parallel_groups[0]).toContain(architectTask.id);
      expect(plan.parallel_groups[1]).toContain(coderTask.id);
    });

    it("should create a multi-level dependency chain", () => {
      // architect -> coder -> test-engineer
      const t1 = engine.createExecution("architect", "design");
      const t2 = engine.createExecution("coder", "build");
      const t3 = engine.createExecution("test-engineer", "test");

      const plan = engine.planExecution([t1, t2, t3]);

      expect(plan.parallel_groups.length).toBeGreaterThanOrEqual(3);
      expect(plan.parallel_groups[0]).toContain(t1.id);
      expect(plan.parallel_groups[1]).toContain(t2.id);
      expect(plan.parallel_groups[2]).toContain(t3.id);
    });

    it("should track dependencies correctly", () => {
      const t1 = engine.createExecution("architect", "plan");
      const t2 = engine.createExecution("coder", "code");

      const plan = engine.planExecution([t1, t2]);

      // coder task depends on architect task
      expect(plan.dependencies[t2.id]).toContain(t1.id);
      // architect task has no dependencies
      expect(plan.dependencies[t1.id]).toEqual([]);
    });

    it("should handle a single task", () => {
      const task = engine.createExecution("coder", "solo task");

      const plan = engine.planExecution([task]);

      expect(plan.parallel_groups).toHaveLength(1);
      expect(plan.parallel_groups[0]).toContain(task.id);
    });

    it("should handle empty task list", () => {
      const plan = engine.planExecution([]);

      expect(plan.tasks).toEqual([]);
      expect(plan.parallel_groups).toEqual([]);
    });
  });

  describe("getStatus", () => {
    it("should return correct counts for pending tasks", () => {
      engine.createExecution("coder", "task 1");
      engine.createExecution("architect", "task 2");

      const status = engine.getStatus();

      expect(status.pending).toBe(2);
      expect(status.running).toBe(0);
      expect(status.completed).toBe(0);
      expect(status.failed).toBe(0);
    });

    it("should track status changes", () => {
      const exec = engine.createExecution("coder", "task");
      exec.status = "running";

      const status = engine.getStatus();

      expect(status.running).toBe(1);
      expect(status.pending).toBe(0);
    });

    it("should count mixed statuses correctly", () => {
      const exec1 = engine.createExecution("coder", "task 1");
      const exec2 = engine.createExecution("architect", "task 2");
      const exec3 = engine.createExecution("test-engineer", "task 3");
      const exec4 = engine.createExecution("file-reader", "task 4");

      exec1.status = "running";
      exec2.status = "completed";
      exec3.status = "failed";
      // exec4 stays pending

      const status = engine.getStatus();

      expect(status.running).toBe(1);
      expect(status.completed).toBe(1);
      expect(status.failed).toBe(1);
      expect(status.pending).toBe(1);
    });

    it("should return all zeros when no executions exist", () => {
      const status = engine.getStatus();

      expect(status.running).toBe(0);
      expect(status.completed).toBe(0);
      expect(status.failed).toBe(0);
      expect(status.pending).toBe(0);
    });
  });
});
