/**
 * ReforgeEngine — The flagship Phase 2b intelligence module.
 *
 * Translates FeedbackAnalysis recommended actions into AgentMutation plans,
 * executes them by writing AgentOverride files to disk, and supports full
 * rollback with version capping (max 5 versions per Iron Law 4).
 *
 * Directory layout under `<projectRoot>/.agentforge/`:
 *   agent-overrides/   — one JSON file per agent with current + history
 *   reforge-proposals/ — markdown proposals for structural changes
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { FeedbackAnalysis, RecommendedAction } from "./types/feedback.js";
import type { AgentTemplate } from "../team/engine/types/agent.js";
import type {
  AgentMutation,
  AgentOverride,
  CanaryOutcomeSource,
  CanaryDeployOptions,
  CanaryDeploymentRecord,
  CanaryDeploymentMetrics,
  CanaryRoutingContext,
  CanaryRollbackRecord,
  RecordCanaryOutcomeOptions,
  RecordCanaryOutcomeResult,
  ReforgePlan,
  ReforgeResult,
} from "./types/reforge.js";
import { CanaryManager } from "../canary/canary-manager.js";
import type { MessageBusV2 } from "../message-bus/message-bus.js";
import type {
  SelfModificationCanaryPromotedPayload,
  SelfModificationCanaryRolledBackPayload,
  SelfModificationCanaryStagedPayload,
} from "../message-bus/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum override history depth per agent (Iron Law 4). */
const MAX_VERSION_DEPTH = 5;

/** Default downgrade tier when adjust-model-routing fires on an Opus agent. */
const OPUS_DOWNGRADE_TARGET = "sonnet" as const;
const SONNET_DOWNGRADE_TARGET = "haiku" as const;
const MAX_PENDING_CANARY_OUTCOMES = 10_000;
const PENDING_CANARY_OUTCOME_TTL_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReforgeEngineOptions {
  /**
   * Preamble text injected when `update-system-prompt` action fires.
   * Defaults to a generic cost-awareness reminder.
   */
  defaultPreamble?: string;
  /** Optional bus for canary lifecycle events. */
  bus?: MessageBusV2;
}

interface PendingCanaryOutcome {
  flagId: string;
  createdAtMs: number;
}

// ---------------------------------------------------------------------------
// ReforgeEngine
// ---------------------------------------------------------------------------

export class ReforgeEngine {
  private readonly overridesDir: string;
  private readonly canaryOverridesDir: string;
  private readonly proposalsDir: string;
  private readonly canaryManager = new CanaryManager();
  private readonly options: {
    defaultPreamble: string;
    bus: MessageBusV2 | undefined;
  };
  private readonly pendingCanaryOutcomes = new Map<string, PendingCanaryOutcome>();

  constructor(projectRoot: string, options?: ReforgeEngineOptions) {
    this.overridesDir = path.join(
      projectRoot,
      ".agentforge",
      "agent-overrides",
    );
    this.canaryOverridesDir = path.join(
      projectRoot,
      ".agentforge",
      "agent-overrides",
      "canary",
    );
    this.proposalsDir = path.join(
      projectRoot,
      ".agentforge",
      "reforge-proposals",
    );
    this.options = {
      defaultPreamble:
        options?.defaultPreamble ??
        "COST AWARENESS PREAMBLE: Prefer the most economical approach. " +
          "Avoid over-engineering. Escalate only when necessary.",
      bus: options?.bus,
    };
  }

  // =========================================================================
  // buildPlan
  // =========================================================================

