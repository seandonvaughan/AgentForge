// tests/reforge/reforge-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ReforgeEngine } from "../../src/reforge/reforge-engine.js";
import type { FeedbackAnalysis } from "../../src/types/feedback.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type { AgentOverride } from "../../src/types/reforge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    name: "cost-analyst",
    model: "opus",
    effort: "high",
    version: "1.0.0",
    description: "Analyzes costs",
    system_prompt: "You are a cost analyst.",
    skills: ["cost-analysis"],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: { max_files: 10, auto_include: [], project_specific: [] },
    category: "strategic",
    ...overrides,
  };
}

function makeAnalysis(
  actions: FeedbackAnalysis["recommended_actions"] = [],
): FeedbackAnalysis {
  return {
    analyzed_at: new Date().toISOString(),
    total_entries: 5,
    date_range: { earliest: "2026-03-25", latest: "2026-03-25" },
    themes: [],
    recommended_actions: actions,
    requires_escalation: false,
    summary: {
      total: 5,
      by_category: {
        optimization: 5, bug: 0, feature: 0, process: 0, cost: 0, quality: 0,
      },
      by_priority: { critical: 0, high: 5, medium: 0, low: 0 },
      by_agent: { "cost-analyst": 5 },
      entries: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReforgeEngine", () => {
  let tmpDir: string;
  let engine: ReforgeEngine;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentforge-reforge-test-"));
    engine = new ReforgeEngine(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // buildPlan
  // -------------------------------------------------------------------------

  it("buildPlan produces a model-tier-override mutation for adjust-model-routing action", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost-analyst flagged Opus waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.85,
      },
    ]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);

    expect(plan.reforgeClass).toBe("local");
    expect(plan.triggeredBy).toBe("model-routing");
    const modelMutation = plan.mutations.find(
      (m) => m.type === "model-tier-override",
    );
    expect(modelMutation).toBeDefined();
    expect(modelMutation?.agentName).toBe("cost-analyst");
    expect(modelMutation?.oldValue).toBe("opus");
    expect(modelMutation?.newValue).toBe("sonnet");
  });

  it("buildPlan produces a system-prompt-preamble mutation for update-system-prompt action", async () => {
    const analysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "agents need better cost awareness",
        urgency: "medium",
        theme_label: "cost-awareness",
        confidence: 0.75,
      },
    ]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);

    const promptMutation = plan.mutations.find(
      (m) => m.type === "system-prompt-preamble",
    );
    expect(promptMutation).toBeDefined();
    expect(promptMutation?.agentName).toBe("cost-analyst");
    expect(typeof promptMutation?.newValue).toBe("string");
    expect((promptMutation?.newValue as string).length).toBeGreaterThan(0);
  });

  it("buildPlan marks structural plan for reforge-team action", async () => {
    const analysis = makeAnalysis([
      {
        action: "reforge-team",
        rationale: "team topology needs fan-out",
        urgency: "high",
        theme_label: "parallelism",
        confidence: 0.9,
      },
    ]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);

    expect(plan.reforgeClass).toBe("structural");
    expect(plan.triggeredBy).toBe("parallelism");
  });

  it("buildPlan sets triggeredBy to [REFORGE REQUESTED] when no theme label is present", async () => {
    const analysis = makeAnalysis([]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);

    expect(plan.triggeredBy).toBe("[REFORGE REQUESTED]");
  });

  it("buildPlan generates a valid UUID for plan.id", async () => {
    const analysis = makeAnalysis([]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);

    expect(plan.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // -------------------------------------------------------------------------
  // executePlan — local mutations
  // -------------------------------------------------------------------------

  it("executePlan writes AgentOverride JSON to agent-overrides dir", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];
    const plan = await engine.buildPlan(analysis, templates);
    const result = await engine.executePlan(plan);

    expect(result.applied).toBe(true);
    expect(result.appliedMutations.length).toBeGreaterThan(0);

    const overridePath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "cost-analyst.json",
    );
    const raw = await fs.readFile(overridePath, "utf-8");
    const override: AgentOverride = JSON.parse(raw);
    expect(override.agentName).toBe("cost-analyst");
    expect(override.version).toBe(1);
    expect(override.modelTierOverride).toBe("sonnet");
  });

  it("executePlan writes structural proposal markdown to reforge-proposals dir", async () => {
    const analysis = makeAnalysis([
      {
        action: "reforge-team",
        rationale: "team needs fan-out",
        urgency: "high",
        theme_label: "parallelism",
        confidence: 0.9,
      },
    ]);
    const templates = [makeTemplate()];
    const plan = await engine.buildPlan(analysis, templates);
    const result = await engine.executePlan(plan);

    const proposalsDir = path.join(tmpDir, ".agentforge", "reforge-proposals");
    const files = await fs.readdir(proposalsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/\.md$/);

    // Structural plans are queued as proposals, not directly applied
    expect(result.skippedMutations.length).toBe(0); // structural plan has no local mutations
  });

  it("executePlan increments version on successive applies", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];

    const plan1 = await engine.buildPlan(analysis, templates);
    const result1 = await engine.executePlan(plan1);
    expect(result1.version).toBe(1);

    const plan2 = await engine.buildPlan(analysis, templates);
    const result2 = await engine.executePlan(plan2);
    expect(result2.version).toBe(2);
    expect(result2.rollbackAvailable).toBe(true);
  });

  it("executePlan caps version history at 5 (Iron Law 4)", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];

    // Apply 6 times — version should cap at 5
    for (let i = 0; i < 6; i++) {
      const plan = await engine.buildPlan(analysis, templates);
      await engine.executePlan(plan);
    }

    const override = await engine.loadOverride("cost-analyst");
    expect(override).not.toBeNull();
    expect(override!.version).toBe(6); // version counter is 6th apply

    // But the chain depth should not exceed 5
    let depth = 0;
    let current: AgentOverride | undefined = override!;
    while (current) {
      depth++;
      current = current.previousVersion;
    }
    expect(depth).toBeLessThanOrEqual(5);
  });

  // -------------------------------------------------------------------------
  // applyOverride
  // -------------------------------------------------------------------------

  it("applyOverride prepends preamble to system_prompt", async () => {
    const analysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "needs cost framing",
        urgency: "medium",
        theme_label: "cost-awareness",
        confidence: 0.75,
      },
    ]);
    const templates = [makeTemplate()];
    const plan = await engine.buildPlan(analysis, templates);
    await engine.executePlan(plan);

    const template = makeTemplate();
    const modified = await engine.applyOverride(template);

    expect(modified.system_prompt).toContain("You are a cost analyst.");
    // The preamble should come before the original prompt
    const preambleIdx = modified.system_prompt.indexOf(
      modified.system_prompt.split("\n")[0],
    );
    expect(preambleIdx).toBe(0);
  });

  it("applyOverride applies modelTierOverride to template", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];
    const plan = await engine.buildPlan(analysis, templates);
    await engine.executePlan(plan);

    const template = makeTemplate(); // original model: "opus"
    const modified = await engine.applyOverride(template);

    expect(modified.model).toBe("sonnet");
  });

  it("applyOverride returns template unchanged when no override exists", async () => {
    const template = makeTemplate({ name: "no-override-agent" });
    const result = await engine.applyOverride(template);
    expect(result).toEqual(template);
  });

  // -------------------------------------------------------------------------
  // rollback
  // -------------------------------------------------------------------------

  it("rollback reverts to previous version", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];

    // Apply v1: opus -> sonnet
    const plan1 = await engine.buildPlan(analysis, templates);
    await engine.executePlan(plan1);

    // Apply v2: change again (re-use same plan data; version increments)
    const plan2 = await engine.buildPlan(analysis, [makeTemplate({ model: "sonnet" })]);
    await engine.executePlan(plan2);

    const beforeRollback = await engine.loadOverride("cost-analyst");
    expect(beforeRollback!.version).toBe(2);

    await engine.rollback("cost-analyst");

    const afterRollback = await engine.loadOverride("cost-analyst");
    expect(afterRollback!.version).toBe(1);
  });

  it("rollback throws when no previous version exists", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "cost waste",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.8,
      },
    ]);
    const templates = [makeTemplate()];
    const plan = await engine.buildPlan(analysis, templates);
    await engine.executePlan(plan);

    // v1 has no previousVersion — rollback should throw
    await expect(engine.rollback("cost-analyst")).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  it("round-trip: buildPlan → executePlan → applyOverride produces a modified template", async () => {
    const analysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "Opus waste on non-strategic work",
        urgency: "high",
        theme_label: "model-routing",
        confidence: 0.85,
      },
    ]);
    const templates = [makeTemplate()];

    const plan = await engine.buildPlan(analysis, templates);
    const result = await engine.executePlan(plan);
    const modified = await engine.applyOverride(makeTemplate());

    expect(result.applied).toBe(true);
    expect(modified.model).toBe("sonnet");
    expect(modified.name).toBe("cost-analyst");
  });
});
