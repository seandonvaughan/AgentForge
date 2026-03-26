/**
 * WorkflowTemplates — v4.5 P0-4
 *
 * Predefined multi-agent workflow templates that can be instantiated
 * into TaskPipeline definitions. Each template defines a reusable
 * pattern of agent collaboration.
 *
 * Zero new npm dependencies (Iron Law 5).
 */

import { randomUUID } from "node:crypto";
import type { WorkflowTemplate, WorkflowParameters } from "../types/workflow.js";
import type { PipelineDefinition, PipelineStage } from "../types/pipeline.js";

// ---------------------------------------------------------------------------
// Built-in workflow templates
// ---------------------------------------------------------------------------

const CODE_REVIEW_WORKFLOW: WorkflowTemplate = {
  name: "code-review",
  description:
    "End-to-end code review: gather context, implement changes, review, and address feedback.",
  stages: [
    {
      name: "gather-context",
      agentId: "researcher",
      taskTemplate:
        "Gather context and relevant code for: {{targetDescription}}. Focus on file: {{targetFile}}",
      dependsOn: [],
    },
    {
      name: "implement",
      agentId: "coder",
      taskTemplate:
        "Using the context from the research phase, implement: {{targetDescription}}. Target file: {{targetFile}}",
      dependsOn: ["gather-context"],
    },
    {
      name: "review",
      agentId: "team-reviewer",
      taskTemplate:
        "Review the implementation for: {{targetDescription}}. Check for correctness, style, and edge cases.",
      dependsOn: ["implement"],
    },
    {
      name: "address-feedback",
      agentId: "coder",
      taskTemplate:
        "Address the review feedback for: {{targetDescription}}. Apply corrections and improvements.",
      dependsOn: ["review"],
    },
  ],
  requiredAgents: ["researcher", "coder", "team-reviewer"],
  parameters: ["targetFile", "targetDescription"],
};

const BUG_INVESTIGATION_WORKFLOW: WorkflowTemplate = {
  name: "bug-investigation",
  description:
    "Systematic bug investigation: reproduce, root-cause analysis, fix, and verify.",
  stages: [
    {
      name: "reproduce",
      agentId: "debugger",
      taskTemplate:
        "Reproduce and characterize the bug: {{bugDescription}}",
      dependsOn: [],
    },
    {
      name: "root-cause",
      agentId: "researcher",
      taskTemplate:
        "Perform root-cause analysis for the bug: {{bugDescription}}. Use the reproduction findings.",
      dependsOn: ["reproduce"],
    },
    {
      name: "fix",
      agentId: "coder",
      taskTemplate:
        "Fix the bug: {{bugDescription}}. Apply the fix based on the root-cause analysis.",
      dependsOn: ["root-cause"],
    },
    {
      name: "verify",
      agentId: "linter",
      taskTemplate:
        "Verify that the fix for {{bugDescription}} is correct and does not introduce regressions.",
      dependsOn: ["fix"],
    },
  ],
  requiredAgents: ["debugger", "researcher", "coder", "linter"],
  parameters: ["bugDescription"],
};

const FEATURE_DESIGN_WORKFLOW: WorkflowTemplate = {
  name: "feature-design",
  description:
    "Feature design pipeline: architect designs, CTO approves, coder implements, reviewer validates.",
  stages: [
    {
      name: "design",
      agentId: "architect",
      taskTemplate:
        "Design the architecture for feature: {{featureDescription}}. Produce a technical design document.",
      dependsOn: [],
    },
    {
      name: "approve",
      agentId: "cto",
      taskTemplate:
        "Review and approve the architecture design for: {{featureDescription}}. Assess feasibility and risk.",
      dependsOn: ["design"],
    },
    {
      name: "implement",
      agentId: "coder",
      taskTemplate:
        "Implement the feature: {{featureDescription}}. Follow the approved design.",
      dependsOn: ["approve"],
    },
    {
      name: "review",
      agentId: "team-reviewer",
      taskTemplate:
        "Review the implementation of: {{featureDescription}}. Verify it matches the approved design.",
      dependsOn: ["implement"],
    },
  ],
  requiredAgents: ["architect", "cto", "coder", "team-reviewer"],
  parameters: ["featureDescription"],
};

