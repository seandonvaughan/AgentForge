/**
 * ReportGenerator — P2-4: Data Analyst First Queries
 *
 * Produces structured analytics reports from live SQLite data via SqliteAdapter.
 * Each report method returns a ReportSection; generateAll() combines all 5.
 */

import { writeFile } from 'node:fs/promises';
import type { SqliteAdapter } from '../db/sqlite-adapter.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ReportSection {
  title: string;
  rows: Array<Record<string, string | number>>;
  summary?: string;
}

export interface AnalyticsReport {
  title: string;
  generatedAt: string;
  sections: ReportSection[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPRINT_PATTERN = /v\d+\.\d+/;

function extractSprint(text: string): string {
  const match = SPRINT_PATTERN.exec(text);
  return match ? match[0] : 'Unknown';
}

function fmtCost(value: number): string {
  return value.toFixed(4);
}

function fmtPct(numerator: number, denominator: number): string {
  if (denominator === 0) return '0.0%';
  return ((numerator / denominator) * 100).toFixed(1) + '%';
}

function dateOnly(isoString: string): string {
  return isoString.substring(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().substring(0, 10);
}

// ---------------------------------------------------------------------------
// ReportGenerator
// ---------------------------------------------------------------------------

export class ReportGenerator {
  constructor(private readonly adapter: SqliteAdapter) {}

  /**
   * Report 1: Total spend by sprint.
   * Groups sessions by sprint identifier found in task text ("v4.5", etc.),
   * aggregates cost from agent_costs.
   */
  async spendBySprint(): Promise<ReportSection> {
    const sessions = this.adapter.listSessions();
    const costs = this.adapter.getAllCosts();

    if (sessions.length === 0 && costs.length === 0) {
      return {
        title: 'Spend by Sprint',
        rows: [],
        summary: 'No data available',
      };
    }

    const sessionSprint = new Map<string, string>();
    for (const s of sessions) {
      sessionSprint.set(s.id, extractSprint(s.task));
    }

    const sprintCost = new Map<string, number>();
    const sprintSessions = new Map<string, Set<string>>();

    for (const cost of costs) {
      const sprint = cost.session_id
        ? (sessionSprint.get(cost.session_id) ?? 'Unknown')
        : 'Unknown';

      sprintCost.set(sprint, (sprintCost.get(sprint) ?? 0) + cost.cost_usd);

      if (cost.session_id) {
        if (!sprintSessions.has(sprint)) sprintSessions.set(sprint, new Set());
        sprintSessions.get(sprint)!.add(cost.session_id);
      }
    }

    for (const [, sprint] of sessionSprint) {
      if (!sprintCost.has(sprint)) sprintCost.set(sprint, 0);
    }

    const rows = Array.from(sprintCost.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([sprint, total]) => ({
        sprint,
        sessions: sprintSessions.get(sprint)?.size ?? 0,
        total_cost_usd: fmtCost(total),
      }));

    const grandTotal = Array.from(sprintCost.values()).reduce((s, v) => s + v, 0);

    return {
      title: 'Spend by Sprint',
      rows,
      summary: `Total spend: $${fmtCost(grandTotal)} across ${sprintCost.size} sprint(s)`,
    };
  }

  /**
   * Report 2: Top 10 most expensive agents by total cost.
   */
  async topExpensiveAgents(): Promise<ReportSection> {
    const costs = this.adapter.getAllCosts();

    if (costs.length === 0) {
      return {
        title: 'Top 10 Most Expensive Agents',
        rows: [],
        summary: 'No data available',
      };
    }

    const agentCost = new Map<string, { total: number; calls: number; model: string }>();

    for (const cost of costs) {
      const existing = agentCost.get(cost.agent_id);
      if (existing) {
        existing.total += cost.cost_usd;
        existing.calls += 1;
      } else {
        agentCost.set(cost.agent_id, {
          total: cost.cost_usd,
          calls: 1,
          model: cost.model,
        });
      }
    }

    const rows = Array.from(agentCost.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 10)
      .map(([agent_id, data]) => ({
        agent_id,
        model: data.model,
        total_cost_usd: fmtCost(data.total),
        invocations: data.calls,
      }));

    return {
      title: 'Top 10 Most Expensive Agents',
      rows,
      summary: `Showing top ${rows.length} of ${agentCost.size} agent(s)`,
    };
  }

  /**
   * Report 3: Success rate by model tier.
   * Groups task_outcomes by model, calculates success rate.
   */
  async successRateByModel(): Promise<ReportSection> {
    const outcomes = this.adapter.listTaskOutcomes();

    if (outcomes.length === 0) {
      return {
        title: 'Success Rate by Model',
        rows: [],
        summary: 'No data available',
      };
    }

    const modelStats = new Map<string, { total: number; successes: number }>();

    for (const outcome of outcomes) {
      const model = outcome.model ?? 'unknown';
      const existing = modelStats.get(model);
      if (existing) {
        existing.total += 1;
        existing.successes += outcome.success ? 1 : 0;
      } else {
        modelStats.set(model, {
          total: 1,
          successes: outcome.success ? 1 : 0,
        });
      }
    }

    const rows = Array.from(modelStats.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .map(([model, stats]) => ({
        model,
        total_tasks: stats.total,
        successes: stats.successes,
        success_rate: fmtPct(stats.successes, stats.total),
      }));

    const totalTasks = outcomes.length;
    const totalSuccesses = outcomes.filter(o => o.success).length;

    return {
      title: 'Success Rate by Model',
      rows,
      summary: `Overall success rate: ${fmtPct(totalSuccesses, totalTasks)} (${totalSuccesses}/${totalTasks} tasks)`,
    };
  }

  /**
   * Report 4: Cost trend — group by day, last 30 days.
   */
  async costTrendByDay(): Promise<ReportSection> {
    const costs = this.adapter.getAllCosts();
    const cutoff = daysAgo(30);

    const recent = costs.filter(c => c.created_at.substring(0, 10) >= cutoff);

    if (recent.length === 0) {
      return {
        title: 'Cost Trend (Last 30 Days)',
        rows: [],
        summary: 'No data available',
      };
    }

    const dayMap = new Map<string, { total: number; calls: number }>();

    for (const cost of recent) {
      const day = dateOnly(cost.created_at);
      const existing = dayMap.get(day);
      if (existing) {
        existing.total += cost.cost_usd;
        existing.calls += 1;
      } else {
        dayMap.set(day, { total: cost.cost_usd, calls: 1 });
      }
    }

    const rows = Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, data]) => ({
        date,
        total_cost_usd: fmtCost(data.total),
        invocations: data.calls,
      }));

    const grandTotal = recent.reduce((s, c) => s + c.cost_usd, 0);

    return {
      title: 'Cost Trend (Last 30 Days)',
      rows,
      summary: `Total spend last 30 days: $${fmtCost(grandTotal)} over ${rows.length} day(s)`,
    };
  }

  /**
   * Report 5: Delegation depth distribution.
   * Count sessions by delegation_depth (0, 1, 2, 3+).
   */
  async delegationDepthDistribution(): Promise<ReportSection> {
    const sessions = this.adapter.listSessions();

    if (sessions.length === 0) {
      return {
        title: 'Delegation Depth Distribution',
        rows: [],
        summary: 'No data available',
      };
    }

    const buckets: Record<string, number> = {
      '0': 0,
      '1': 0,
      '2': 0,
      '3+': 0,
    };

    for (const s of sessions) {
      const depth = s.delegation_depth ?? 0;
      if (depth >= 3) {
        buckets['3+'] += 1;
      } else {
        buckets[String(depth)] += 1;
      }
    }

    const rows = Object.entries(buckets).map(([depth, count]) => ({
      delegation_depth: depth,
      session_count: count,
      percentage: fmtPct(count, sessions.length),
    }));

    const maxDepth = Math.max(...sessions.map(s => s.delegation_depth ?? 0));

    return {
      title: 'Delegation Depth Distribution',
      rows,
      summary: `${sessions.length} total session(s), max depth: ${maxDepth}`,
    };
  }

  /**
   * Generate all 5 reports and combine into a single AnalyticsReport.
   */
  async generateAll(): Promise<AnalyticsReport> {
    const [
      sprintSection,
      agentsSection,
      successSection,
      trendSection,
      depthSection,
    ] = await Promise.all([
      this.spendBySprint(),
      this.topExpensiveAgents(),
      this.successRateByModel(),
      this.costTrendByDay(),
      this.delegationDepthDistribution(),
    ]);

    return {
      title: 'AgentForge Analytics Report',
      generatedAt: new Date().toISOString(),
      sections: [
        sprintSection,
        agentsSection,
        successSection,
        trendSection,
        depthSection,
      ],
    };
  }

  /**
   * Save a report as JSON to the given output path.
   */
  async saveReport(report: AnalyticsReport, outputPath: string): Promise<void> {
    await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
  }
}
