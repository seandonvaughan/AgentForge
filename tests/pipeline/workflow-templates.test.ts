/**
 * Tests for WorkflowRegistry — v4.5 P0-4
 */
import { describe, it, expect } from "vitest";
import { WorkflowRegistry } from "../../src/pipeline/workflow-templates.js";

describe("WorkflowRegistry", () => {
  describe("built-in workflows", () => {
    it("has 4 built-in workflow templates", () => {
      const registry = new WorkflowRegistry();
      const templates = registry.list();
      expect(templates).toHaveLength(4);
    });

    it("includes code-review workflow", () => {
      const registry = new WorkflowRegistry();
      const template = registry.get("code-review");
      expect(template).not.toBeNull();
      expect(template!.name).toBe("code-review");
      expect(template!.stages).toHaveLength(4);
      expect(template!.requiredAgents).toContain("coder");
      expect(template!.requiredAgents).toContain("researcher");
      expect(template!.requiredAgents).toContain("team-reviewer");
    });

    it("includes bug-investigation workflow", () => {
      const registry = new WorkflowRegistry();
      const template = registry.get("bug-investigation");
      expect(template).not.toBeNull();
      expect(template!.stages).toHaveLength(4);
      expect(template!.requiredAgents).toContain("debugger");
    });

    it("includes feature-design workflow", () => {
      const registry = new WorkflowRegistry();
      const template = registry.get("feature-design");
      expect(template).not.toBeNull();
      expect(template!.stages).toHaveLength(4);
      expect(template!.requiredAgents).toContain("architect");
      expect(template!.requiredAgents).toContain("cto");
    });

    it("includes knowledge-sync workflow", () => {
      const registry = new WorkflowRegistry();
      const template = registry.get("knowledge-sync");
      expect(template).not.toBeNull();
      expect(template!.stages).toHaveLength(3);
      expect(template!.requiredAgents).toContain("researcher");
    });
  });

  describe("registration", () => {
    it("allows registering custom workflows", () => {
      const registry = new WorkflowRegistry();
      registry.register({
        name: "custom",
        description: "A custom workflow",
        stages: [
          {
            name: "step-1",
            agentId: "coder",
            taskTemplate: "Do {{thing}}",
            dependsOn: [],
          },
        ],
        requiredAgents: ["coder"],
        parameters: ["thing"],
      });

      expect(registry.has("custom")).toBe(true);
      expect(registry.list()).toHaveLength(5);
    });

    it("allows unregistering workflows", () => {
      const registry = new WorkflowRegistry();
      expect(registry.unregister("code-review")).toBe(true);
      expect(registry.has("code-review")).toBe(false);
      expect(registry.list()).toHaveLength(3);
    });

    it("returns false when unregistering non-existent workflow", () => {
      const registry = new WorkflowRegistry();
      expect(registry.unregister("nonexistent")).toBe(false);
    });
  });

  describe("get", () => {
    it("returns null for non-existent workflow", () => {
      const registry = new WorkflowRegistry();
      expect(registry.get("nonexistent")).toBeNull();
    });

    it("returns a deep copy (mutations do not affect registry)", () => {
      const registry = new WorkflowRegistry();
      const template = registry.get("code-review")!;
      template.stages = [];
      template.requiredAgents = [];

      const original = registry.get("code-review")!;
      expect(original.stages.length).toBeGreaterThan(0);
      expect(original.requiredAgents.length).toBeGreaterThan(0);
    });
  });

  describe("instantiate", () => {
    it("instantiates a workflow into a PipelineDefinition", () => {
      const registry = new WorkflowRegistry();
      const pipeline = registry.instantiate("code-review", {
        targetFile: "src/foo.ts",
        targetDescription: "Add error handling",
      });

      expect(pipeline.id).toBeTruthy();
      expect(pipeline.name).toContain("code-review");
      expect(pipeline.status).toBe("pending");
      expect(pipeline.stages).toHaveLength(4);
    });

    it("resolves parameter placeholders in task templates", () => {
      const registry = new WorkflowRegistry();
      const pipeline = registry.instantiate("code-review", {
        targetFile: "src/bar.ts",
        targetDescription: "Fix the null check",
      });

      const gatherStage = pipeline.stages[0];
      expect(gatherStage.task).toContain("Fix the null check");
      expect(gatherStage.task).toContain("src/bar.ts");
      expect(gatherStage.task).not.toContain("{{");
    });

    it("preserves dependency structure", () => {
      const registry = new WorkflowRegistry();
      const pipeline = registry.instantiate("bug-investigation", {
        bugDescription: "Null pointer in parser",
      });

      const rootCauseStage = pipeline.stages.find((s) => s.name === "root-cause")!;
      expect(rootCauseStage.dependsOn).toEqual(["reproduce"]);

      const fixStage = pipeline.stages.find((s) => s.name === "fix")!;
      expect(fixStage.dependsOn).toEqual(["root-cause"]);
    });

    it("throws for non-existent workflow", () => {
      const registry = new WorkflowRegistry();
      expect(() => registry.instantiate("nonexistent", {})).toThrow(
        /not found/,
      );
    });

    it("throws for missing required parameters", () => {
      const registry = new WorkflowRegistry();
      expect(() => registry.instantiate("code-review", {})).toThrow(
        /Missing required parameters/,
      );
    });

    it("throws for partially missing parameters", () => {
      const registry = new WorkflowRegistry();
      expect(() =>
        registry.instantiate("code-review", { targetFile: "src/x.ts" }),
      ).toThrow(/targetDescription/);
    });

    it("assigns correct agent IDs to stages", () => {
      const registry = new WorkflowRegistry();
      const pipeline = registry.instantiate("feature-design", {
        featureDescription: "New widget system",
      });

      expect(pipeline.stages[0].agentId).toBe("architect");
      expect(pipeline.stages[1].agentId).toBe("cto");
      expect(pipeline.stages[2].agentId).toBe("coder");
      expect(pipeline.stages[3].agentId).toBe("team-reviewer");
    });
  });
});