  /**
   * Builds a ReforgePlan from a FeedbackAnalysis and set of agent templates.
   *
   * Mapping rules:
   *   - `adjust-model-routing`  → `model-tier-override` mutations (local)
   *   - `update-system-prompt`  → `system-prompt-preamble` mutations (local)
   *   - `reforge-team`          → structural plan (no local mutations)
   */
  async buildPlan(
    analysis: FeedbackAnalysis,
    templates: AgentTemplate[],
  ): Promise<ReforgePlan> {
    const actions = analysis.recommended_actions;
    const planId = randomUUID();
    const timestamp = new Date().toISOString();

    // Determine reforgeClass — structural if any action is reforge-team
    const hasStructural = actions.some((a) => a.action === "reforge-team");

    // Prefer the first action's theme_label as the trigger label
    const firstAction = actions[0];
    const triggeredBy = firstAction?.theme_label ?? "[REFORGE REQUESTED]";

    if (hasStructural) {
      return {
        id: planId,
        timestamp,
        reforgeClass: "structural",
        triggeredBy,
        mutations: [],
        rationale: this.buildRationale(actions),
        estimatedImpact:
          "Team topology will be restructured — requires human review before apply.",
      };
    }

    // Build local mutations
    const mutations: AgentMutation[] = [];

    for (const action of actions) {
      const generated = this.generateMutations(action, templates);
      mutations.push(...generated);
    }

    return {
      id: planId,
      timestamp,
      reforgeClass: mutations.length > 0 ? "local" : "local",
      triggeredBy,
      mutations,
      rationale: this.buildRationale(actions),
      estimatedImpact: this.estimateImpact(mutations),
    };
  }

  // =========================================================================
  // executePlan
  // =========================================================================

  /**
   * Applies a ReforgePlan:
   * - Local mutations: write/update AgentOverride JSON files
   * - Structural plans: write a markdown proposal to the proposals dir
   */
  async executePlan(plan: ReforgePlan): Promise<ReforgeResult> {
    await this.ensureDirs();

    if (plan.reforgeClass === "structural") {
      await this.writeStructuralProposal(plan);
      return {
        plan,
        applied: false,
        appliedMutations: [],
        skippedMutations: [],
        version: 0,
        rollbackAvailable: false,
      };
    }

    // Group mutations by agent
    const byAgent = new Map<string, AgentMutation[]>();
    for (const mutation of plan.mutations) {
      const list = byAgent.get(mutation.agentName) ?? [];
      list.push(mutation);
      byAgent.set(mutation.agentName, list);
    }

    const appliedMutations: AgentMutation[] = [];
    const skippedMutations: AgentMutation[] = [];
    let lastVersion = 0;

    for (const [agentName, agentMutations] of byAgent.entries()) {
      const existing = await this.loadOverride(agentName);
      const nextVersion = (existing?.version ?? 0) + 1;

      // Build the override record
      const override: AgentOverride = {
        agentName,
        version: nextVersion,
        appliedAt: new Date().toISOString(),
        sessionId: plan.id,
        mutations: agentMutations,
      };

      // Apply fields
      for (const mutation of agentMutations) {
        if (mutation.type === "model-tier-override") {
          override.modelTierOverride = mutation.newValue as NonNullable<AgentOverride["modelTierOverride"]>;
        } else if (mutation.type === "effort-override") {
          override.effortOverride = mutation.newValue as NonNullable<AgentOverride["effortOverride"]>;
        } else if (mutation.type === "system-prompt-preamble") {
          override.systemPromptPreamble = mutation.newValue as string;
        }
      }

      // Attach previous version (capped at MAX_VERSION_DEPTH total links)
      if (existing) {
        override.previousVersion = this.capHistory(existing);
      }

      await this.writeOverride(agentName, override);
      appliedMutations.push(...agentMutations);
      lastVersion = nextVersion;
    }

    const anyApplied = appliedMutations.length > 0;

    return {
      plan,
      applied: anyApplied,
      appliedMutations,
      skippedMutations,
      version: lastVersion,
      rollbackAvailable: lastVersion > 1,
    };
  }

