/**
 * TaskPipeline — v4.5 P0-1
 *
 * Multi-agent task pipeline engine with DAG-based stage execution.
 * Stages run in topological order, with parallel execution for
 * independent stages (no shared dependencies).
 *
 * Each stage result is injected as context into dependent stages
 * via `{{stageId}}` placeholders in the task template.
 *
 * Zero new npm dependencies (Iron Law 5).
 */

import { randomUUID } from "node:crypto";
import type {
  PipelineDefinition,
  PipelineResult,
  PipelineStage,
  PipelineStageStatus,
  PipelineStatus,
} from "../types/pipeline.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Executor function for a single stage. Implementations should dispatch
 * to the appropriate agent and return the result string.
 */
export type StageExecutor = (
  stage: PipelineStage,
  upstreamResults: Map<string, string>,
) => Promise<{ result: string; durationMs: number }>;

export interface TaskPipelineOptions {
  /** The message bus for emitting pipeline events. */
  bus?: V4MessageBus;
  /** Custom executor for stages. Defaults to a no-op executor for testing. */
  executor?: StageExecutor;
}

// ---------------------------------------------------------------------------
// Default executor (for testing — returns a placeholder response)
// ---------------------------------------------------------------------------

const defaultExecutor: StageExecutor = async (stage, _upstream) => {
  return {
    result: `[${stage.agentId}] completed: ${stage.task}`,
    durationMs: 0,
  };
};

// ---------------------------------------------------------------------------
// TaskPipeline
// ---------------------------------------------------------------------------

export class TaskPipeline {
  private readonly bus?: V4MessageBus;
  private readonly executor: StageExecutor;

  constructor(options?: TaskPipelineOptions) {
    this.bus = options?.bus;
    this.executor = options?.executor ?? defaultExecutor;
  }

  // =========================================================================
  // Pipeline creation
  // =========================================================================

