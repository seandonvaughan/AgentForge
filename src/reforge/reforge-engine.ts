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

import type { FeedbackAnalysis, RecommendedAction } from "../types/feedback.js";
import type { AgentTemplate } from "../types/agent.js";
import type {
  AgentMutation,
  AgentOverride,
  ReforgePlan,
  ReforgeResult,
} from "../types/reforge.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum override history depth per agent (Iron Law 4). */
const MAX_VERSION_DEPTH = 5;

/** Default downgrade tier when adjust-model-routing fires on an Opus agent. */
const OPUS_DOWNGRADE_TARGET = "sonnet" as const;
const SONNET_DOWNGRADE_TARGET = "haiku" as const;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ReforgeEngineOptions {
  /**
   * Preamble text injected when `update-system-prompt` action fires.
   * Defaults to a generic cost-awareness reminder.
   */
  defaultPreamble?: string;
}

// ---------------------------------------------------------------------------
// ReforgeEngine
// ---------------------------------------------------------------------------

export class ReforgeEngine {
  private readonly overridesDir: string;
  private readonly proposalsDir: string;
  private readonly options: Required<ReforgeEngineOptions>;

  constructor(projectRoot: string, options?: ReforgeEngineOptions) {
    this.overridesDir = path.join(
      projectRoot,
      ".agentforge",
      "agent-overrides",
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
          override.modelTierOverride = mutation.newValue as AgentOverride["modelTierOverride"];
        } else if (mutation.type === "effort-override") {
          override.effortOverride = mutation.newValue as AgentOverride["effortOverride"];
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

  // =========================================================================
  // applyOverride
  // =========================================================================

  /**
   * Loads any stored override for the agent and applies it on top of the
   * provided template, returning a mutated copy.
   *
   * If no override exists, returns the template unchanged.
   */
  async applyOverride(template: AgentTemplate): Promise<AgentTemplate> {
    const override = await this.loadOverride(template.name);
    if (!override) return template;

    // Shallow-clone so we never mutate the caller's object
    const result: AgentTemplate = { ...template };

    if (override.systemPromptPreamble) {
      result.system_prompt = `${override.systemPromptPreamble}\n\n${template.system_prompt}`;
    }

    if (override.modelTierOverride) {
      result.model = override.modelTierOverride;
    }

    if (override.effortOverride) {
      result.effort = override.effortOverride;
    }

    return result;
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

  // =========================================================================
  // Private helpers
  // =========================================================================

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.overridesDir, { recursive: true });
    await fs.mkdir(this.proposalsDir, { recursive: true });
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