  /**
   * Stage a canary deployment for a local reforge plan.
   *
   * Canary traffic is routed separately from the active override so the
   * staged change can be exercised on a subset of requests before promotion.
   */
  async deployCanary(
    plan: ReforgePlan,
    options: CanaryDeployOptions = {},
  ): Promise<{ plan: ReforgePlan; deployments: CanaryDeploymentRecord[] }> {
    await this.ensureDirs();

    if (plan.reforgeClass === "structural") {
      throw new Error("Structural reforge plans cannot be deployed as canaries.");
    }

    const byAgent = this.groupMutationsByAgent(plan.mutations);
    const deployments: CanaryDeploymentRecord[] = [];
    const trafficPercent = this.clampPercent(options.trafficPercent ?? 10);
    const strategy = options.strategy ?? "hash";
    const rollbackThreshold = options.rollbackThreshold ?? 0.05;

    for (const [agentName, agentMutations] of byAgent.entries()) {
      const existing = await this.loadOverride(agentName);
      const override = this.buildOverrideRecord(agentName, agentMutations, plan.id, existing);
      const flagId = `${plan.id}:${agentName}`;
      const deployment: CanaryDeploymentRecord = {
        agentName,
        planId: plan.id,
        flagId,
        stagedAt: new Date().toISOString(),
        trafficPercent,
        strategy,
        rollbackThreshold,
        override,
        metrics: this.emptyCanaryMetrics(),
      };

      this.canaryManager.createFlag({
        id: flagId,
        name: `${plan.triggeredBy}:${agentName}`,
        description: plan.rationale,
        trafficPercent,
        strategy,
        rollbackThreshold,
      });
      this.canaryManager.activateFlag(flagId);
      await this.writeCanaryDeployment(deployment);
      this.publishCanaryStaged(deployment);
      deployments.push(deployment);
    }

    return { plan, deployments };
  }

  /**
   * Promote a staged canary override into the active override slot.
   */
  async promoteCanary(agentName: string): Promise<AgentOverride> {
    const deployment = await this.loadCanaryDeployment(agentName);
    if (!deployment) {
      throw new Error(`No staged canary deployment found for agent "${agentName}".`);
    }

    const current = await this.loadOverride(agentName);
    const promoted = this.buildOverrideRecord(
      agentName,
      deployment.override.mutations,
      deployment.planId,
      current,
    );

    await this.writeOverride(agentName, promoted);
    await this.deleteCanaryDeployment(agentName);
    this.canaryManager.deleteFlag(deployment.flagId);
    this.clearPendingCanaryOutcomes(agentName);
    this.publishCanaryPromoted(deployment, promoted.version);
    return promoted;
  }

  /**
   * Record whether a staged canary request succeeded and auto-rollback if the
   * error threshold is exceeded.
   */
  async recordCanaryOutcome(
    agentName: string,
    isError: boolean,
    options: RecordCanaryOutcomeOptions = {},
  ): Promise<RecordCanaryOutcomeResult | null> {
    const deployment = await this.loadCanaryDeployment(agentName);
    if (!deployment) {
      return null;
    }

    this.prunePendingCanaryOutcomes();
    const source: CanaryOutcomeSource = options.source ?? "quality";
    if (source !== "quality") {
      return {
        deployment,
        ignored: true,
        ignoreReason: "non-quality-source",
      };
    }

    const outcomeToken = options.outcomeToken ?? options.requestId;
    if (outcomeToken && !this.consumePendingCanaryOutcome(agentName, deployment.flagId, outcomeToken)) {
      return {
        deployment,
        ignored: true,
        ignoreReason: "unknown-or-expired-token",
      };
    }

    this.canaryManager.getFlag(deployment.flagId) ?? this.ensureCanaryFlag(deployment);
    this.canaryManager.recordOutcome(deployment.flagId, isError);

    const metrics = this.nextCanaryMetrics(deployment.metrics, isError);
    const updatedDeployment: CanaryDeploymentRecord = {
      ...deployment,
      metrics,
    };

    const rollback = this.shouldRollbackCanary(updatedDeployment)
      ? this.buildCanaryRollback(updatedDeployment)
      : undefined;

    if (rollback) {
      await this.writeCanaryRollback({
        ...updatedDeployment,
        rollback,
      });
      await this.deleteCanaryDeployment(agentName);
      this.canaryManager.performRollback(deployment.flagId, rollback.reason);
      this.clearPendingCanaryOutcomes(agentName);
      this.publishCanaryRolledBack(updatedDeployment, rollback);
    } else {
      await this.writeCanaryDeployment(updatedDeployment);
    }

    return {
      deployment: {
        ...updatedDeployment,
        ...(rollback ? { rollback } : {}),
      },
      ...(rollback ? { rollback: rollback.reason } : {}),
    };
  }

