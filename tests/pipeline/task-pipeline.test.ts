/**
 * Tests for TaskPipeline — v4.5 P0-1
 */
import { describe, it, expect, vi } from "vitest";
import { TaskPipeline, type StageExecutor } from "../../src/pipeline/task-pipeline.js";
import type { PipelineStage } from "../../src/types/pipeline.js";
import { V4MessageBus } from "../../src/communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecutor(
  results?: Record<string, string>,
  errors?: Set<string>,
): StageExecutor {
  return async (stage: PipelineStage, _upstream) => {
    if (errors?.has(stage.id)) {
      throw new Error(`Stage "${stage.id}" execution failed`);
    }
    return {
      result: results?.[stage.id] ?? `result-from-${stage.id}`,
      durationMs: 10,
    };
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskPipeline", () => {
  describe("createPipeline", () => {
    it("creates a pipeline with stages in pending status", () => {
      const tp = new TaskPipeline();
      const pipeline = tp.createPipeline("test", "A test pipeline", [
        { name: "stage-1", agentId: "coder", task: "Do thing 1" },
        { name: "stage-2", agentId: "reviewer", task: "Review thing 1", dependsOn: ["stage-1"] },
      ]);

      expect(pipeline.name).toBe("test");
      expect(pipeline.status).toBe("pending");
      expect(pipeline.stages).toHaveLength(2);
      expect(pipeline.stages[0].status).toBe("pending");
      expect(pipeline.stages[1].status).toBe("pending");
      expect(pipeline.stages[1].dependsOn).toEqual(["stage-1"]);
    });

    it("rejects duplicate stage names", () => {
      const tp = new TaskPipeline();
      expect(() =>
        tp.createPipeline("test", "desc", [
          { name: "stage-1", agentId: "a", task: "t" },
          { name: "stage-1", agentId: "b", task: "t2" },
        ]),
      ).toThrow(/Duplicate stage name/);
    });

    it("rejects unknown dependency references", () => {
      const tp = new TaskPipeline();
      expect(() =>
        tp.createPipeline("test", "desc", [
          { name: "stage-1", agentId: "a", task: "t", dependsOn: ["nonexistent"] },
        ]),
      ).toThrow(/unknown stage/);
    });

    it("rejects circular dependencies", () => {
      const tp = new TaskPipeline();
      expect(() =>
        tp.createPipeline("test", "desc", [
          { name: "a", agentId: "x", task: "t", dependsOn: ["b"] },
          { name: "b", agentId: "x", task: "t", dependsOn: ["a"] },
        ]),
      ).toThrow(/Circular dependency/);
    });
  });

  describe("topologicalLayers", () => {
    it("computes correct layers for a linear pipeline", () => {
      const tp = new TaskPipeline();
      const stages: PipelineStage[] = [
        { id: "a", name: "a", agentId: "x", task: "t", dependsOn: [], status: "pending" },
        { id: "b", name: "b", agentId: "x", task: "t", dependsOn: ["a"], status: "pending" },
        { id: "c", name: "c", agentId: "x", task: "t", dependsOn: ["b"], status: "pending" },
      ];

      const layers = tp.topologicalLayers(stages);
      expect(layers).toHaveLength(3);
      expect(layers[0]).toEqual(["a"]);
      expect(layers[1]).toEqual(["b"]);
      expect(layers[2]).toEqual(["c"]);
    });

    it("groups independent stages into the same layer", () => {
      const tp = new TaskPipeline();
      const stages: PipelineStage[] = [
        { id: "a", name: "a", agentId: "x", task: "t", dependsOn: [], status: "pending" },
        { id: "b", name: "b", agentId: "x", task: "t", dependsOn: [], status: "pending" },
        { id: "c", name: "c", agentId: "x", task: "t", dependsOn: ["a", "b"], status: "pending" },
      ];

      const layers = tp.topologicalLayers(stages);
      expect(layers).toHaveLength(2);
      expect(layers[0]).toContain("a");
      expect(layers[0]).toContain("b");
      expect(layers[1]).toEqual(["c"]);
    });
  });

  describe("execute", () => {
    it("executes a linear pipeline in order", async () => {
      const executionOrder: string[] = [];
      const executor: StageExecutor = async (stage) => {
        executionOrder.push(stage.id);
        return { result: `done-${stage.id}`, durationMs: 5 };
      };

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "first", agentId: "a", task: "do first" },
        { name: "second", agentId: "b", task: "do second", dependsOn: ["first"] },
        { name: "third", agentId: "c", task: "do third", dependsOn: ["second"] },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedStages).toBe(3);
      expect(result.failedStages).toBe(0);
      expect(executionOrder).toEqual(["first", "second", "third"]);
    });

    it("executes parallel stages concurrently", async () => {
      const executor = makeExecutor({
        research: "research findings",
        code: "code output",
        merge: "merged result",
      });

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "research", agentId: "researcher", task: "research" },
        { name: "code", agentId: "coder", task: "code" },
        { name: "merge", agentId: "cto", task: "merge", dependsOn: ["research", "code"] },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedStages).toBe(3);
    });

    it("resolves {{stageId}} placeholders in task templates", async () => {
      const capturedTasks: string[] = [];
      const executor: StageExecutor = async (stage) => {
        capturedTasks.push(stage.task);
        return { result: `output-of-${stage.id}`, durationMs: 1 };
      };

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "analyze", agentId: "a", task: "analyze the code" },
        { name: "act", agentId: "b", task: "Based on: {{analyze}}", dependsOn: ["analyze"] },
      ]);

      await tp.execute(pipeline);

      expect(capturedTasks[1]).toBe("Based on: output-of-analyze");
    });

    it("marks downstream stages as skipped when a dependency fails", async () => {
      const executor = makeExecutor(undefined, new Set(["stage-2"]));

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "stage-1", agentId: "a", task: "t1" },
        { name: "stage-2", agentId: "b", task: "t2", dependsOn: ["stage-1"] },
        { name: "stage-3", agentId: "c", task: "t3", dependsOn: ["stage-2"] },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("partial");
      expect(result.completedStages).toBe(1);
      expect(result.failedStages).toBe(1);
      expect(pipeline.stages[2].status).toBe("skipped");
    });

    it("reports partial status when some stages succeed and some fail", async () => {
      const executor = makeExecutor(undefined, new Set(["fail-stage"]));

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "ok-stage", agentId: "a", task: "ok" },
        { name: "fail-stage", agentId: "b", task: "fail", dependsOn: ["ok-stage"] },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("partial");
      expect(result.completedStages).toBe(1);
      expect(result.failedStages).toBe(1);
    });

    it("emits bus events during execution", async () => {
      const bus = new V4MessageBus();
      const events: string[] = [];
      bus.onAnyMessage((env) => events.push(env.topic));

      const tp = new TaskPipeline({ bus, executor: makeExecutor() });
      const pipeline = tp.createPipeline("test", "desc", [
        { name: "s1", agentId: "a", task: "t" },
      ]);

      await tp.execute(pipeline);

      expect(events).toContain("pipeline.started");
      expect(events).toContain("pipeline.stage.completed");
      expect(events).toContain("pipeline.completed");
    });

    it("handles a pipeline with a single stage", async () => {
      const tp = new TaskPipeline({ executor: makeExecutor() });
      const pipeline = tp.createPipeline("single", "desc", [
        { name: "only", agentId: "a", task: "solo task" },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.totalStages).toBe(1);
      expect(result.completedStages).toBe(1);
    });

    it("handles a diamond dependency pattern", async () => {
      const executionOrder: string[] = [];
      const executor: StageExecutor = async (stage) => {
        executionOrder.push(stage.id);
        return { result: `done-${stage.id}`, durationMs: 1 };
      };

      const tp = new TaskPipeline({ executor });
      const pipeline = tp.createPipeline("diamond", "desc", [
        { name: "start", agentId: "a", task: "start" },
        { name: "left", agentId: "b", task: "left", dependsOn: ["start"] },
        { name: "right", agentId: "c", task: "right", dependsOn: ["start"] },
        { name: "end", agentId: "d", task: "end", dependsOn: ["left", "right"] },
      ]);

      const result = await tp.execute(pipeline);

      expect(result.status).toBe("completed");
      expect(result.completedStages).toBe(4);
      // "start" must come before "left" and "right", which must come before "end"
      expect(executionOrder.indexOf("start")).toBeLessThan(executionOrder.indexOf("left"));
      expect(executionOrder.indexOf("start")).toBeLessThan(executionOrder.indexOf("right"));
      expect(executionOrder.indexOf("left")).toBeLessThan(executionOrder.indexOf("end"));
      expect(executionOrder.indexOf("right")).toBeLessThan(executionOrder.indexOf("end"));
    });
  });
});