  /**
   * Create a new pipeline definition from a list of stage descriptors.
   */
  createPipeline(
    name: string,
    description: string,
    stages: Array<{
      name: string;
      agentId: string;
      task: string;
      dependsOn?: string[];
    }>,
  ): PipelineDefinition {
    const pipelineId = randomUUID();

    // Validate: no duplicate stage names
    const names = new Set<string>();
    for (const s of stages) {
      if (names.has(s.name)) {
        throw new Error(`Duplicate stage name: "${s.name}"`);
      }
      names.add(s.name);
    }

    // Validate: all dependsOn references exist
    for (const s of stages) {
      for (const dep of s.dependsOn ?? []) {
        if (!names.has(dep)) {
          throw new Error(
            `Stage "${s.name}" depends on unknown stage "${dep}"`,
          );
        }
      }
    }

    // Validate: no circular dependencies
    this.detectCycles(stages);

    const pipelineStages: PipelineStage[] = stages.map((s) => ({
      id: s.name, // Use name as ID for readability
      name: s.name,
      agentId: s.agentId,
      task: s.task,
      dependsOn: s.dependsOn ?? [],
      status: "pending" as PipelineStageStatus,
    }));

    return {
      id: pipelineId,
      name,
      description,
      stages: pipelineStages,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Pipeline execution
  // =========================================================================

  /**
   * Execute a pipeline by walking the stage DAG in topological order.
   * Independent stages (no mutual dependencies) run in parallel.
   */
  async execute(pipeline: PipelineDefinition): Promise<PipelineResult> {
    const startTime = Date.now();
    pipeline.status = "running";

    this.emitEvent("pipeline.started", {
      pipelineId: pipeline.id,
      name: pipeline.name,
      totalStages: pipeline.stages.length,
    });

    const results = new Map<string, string>();
    const stageMap = new Map<string, PipelineStage>();
    for (const stage of pipeline.stages) {
      stageMap.set(stage.id, stage);
    }

    // Execute in topological layers
    const layers = this.topologicalLayers(pipeline.stages);
    let hasFailure = false;

    for (const layer of layers) {
      if (hasFailure) {
        // Skip remaining stages if a prior stage failed
        for (const stageId of layer) {
          const stage = stageMap.get(stageId)!;
          stage.status = "skipped";
        }
        continue;
      }

      // Execute all stages in this layer in parallel
      const layerPromises = layer.map(async (stageId) => {
        const stage = stageMap.get(stageId)!;

        // Check if all dependencies completed successfully
        const depsFailed = stage.dependsOn.some((depId) => {
          const dep = stageMap.get(depId);
          return dep && dep.status !== "completed";
        });

        if (depsFailed) {
          stage.status = "skipped";
          return;
        }

        // Resolve task template placeholders with upstream results
        let resolvedTask = stage.task;
        for (const [id, result] of results) {
          resolvedTask = resolvedTask.replace(
            new RegExp(`\\{\\{${id}\\}\\}`, "g"),
            result,
          );
        }
        stage.task = resolvedTask;

        // Execute the stage
        stage.status = "running";
        stage.startedAt = new Date().toISOString();

        try {
          const outcome = await this.executor(stage, results);
          stage.result = outcome.result;
          stage.durationMs = outcome.durationMs;
          stage.status = "completed";
          stage.completedAt = new Date().toISOString();
          results.set(stage.id, outcome.result);

          this.emitEvent("pipeline.stage.completed", {
            pipelineId: pipeline.id,
            stageId: stage.id,
            stageName: stage.name,
            agentId: stage.agentId,
            status: "completed",
          });
        } catch (err) {
          stage.status = "failed";
          stage.error =
            err instanceof Error ? err.message : String(err);
          stage.completedAt = new Date().toISOString();
          hasFailure = true;

          this.emitEvent("pipeline.stage.completed", {
            pipelineId: pipeline.id,
            stageId: stage.id,
            stageName: stage.name,
            agentId: stage.agentId,
            status: "failed",
            error: stage.error,
          });
        }
      });

      await Promise.allSettled(layerPromises);
    }

    // Determine final status
    const completedCount = pipeline.stages.filter(
      (s) => s.status === "completed",
    ).length;
    const failedCount = pipeline.stages.filter(
      (s) => s.status === "failed",
    ).length;
    const totalDurationMs = Date.now() - startTime;

    if (failedCount > 0 && completedCount > 0) {
      pipeline.status = "partial";
    } else if (failedCount > 0) {
      pipeline.status = "failed";
    } else {
      pipeline.status = "completed";
    }

    pipeline.completedAt = new Date().toISOString();
    pipeline.totalDurationMs = totalDurationMs;

    const pipelineResult: PipelineResult = {
      pipelineId: pipeline.id,
      status: pipeline.status,
      stageResults: pipeline.stages.map((s) => ({
        stageId: s.id,
        stageName: s.name,
        agentId: s.agentId,
        status: s.status,
        result: s.result,
        error: s.error,
        durationMs: s.durationMs,
      })),
      completedStages: completedCount,
      failedStages: failedCount,
      totalStages: pipeline.stages.length,
      totalDurationMs,
    };

    this.emitEvent("pipeline.completed", {
      pipelineId: pipeline.id,
      status: pipeline.status,
      completedStages: completedCount,
      failedStages: failedCount,
      totalStages: pipeline.stages.length,
    });

    return pipelineResult;
  }

  // =========================================================================
  // Topological sort into layers
  // =========================================================================

  /**
   * Compute topological layers for parallel execution.
   * Each layer contains stages whose dependencies are all in earlier layers.
   */
  topologicalLayers(stages: PipelineStage[]): string[][] {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const stage of stages) {
      inDegree.set(stage.id, stage.dependsOn.length);
      for (const dep of stage.dependsOn) {
        const list = dependents.get(dep) ?? [];
        list.push(stage.id);
        dependents.set(dep, list);
      }
    }

    const layers: string[][] = [];
    const remaining = new Set(stages.map((s) => s.id));

    while (remaining.size > 0) {
      const layer: string[] = [];
      for (const id of remaining) {
        if ((inDegree.get(id) ?? 0) === 0) {
          layer.push(id);
        }
      }

      if (layer.length === 0) {
        // Should not happen if cycle detection is correct
        throw new Error("Cycle detected in pipeline stages");
      }

      for (const id of layer) {
        remaining.delete(id);
        for (const dep of dependents.get(id) ?? []) {
          inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
        }
      }

      layers.push(layer);
    }

    return layers;
  }

  // =========================================================================
  // Cycle detection
  // =========================================================================

  private detectCycles(
    stages: Array<{ name: string; dependsOn?: string[] }>,
  ): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const adj = new Map<string, string[]>();

    for (const s of stages) {
      adj.set(s.name, s.dependsOn ?? []);
    }

    const dfs = (node: string): void => {
      if (inStack.has(node)) {
        throw new Error(`Circular dependency detected involving stage "${node}"`);
      }
      if (visited.has(node)) return;
      inStack.add(node);
      for (const dep of adj.get(node) ?? []) {
        dfs(dep);
      }
      inStack.delete(node);
      visited.add(node);
    };

    for (const s of stages) {
      dfs(s.name);
    }
  }

  // =========================================================================
  // Bus event emission
  // =========================================================================

  private emitEvent(topic: string, payload: Record<string, unknown>): void {
    if (!this.bus) return;
    this.bus.publish({
      from: "pipeline-engine",
      to: "broadcast",
      topic,
      category: "status",
      payload,
      priority: "normal",
    });
  }
}
