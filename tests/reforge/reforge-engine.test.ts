// tests/reforge/reforge-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ReforgeEngine } from "../../src/reforge/reforge-engine.js";
import type { FeedbackAnalysis } from "../../src/types/feedback.js";
import type { AgentTemplate } from "../../src/types/agent.js";
import type { AgentOverride } from "../../src/types/reforge.js";
import { MessageBusV2 } from "../../packages/core/src/message-bus/message-bus.js";

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

function simpleHash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function findRequestId(trafficPercent: number, canary: boolean): string {
  for (let i = 0; i < 1_000; i++) {
    const requestId = `req-${canary ? "canary" : "control"}-${i}`;
    const bucket = simpleHash(requestId) % 100;
    const routedToCanary = bucket < trafficPercent;
    if (canary === routedToCanary) {
      return requestId;
    }
  }

  throw new Error(`Unable to find a request id for ${canary ? "canary" : "control"} routing`);
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
  // Canary deployment
  // -------------------------------------------------------------------------

  it("deployCanary stages a split rollout without touching the active override", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "exercise staged prompt",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    const deployment = await engine.deployCanary(canaryPlan, {
      trafficPercent: 50,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    expect(deployment.deployments).toHaveLength(1);
    const stagedPath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "canary",
      "cost-analyst.json",
    );
    const stagedRaw = await fs.readFile(stagedPath, "utf-8");
    const staged = JSON.parse(stagedRaw) as { flagId: string; override: { version: number } };
    expect(staged.flagId).toBe(deployment.deployments[0].flagId);
    expect(staged.override.version).toBe(2);

    const canaryRequest = findRequestId(50, true);
    const controlRequest = findRequestId(50, false);

    const canaryApplied = await engine.applyOverride(makeTemplate(), { requestId: canaryRequest });
    expect(canaryApplied.model).toBe("sonnet");
    expect(canaryApplied.system_prompt).toContain("COST AWARENESS PREAMBLE");

    const controlApplied = await engine.applyOverride(makeTemplate(), { requestId: controlRequest });
    expect(controlApplied.model).toBe("sonnet");
    expect(controlApplied.system_prompt).not.toContain("COST AWARENESS PREAMBLE");
  });

  it("deployCanary supports header-based routing when a header value is provided", async () => {
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "exercise header canary",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 50,
      strategy: "header",
      rollbackThreshold: 0.1,
    });

    const canaryHeader = findRequestId(50, true);
    const controlHeader = findRequestId(50, false);

    const canaryApplied = await engine.applyOverride(makeTemplate(), {
      requestId: "same-request",
      headerValue: canaryHeader,
    });
    expect(canaryApplied.system_prompt).toContain("COST AWARENESS PREAMBLE");

    const controlApplied = await engine.applyOverride(makeTemplate(), {
      requestId: "same-request",
      headerValue: controlHeader,
    });
    expect(controlApplied.system_prompt).not.toContain("COST AWARENESS PREAMBLE");
  });

  it("applyOverride defaults to the active override when no routing context is provided", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "staged prompt should stay gated",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    const applied = await engine.applyOverride(makeTemplate());

    expect(applied.model).toBe("sonnet");
    expect(applied.system_prompt).not.toContain("COST AWARENESS PREAMBLE");
  });

  it("recordCanaryOutcome rolls back a staged deployment after repeated errors", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "unstable staged prompt",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    for (let i = 0; i < 5; i++) {
      await engine.recordCanaryOutcome("cost-analyst", true);
    }

    const stagedPath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "canary",
      "cost-analyst.json",
    );
    await expect(fs.readFile(stagedPath, "utf-8")).rejects.toThrow();

    const applied = await engine.applyOverride(makeTemplate(), { requestId: "req-canary-0" });
    expect(applied.system_prompt).not.toContain("COST AWARENESS PREAMBLE");
    expect(applied.model).toBe("sonnet");
  });

  it("recordCanaryOutcome rehydrates staged canary flags after restart", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "unstable staged prompt after restart",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    for (let i = 0; i < 4; i++) {
      await engine.recordCanaryOutcome("cost-analyst", true);
    }

    const stagedPath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "canary",
      "cost-analyst.json",
    );
    const beforeRestart = JSON.parse(await fs.readFile(stagedPath, "utf-8")) as {
      metrics?: { canaryRequests: number; canaryErrors: number; errorRate: number };
    };
    expect(beforeRestart.metrics).toMatchObject({
      canaryRequests: 4,
      canaryErrors: 4,
      errorRate: 1,
    });

    const restarted = new ReforgeEngine(tmpDir);
    const outcome = await restarted.recordCanaryOutcome("cost-analyst", true);
    expect(outcome?.rollback).toContain("Auto-rollback");

    await expect(fs.readFile(stagedPath, "utf-8")).rejects.toThrow();

    const rollbackPath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "canary",
      "cost-analyst.rollback.json",
    );
    const rollback = JSON.parse(await fs.readFile(rollbackPath, "utf-8")) as {
      metrics?: { canaryRequests: number; canaryErrors: number; errorRate: number };
      rollback?: { reason: string; errorRate: number; threshold: number };
    };
    expect(rollback.metrics).toMatchObject({
      canaryRequests: 5,
      canaryErrors: 5,
      errorRate: 1,
    });
    expect(rollback.rollback).toMatchObject({
      errorRate: 1,
      threshold: 0.1,
    });
  });

  it("recordCanaryOutcome ignores non-quality outcomes without consuming the canary token", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "quality-only rollback accounting",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    await engine.applyOverride(makeTemplate(), {
      requestId: "req-quality-only-1",
      outcomeToken: "tok-quality-only-1",
    });

    const ignored = await engine.recordCanaryOutcome("cost-analyst", true, {
      source: "runtime",
      outcomeToken: "tok-quality-only-1",
    });
    expect(ignored?.ignored).toBe(true);
    expect(ignored?.ignoreReason).toBe("non-quality-source");

    const counted = await engine.recordCanaryOutcome("cost-analyst", true, {
      source: "quality",
      outcomeToken: "tok-quality-only-1",
    });
    expect(counted?.ignored).toBeUndefined();

    const stagedPath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "canary",
      "cost-analyst.json",
    );
    const staged = JSON.parse(await fs.readFile(stagedPath, "utf-8")) as {
      metrics?: { canaryRequests: number; canaryErrors: number; errorRate: number };
    };
    expect(staged.metrics).toMatchObject({
      canaryRequests: 1,
      canaryErrors: 1,
      errorRate: 1,
    });
  });

  it("publishes staged/promoted/rolled-back self-modification canary events", async () => {
    const bus = new MessageBusV2({ workspaceId: "ws-selfmod" });
    const busBackedEngine = new ReforgeEngine(tmpDir, { bus });

    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "emit canary lifecycle events",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await busBackedEngine.buildPlan(baseAnalysis, [makeTemplate()]);
    await busBackedEngine.executePlan(activePlan);

    const promotePlan = await busBackedEngine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await busBackedEngine.deployCanary(promotePlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });
    await busBackedEngine.promoteCanary("cost-analyst");

    const rollbackPlan = await busBackedEngine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await busBackedEngine.deployCanary(rollbackPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    for (let i = 0; i < 5; i++) {
      await busBackedEngine.recordCanaryOutcome("cost-analyst", true);
    }

    expect(bus.getHistory(10, "self-modification.canary.staged")).toHaveLength(2);
    expect(bus.getHistory(10, "self-modification.canary.promoted")).toHaveLength(1);
    expect(bus.getHistory(10, "self-modification.canary.rolled_back")).toHaveLength(1);
  });

  it("promoteCanary makes the staged override the active override", async () => {
    const baseAnalysis = makeAnalysis([
      {
        action: "adjust-model-routing",
        rationale: "baseline rollout",
        urgency: "high",
        theme_label: "baseline",
        confidence: 0.9,
      },
    ]);
    const canaryAnalysis = makeAnalysis([
      {
        action: "update-system-prompt",
        rationale: "promote staged prompt",
        urgency: "medium",
        theme_label: "prompt-canary",
        confidence: 0.7,
      },
    ]);

    const activePlan = await engine.buildPlan(baseAnalysis, [makeTemplate()]);
    await engine.executePlan(activePlan);

    const canaryPlan = await engine.buildPlan(canaryAnalysis, [makeTemplate()]);
    await engine.deployCanary(canaryPlan, {
      trafficPercent: 100,
      strategy: "hash",
      rollbackThreshold: 0.1,
    });

    const upgradedPlan = await engine.buildPlan(
      makeAnalysis([
        {
          action: "adjust-model-routing",
          rationale: "newer active change",
          urgency: "high",
          theme_label: "active-update",
          confidence: 0.8,
        },
      ]),
      [makeTemplate({ model: "sonnet" })],
    );
    await engine.executePlan(upgradedPlan);

    await engine.promoteCanary("cost-analyst");

    const activePath = path.join(
      tmpDir,
      ".agentforge",
      "agent-overrides",
      "cost-analyst.json",
    );
    const activeRaw = await fs.readFile(activePath, "utf-8");
    const active = JSON.parse(activeRaw) as {
      version: number;
      previousVersion?: { version: number; modelTierOverride?: string };
      modelTierOverride?: string;
      systemPromptPreamble?: string;
    };
    expect(active.version).toBe(3);
    expect(active.previousVersion?.version).toBe(2);
    expect(active.previousVersion?.modelTierOverride).toBe("haiku");

    const applied = await engine.applyOverride(makeTemplate());
    expect(applied.system_prompt).toContain("COST AWARENESS PREAMBLE");
    expect(applied.model).toBe("haiku");
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