const KNOWLEDGE_SYNC_WORKFLOW: WorkflowTemplate = {
  name: "knowledge-sync",
  description:
    "Knowledge synchronization: scan codebase, extract patterns, produce strategic summary.",
  stages: [
    {
      name: "scan",
      agentId: "researcher",
      taskTemplate:
        "Scan the codebase and extract key information about: {{topic}}",
      dependsOn: [],
    },
    {
      name: "extract-patterns",
      agentId: "meta-architect",
      taskTemplate:
        "Analyze the scan results and extract patterns related to: {{topic}}",
      dependsOn: ["scan"],
    },
    {
      name: "strategic-summary",
      agentId: "ceo",
      taskTemplate:
        "Produce a strategic summary of findings about: {{topic}}. Highlight actionable insights.",
      dependsOn: ["extract-patterns"],
    },
  ],
  requiredAgents: ["researcher", "meta-architect", "ceo"],
  parameters: ["topic"],
};

// ---------------------------------------------------------------------------
// WorkflowRegistry
// ---------------------------------------------------------------------------

export class WorkflowRegistry {
  private readonly templates = new Map<string, WorkflowTemplate>();

  constructor() {
    // Register built-in workflows
    this.register(CODE_REVIEW_WORKFLOW);
    this.register(BUG_INVESTIGATION_WORKFLOW);
    this.register(FEATURE_DESIGN_WORKFLOW);
    this.register(KNOWLEDGE_SYNC_WORKFLOW);
  }

  // =========================================================================
  // Registration
  // =========================================================================

  /**
   * Register a new workflow template.
   */
  register(template: WorkflowTemplate): void {
    this.templates.set(template.name, template);
  }

  /**
   * Remove a workflow template.
   */
  unregister(name: string): boolean {
    return this.templates.delete(name);
  }

  // =========================================================================
  // Query
  // =========================================================================

  /**
   * Get a workflow template by name.
   */
  get(name: string): WorkflowTemplate | null {
    const t = this.templates.get(name);
    return t ? this.cloneTemplate(t) : null;
  }

  /**
   * List all registered workflow templates.
   */
  list(): WorkflowTemplate[] {
    return Array.from(this.templates.values()).map((t) =>
      this.cloneTemplate(t),
    );
  }

  /**
   * Check if a workflow template exists.
   */
  has(name: string): boolean {
    return this.templates.has(name);
  }

  // =========================================================================
  // Instantiation
  // =========================================================================

  /**
   * Instantiate a workflow template into a PipelineDefinition.
   *
   * Resolves all `{{parameter}}` placeholders in task templates with
   * the provided parameter values.
   *
   * @throws Error if the workflow template is not found.
   * @throws Error if required parameters are missing.
   */
  instantiate(
    workflowName: string,
    params: WorkflowParameters,
  ): PipelineDefinition {
    const template = this.templates.get(workflowName);
    if (!template) {
      throw new Error(`Workflow template "${workflowName}" not found`);
    }

    // Validate all required parameters are provided
    const missing = template.parameters.filter((p) => !(p in params));
    if (missing.length > 0) {
      throw new Error(
        `Missing required parameters for workflow "${workflowName}": ${missing.join(", ")}`,
      );
    }

    // Build pipeline stages from the template
    const stages: PipelineStage[] = template.stages.map((stageTemplate) => {
      // Resolve placeholders in task template
      let task = stageTemplate.taskTemplate;
      for (const [key, value] of Object.entries(params)) {
        task = task.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
      }

      return {
        id: stageTemplate.name,
        name: stageTemplate.name,
        agentId: stageTemplate.agentId,
        task,
        dependsOn: [...stageTemplate.dependsOn],
        status: "pending" as const,
      };
    });

    return {
      id: randomUUID(),
      name: `${workflowName}:${Object.values(params).join(",")}`,
      description: template.description,
      stages,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
  }

  // =========================================================================
  // Private
  // =========================================================================

  private cloneTemplate(template: WorkflowTemplate): WorkflowTemplate {
    return {
      ...template,
      stages: template.stages.map((s) => ({
        ...s,
        dependsOn: [...s.dependsOn],
      })),
      requiredAgents: [...template.requiredAgents],
      parameters: [...template.parameters],
    };
  }
}