  // =========================================================================
  // applyOverride
  // =========================================================================

  /**
   * Loads any stored override for the agent and applies it on top of the
   * provided template, returning a mutated copy.
   *
   * If no override exists, returns the template unchanged.
   */
  async applyOverride(
    template: AgentTemplate,
    context?: CanaryRoutingContext,
  ): Promise<AgentTemplate> {
    const override = await this.loadEffectiveOverride(template.name, context);
    if (!override) return template;
    return this.materializeOverride(template, override);
  }

  // =========================================================================
  // rollback
  // =========================================================================

  /**
   * Reverts the stored override for `agentName` to its previous version.
   *
   * Throws if no previous version is available.
   */
  async rollback(agentName: string): Promise<void> {
    const current = await this.loadOverride(agentName);
    if (!current) {
      throw new Error(
        `No override found for agent "${agentName}" — nothing to roll back.`,
      );
    }
    if (!current.previousVersion) {
      throw new Error(
        `Agent "${agentName}" is at version 1 with no previous version to roll back to.`,
      );
    }

    // Write the previous version as the active override
    await this.writeOverride(agentName, current.previousVersion);
  }

  // =========================================================================
  // loadOverride
  // =========================================================================

  /** Load the current override for an agent from disk, or null if none. */
  async loadOverride(agentName: string): Promise<AgentOverride | null> {
    const filePath = path.join(this.overridesDir, `${agentName}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as AgentOverride;
    } catch {
      return null;
    }
  }

  /** Load a staged canary deployment for an agent, or null if none exists. */
  private async loadCanaryDeployment(agentName: string): Promise<CanaryDeploymentRecord | null> {
    const filePath = path.join(this.canaryOverridesDir, `${agentName}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as CanaryDeploymentRecord;
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.overridesDir, { recursive: true });
    await fs.mkdir(this.canaryOverridesDir, { recursive: true });
    await fs.mkdir(this.proposalsDir, { recursive: true });
  }

  private async writeCanaryDeployment(deployment: CanaryDeploymentRecord): Promise<void> {
    await fs.mkdir(this.canaryOverridesDir, { recursive: true });
    const filePath = path.join(this.canaryOverridesDir, `${deployment.agentName}.json`);
    await fs.writeFile(filePath, JSON.stringify(deployment, null, 2), "utf-8");
  }

  private async writeCanaryRollback(deployment: CanaryDeploymentRecord): Promise<void> {
    await fs.mkdir(this.canaryOverridesDir, { recursive: true });
    const filePath = path.join(this.canaryOverridesDir, `${deployment.agentName}.rollback.json`);
    await fs.writeFile(filePath, JSON.stringify(deployment, null, 2), "utf-8");
  }

  private async deleteCanaryDeployment(agentName: string): Promise<void> {
    const filePath = path.join(this.canaryOverridesDir, `${agentName}.json`);
    await fs.rm(filePath, { force: true });
  }

  private async loadEffectiveOverride(
    agentName: string,
    context?: CanaryRoutingContext,
  ): Promise<AgentOverride | null> {
    const active = await this.loadOverride(agentName);
    const canary = await this.loadCanaryDeployment(agentName);
    if (!canary) {
      return active;
    }

    const flag = this.canaryManager.getFlag(canary.flagId) ?? this.ensureCanaryFlag(canary);
    if (!context?.requestId && !context?.headerValue && !context?.outcomeToken) {
      return active;
    }

    const routeRequestId = context.requestId ?? context.outcomeToken ?? randomUUID();
    const route = this.canaryManager.route(flag.id, routeRequestId, context.headerValue);
    if (route.variant === "canary") {
      const token = context.outcomeToken ?? context.requestId;
      if (token) {
        this.rememberPendingCanaryOutcome(agentName, canary.flagId, token);
      }
    }
    return route.variant === "canary" ? canary.override : active;
  }

