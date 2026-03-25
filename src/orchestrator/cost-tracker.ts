/**
 * Cost Tracker for the AgentForge Orchestrator.
 *
 * Records token usage per agent and model tier, and produces
 * human-readable cost reports.
 */

import type { ModelTier } from "../types/agent.js";

/** A single usage record for one agent invocation. */
export interface TokenUsage {
  /** Name of the agent that consumed the tokens. */
  agent: string;
  /** Model tier used for the invocation. */
  model: ModelTier;
  /** Number of input (prompt) tokens. */
  input_tokens: number;
  /** Number of output (completion) tokens. */
  output_tokens: number;
  /** Sum of input and output tokens. */
  total_tokens: number;
  /** Estimated cost in US dollars. */
  estimated_cost_usd: number;
}

/** Aggregated cost report across all recorded usage. */
export interface CostReport {
  /** All individual usage records. */
  usages: TokenUsage[];
  /** Grand total of tokens consumed. */
  total_tokens: number;
  /** Grand total estimated cost in US dollars. */
  total_cost_usd: number;
  /** Token and cost totals broken down by model tier. */
  by_model: Record<ModelTier, { tokens: number; cost: number }>;
  /** Token and cost totals broken down by agent name. */
  by_agent: Record<string, { tokens: number; cost: number }>;
}

/**
 * Per-million-token pricing for each model tier.
 * Based on approximate Anthropic API pricing.
 */
const MODEL_COSTS: Record<ModelTier, { input: number; output: number }> = {
  opus: { input: 15.0, output: 75.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 0.25, output: 1.25 },
};

/**
 * Tracks token usage and estimated costs across agents and model tiers.
 */
export class CostTracker {
  private readonly usages: TokenUsage[] = [];

  /**
   * Records a usage event for the given agent and model tier.
   */
  recordUsage(
    agent: string,
    model: ModelTier,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const costs = MODEL_COSTS[model];
    const inputCost = (inputTokens / 1_000_000) * costs.input;
    const outputCost = (outputTokens / 1_000_000) * costs.output;

    this.usages.push({
      agent,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      estimated_cost_usd: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    });
  }

  /**
   * Generates a full cost report with per-model and per-agent breakdowns.
   */
  getReport(): CostReport {
    const byModel: Record<ModelTier, { tokens: number; cost: number }> = {
      opus: { tokens: 0, cost: 0 },
      sonnet: { tokens: 0, cost: 0 },
      haiku: { tokens: 0, cost: 0 },
    };

    const byAgent: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCost = 0;

    for (const usage of this.usages) {
      totalTokens += usage.total_tokens;
      totalCost += usage.estimated_cost_usd;

      byModel[usage.model].tokens += usage.total_tokens;
      byModel[usage.model].cost += usage.estimated_cost_usd;

      if (!byAgent[usage.agent]) {
        byAgent[usage.agent] = { tokens: 0, cost: 0 };
      }
      byAgent[usage.agent].tokens += usage.total_tokens;
      byAgent[usage.agent].cost += usage.estimated_cost_usd;
    }

    return {
      usages: [...this.usages],
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      by_model: byModel,
      by_agent: byAgent,
    };
  }

  /**
   * Returns the total estimated cost for a specific agent.
   */
  getAgentCost(agent: string): number {
    let cost = 0;
    for (const usage of this.usages) {
      if (usage.agent === agent) {
        cost += usage.estimated_cost_usd;
      }
    }
    return Math.round(cost * 1_000_000) / 1_000_000;
  }

  /**
   * Returns a human-readable cost report with table formatting.
   */
  formatReport(): string {
    const report = this.getReport();
    const lines: string[] = [];

    lines.push("=== AgentForge Cost Report ===");
    lines.push("");

    // Summary
    lines.push(
      `Total tokens: ${report.total_tokens.toLocaleString()}`,
    );
    lines.push(
      `Total cost:   $${report.total_cost_usd.toFixed(4)}`,
    );
    lines.push("");

    // By model tier
    lines.push("--- By Model Tier ---");
    lines.push(
      `${"Model".padEnd(10)} ${"Tokens".padStart(12)} ${"Cost".padStart(10)}`,
    );
    lines.push("-".repeat(34));
    for (const tier of ["opus", "sonnet", "haiku"] as ModelTier[]) {
      const entry = report.by_model[tier];
      if (entry.tokens > 0) {
        lines.push(
          `${tier.padEnd(10)} ${entry.tokens.toLocaleString().padStart(12)} ${("$" + entry.cost.toFixed(4)).padStart(10)}`,
        );
      }
    }
    lines.push("");

    // By agent
    lines.push("--- By Agent ---");
    lines.push(
      `${"Agent".padEnd(20)} ${"Tokens".padStart(12)} ${"Cost".padStart(10)}`,
    );
    lines.push("-".repeat(44));
    const sortedAgents = Object.entries(report.by_agent).sort(
      (a, b) => b[1].cost - a[1].cost,
    );
    for (const [agent, entry] of sortedAgents) {
      lines.push(
        `${agent.padEnd(20)} ${entry.tokens.toLocaleString().padStart(12)} ${("$" + entry.cost.toFixed(4)).padStart(10)}`,
      );
    }

    return lines.join("\n");
  }
}