  private ensureCanaryFlag(deployment: CanaryDeploymentRecord) {
    const existing = this.canaryManager.getFlag(deployment.flagId);
    if (existing) {
      return existing;
    }

    const flag = this.canaryManager.createFlag({
      id: deployment.flagId,
      name: `${deployment.planId}:${deployment.agentName}`,
      description: `Staged canary for ${deployment.agentName}`,
      trafficPercent: deployment.trafficPercent,
      strategy: deployment.strategy,
      rollbackThreshold: deployment.rollbackThreshold,
    });
    this.canaryManager.activateFlag(flag.id);
    return flag;
  }

  private pendingCanaryOutcomeKey(agentName: string, token: string): string {
    return `${agentName}:${token}`;
  }

  private rememberPendingCanaryOutcome(
    agentName: string,
    flagId: string,
    token: string,
  ): void {
    this.prunePendingCanaryOutcomes();
    if (this.pendingCanaryOutcomes.size >= MAX_PENDING_CANARY_OUTCOMES) {
      const oldestKey = this.pendingCanaryOutcomes.keys().next().value as string | undefined;
      if (oldestKey) {
        this.pendingCanaryOutcomes.delete(oldestKey);
      }
    }

    this.pendingCanaryOutcomes.set(
      this.pendingCanaryOutcomeKey(agentName, token),
      {
        flagId,
        createdAtMs: Date.now(),
      },
    );
  }

  private consumePendingCanaryOutcome(
    agentName: string,
    flagId: string,
    token: string,
  ): boolean {
    this.prunePendingCanaryOutcomes();
    const key = this.pendingCanaryOutcomeKey(agentName, token);
    const pending = this.pendingCanaryOutcomes.get(key);
    if (!pending || pending.flagId !== flagId) {
      return false;
    }
    this.pendingCanaryOutcomes.delete(key);
    return true;
  }

  private clearPendingCanaryOutcomes(agentName: string): void {
    const prefix = `${agentName}:`;
    for (const key of this.pendingCanaryOutcomes.keys()) {
      if (key.startsWith(prefix)) {
        this.pendingCanaryOutcomes.delete(key);
      }
    }
  }

  private prunePendingCanaryOutcomes(nowMs = Date.now()): void {
    for (const [key, pending] of this.pendingCanaryOutcomes.entries()) {
      if (nowMs - pending.createdAtMs > PENDING_CANARY_OUTCOME_TTL_MS) {
        this.pendingCanaryOutcomes.delete(key);
      }
    }
  }

  private publishCanaryStaged(deployment: CanaryDeploymentRecord): void {
    const payload: SelfModificationCanaryStagedPayload = {
      agentName: deployment.agentName,
      planId: deployment.planId,
      flagId: deployment.flagId,
      trafficPercent: deployment.trafficPercent,
      strategy: deployment.strategy,
      rollbackThreshold: deployment.rollbackThreshold,
      stagedAt: deployment.stagedAt,
    };
    this.options.bus?.publish({
      from: "system",
      to: "broadcast",
      topic: "self-modification.canary.staged",
      category: "quality",
      payload,
    });
  }

  private publishCanaryPromoted(
    deployment: CanaryDeploymentRecord,
    version: number,
  ): void {
    const payload: SelfModificationCanaryPromotedPayload = {
      agentName: deployment.agentName,
      planId: deployment.planId,
      flagId: deployment.flagId,
      promotedAt: new Date().toISOString(),
      version,
    };
    this.options.bus?.publish({
      from: "system",
      to: "broadcast",
      topic: "self-modification.canary.promoted",
      category: "quality",
      payload,
    });
  }

  private publishCanaryRolledBack(
    deployment: CanaryDeploymentRecord,
    rollback: CanaryRollbackRecord,
  ): void {
    const payload: SelfModificationCanaryRolledBackPayload = {
      agentName: deployment.agentName,
      planId: deployment.planId,
      flagId: deployment.flagId,
      rolledBackAt: rollback.rolledBackAt,
      reason: rollback.reason,
      errorRate: rollback.errorRate,
      threshold: rollback.threshold,
    };
    this.options.bus?.publish({
      from: "system",
      to: "broadcast",
      topic: "self-modification.canary.rolled_back",
      category: "quality",
      payload,
      priority: "high",
    });
  }

  private emptyCanaryMetrics(): CanaryDeploymentMetrics {
    return {
      canaryRequests: 0,
      canaryErrors: 0,
      errorRate: 0,
    };
  }

  private nextCanaryMetrics(
    current: CanaryDeploymentMetrics | undefined,
    isError: boolean,
  ): CanaryDeploymentMetrics {
    const previous = current ?? this.emptyCanaryMetrics();
    const canaryRequests = previous.canaryRequests + 1;
    const canaryErrors = previous.canaryErrors + (isError ? 1 : 0);
    return {
      canaryRequests,
      canaryErrors,
      errorRate: canaryRequests > 0 ? canaryErrors / canaryRequests : 0,
    };
  }

  private shouldRollbackCanary(deployment: CanaryDeploymentRecord): boolean {
    const metrics = deployment.metrics ?? this.emptyCanaryMetrics();
    return metrics.canaryRequests >= 5 && metrics.errorRate > deployment.rollbackThreshold;
  }

  private buildCanaryRollback(deployment: CanaryDeploymentRecord): CanaryRollbackRecord {
    const metrics = deployment.metrics ?? this.emptyCanaryMetrics();
    return {
      reason: `Auto-rollback: error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds threshold ${(deployment.rollbackThreshold * 100).toFixed(1)}%`,
      errorRate: metrics.errorRate,
      threshold: deployment.rollbackThreshold,
      rolledBackAt: new Date().toISOString(),
    };
  }

  private groupMutationsByAgent(mutations: AgentMutation[]): Map<string, AgentMutation[]> {
    const byAgent = new Map<string, AgentMutation[]>();
    for (const mutation of mutations) {
      const list = byAgent.get(mutation.agentName) ?? [];
      list.push(mutation);
      byAgent.set(mutation.agentName, list);
    }
    return byAgent;
  }

  private buildOverrideRecord(
    agentName: string,
    agentMutations: AgentMutation[],
    sessionId: string,
    existing?: AgentOverride | null,
  ): AgentOverride {
    const override: AgentOverride = {
      agentName,
      version: (existing?.version ?? 0) + 1,
      appliedAt: new Date().toISOString(),
      sessionId,
      mutations: agentMutations,
    };

    for (const mutation of agentMutations) {
      if (mutation.type === "model-tier-override") {
        override.modelTierOverride = mutation.newValue as NonNullable<AgentOverride["modelTierOverride"]>;
      } else if (mutation.type === "effort-override") {
        override.effortOverride = mutation.newValue as NonNullable<AgentOverride["effortOverride"]>;
      } else if (mutation.type === "system-prompt-preamble") {
        override.systemPromptPreamble = mutation.newValue as string;
      }
    }

    if (existing) {
      override.previousVersion = this.capHistory(existing);
    }

    return override;
  }

  private materializeOverride(
    template: AgentTemplate,
    override: AgentOverride,
  ): AgentTemplate {
    const chain: AgentOverride[] = [];
    let current: AgentOverride | undefined = override;
    while (current) {
      chain.push(current);
      current = current.previousVersion;
    }

    // Apply the override chain from oldest to newest so later versions can
    // intentionally layer on top of earlier ones.
    const result: AgentTemplate = { ...template };
    for (const entry of chain.reverse()) {
      if (entry.systemPromptPreamble) {
        result.system_prompt = `${entry.systemPromptPreamble}\n\n${result.system_prompt}`;
      }
      if (entry.modelTierOverride !== undefined) {
        result.model = entry.modelTierOverride;
      }
      if (entry.effortOverride !== undefined) {
        result.effort = entry.effortOverride;
      }
    }

    return result;
  }

  private clampPercent(percent: number): number {
    return Math.min(100, Math.max(0, percent));
  }

  private async writeOverride(
    agentName: string,
    override: AgentOverride,
  ): Promise<void> {
    await fs.mkdir(this.overridesDir, { recursive: true });
    const filePath = path.join(this.overridesDir, `${agentName}.json`);
    await fs.writeFile(filePath, JSON.stringify(override, null, 2), "utf-8");
  }

  private async writeStructuralProposal(plan: ReforgePlan): Promise<void> {
    await fs.mkdir(this.proposalsDir, { recursive: true });
    const filename = `${plan.timestamp.replace(/[:.]/g, "-")}-${plan.id.slice(0, 8)}.md`;
    const filePath = path.join(this.proposalsDir, filename);
    const content = [
      `# Structural Reforge Proposal`,
      ``,
      `**Plan ID:** ${plan.id}`,
      `**Generated:** ${plan.timestamp}`,
      `**Triggered By:** ${plan.triggeredBy}`,
      ``,
      `## Rationale`,
      plan.rationale,
      ``,
      `## Estimated Impact`,
      plan.estimatedImpact,
      ``,
      `## Review Required`,
      `This is a structural change proposal. It requires human review and approval before being applied.`,
      ``,
      `To apply: run \`agentforge reforge --apply-proposal ${plan.id}\``,
    ].join("\n");
    await fs.writeFile(filePath, content, "utf-8");
  }

  /**
   * Generates mutations for a single RecommendedAction across all matching templates.
   */
  private generateMutations(
    action: RecommendedAction,
    templates: AgentTemplate[],
  ): AgentMutation[] {
    const mutations: AgentMutation[] = [];

    if (action.action === "adjust-model-routing") {
      for (const template of templates) {
        const newTier =
          template.model === "opus"
            ? OPUS_DOWNGRADE_TARGET
            : template.model === "sonnet"
            ? SONNET_DOWNGRADE_TARGET
            : null;

        if (newTier) {
          mutations.push({
            type: "model-tier-override",
            agentName: template.name,
            field: "model",
            oldValue: template.model,
            newValue: newTier,
            rationale: action.rationale,
          });
        }
      }
    } else if (action.action === "update-system-prompt") {
      for (const template of templates) {
        mutations.push({
          type: "system-prompt-preamble",
          agentName: template.name,
          field: "system_prompt",
          oldValue: null,
          newValue: this.options.defaultPreamble,
          rationale: action.rationale,
        });
      }
    }

    return mutations;
  }

  private buildRationale(actions: RecommendedAction[]): string {
    if (actions.length === 0) return "No actions recommended — reforge requested manually.";
    return actions
      .map((a) => `[${a.action}] ${a.rationale}`)
      .join(" | ");
  }

  private estimateImpact(mutations: AgentMutation[]): string {
    if (mutations.length === 0) return "No local mutations to apply.";
    const tierChanges = mutations.filter((m) => m.type === "model-tier-override");
    const promptChanges = mutations.filter((m) => m.type === "system-prompt-preamble");
    const parts: string[] = [];
    if (tierChanges.length > 0) {
      parts.push(`${tierChanges.length} model tier override(s) applied`);
    }
    if (promptChanges.length > 0) {
      parts.push(`${promptChanges.length} system prompt preamble(s) injected`);
    }
    return parts.join("; ") + ".";
  }

  /**
   * Caps the previousVersion chain at MAX_VERSION_DEPTH - 1 links,
   * so the total chain (current + history) is at most MAX_VERSION_DEPTH.
   */
  private capHistory(override: AgentOverride): AgentOverride {
    // Walk the chain and rebuild it capped at MAX_VERSION_DEPTH - 1 history entries
    const chain: AgentOverride[] = [];
    let current: AgentOverride | undefined = override;
    while (current && chain.length < MAX_VERSION_DEPTH - 1) {
      // Strip previousVersion for the capped copy we're building
      const { previousVersion: _prev, ...rest } = current;
      chain.push(rest as AgentOverride);
      current = current.previousVersion;
    }

    // Rebuild from oldest to newest
    let rebuilt: AgentOverride | undefined;
    for (const node of chain.reverse()) {
      rebuilt = rebuilt ? { ...node, previousVersion: rebuilt } : { ...node };
    }
    return rebuilt ?? override;
  }
}
