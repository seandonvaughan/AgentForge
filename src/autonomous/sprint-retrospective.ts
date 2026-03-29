/**
 * SprintRetrospective — Automated Learn Phase
 *
 * Pure function module that compiles sprint metrics from a SprintFile +
 * task memories, identifies patterns, and generates learnings and
 * recommendations for the next sprint cycle.
 *
 * No side effects — takes data in, returns a SprintRetrospective out.
 */

import type { TaskMemory } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SprintRetrospective {
  sprintId: string;
  version: string;
  metrics: {
    itemsCompleted: number;
    itemsTotal: number;
    totalCostUsd: number;
    avgCostPerItem: number;
    totalTokens: number;
    durationMs: number;
    agentsUsed: string[];
  };
  patterns: {
    whatWentWell: string[];
    whatDidnt: string[];
    recurringBlockers: string[];
  };
  learnings: string[];
  recommendations: string[];
}

// ---------------------------------------------------------------------------
// SprintData shape — matches SprintFile from sprint-orchestration.ts
// ---------------------------------------------------------------------------

export interface SprintDataItem {
  id: string;
  title: string;
  assignee: string;
  status: "planned" | "in_progress" | "completed" | "blocked" | "deferred";
  completedAt?: string;
}

export interface SprintData {
  sprintId: string;
  version: string;
  createdAt: string;
  phase: string;
  items: SprintDataItem[];
  budget: number;
  budgetUsed?: number;
  agentsInvolved?: string[];
  successCriteria?: string[];
  auditFindings?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract recurring blocker patterns from item titles and task memory outcomes. */
function extractBlockers(
  items: SprintDataItem[],
  memories: TaskMemory[],
): string[] {
  const blockers: string[] = [];

  // Items that remained blocked or were deferred
  const stuckItems = items.filter(
    (i) => i.status === "blocked" || i.status === "deferred",
  );
  if (stuckItems.length > 0) {
    blockers.push(
      `${stuckItems.length} item(s) blocked or deferred: ${stuckItems.map((i) => `"${i.title}"`).join(", ")}`,
    );
  }

  // Recurring lessons from task memories
  const lessonFreq = new Map<string, number>();
  for (const mem of memories) {
    for (const lesson of mem.lessonsLearned) {
      lessonFreq.set(lesson, (lessonFreq.get(lesson) ?? 0) + 1);
    }
  }

  for (const [lesson, count] of lessonFreq) {
    if (count >= 2) {
      blockers.push(`Recurring lesson (${count}×): "${lesson}"`);
    }
  }

  // High failure rate agents
  const agentOutcomes = new Map<string, { success: number; failure: number }>();
  for (const mem of memories) {
    const agentId = mem.objective?.split(" ")[0] ?? "unknown";
    const entry = agentOutcomes.get(agentId) ?? { success: 0, failure: 0 };
    if (mem.outcome === "success") {
      entry.success++;
    } else if (mem.outcome === "failure") {
      entry.failure++;
    }
    agentOutcomes.set(agentId, entry);
  }

  for (const [agentId, counts] of agentOutcomes) {
    const total = counts.success + counts.failure;
    if (total >= 3 && counts.failure / total > 0.5) {
      blockers.push(
        `Agent "${agentId}" had high failure rate (${counts.failure}/${total} failures)`,
      );
    }
  }

  return blockers;
}

/** Derive what went well from completed items and successful memories. */
function extractWhatWentWell(
  items: SprintDataItem[],
  memories: TaskMemory[],
  budgetUsed: number,
  budget: number,
): string[] {
  const well: string[] = [];

  const completed = items.filter((i) => i.status === "completed");
  const completionRate =
    items.length > 0 ? completed.length / items.length : 0;

  if (completionRate >= 0.9) {
    well.push(`High completion rate: ${completed.length}/${items.length} items done (${Math.round(completionRate * 100)}%)`);
  } else if (completionRate >= 0.7) {
    well.push(`Good completion rate: ${completed.length}/${items.length} items done (${Math.round(completionRate * 100)}%)`);
  }

  // Budget under-run is positive
  if (budget > 0 && budgetUsed <= budget * 0.85) {
    well.push(
      `Stayed under budget: $${budgetUsed.toFixed(2)} of $${budget.toFixed(2)} used (${Math.round((budgetUsed / budget) * 100)}%)`,
    );
  }

  // Successful memories indicate patterns that worked
  const successfulMemories = memories.filter((m) => m.outcome === "success");
  if (successfulMemories.length > 0 && memories.length > 0) {
    const successRate = successfulMemories.length / memories.length;
    if (successRate >= 0.8) {
      well.push(
        `Strong task success rate across agents: ${Math.round(successRate * 100)}% (${successfulMemories.length}/${memories.length})`,
      );
    }
  }

  // Items with low difficulty completed successfully
  const easySuccess = memories.filter(
    (m) => m.outcome === "success" && m.difficulty <= 2,
  );
  if (easySuccess.length >= 3) {
    well.push(
      `Low-complexity tasks executed reliably: ${easySuccess.length} items completed with difficulty ≤2`,
    );
  }

  return well;
}

/** Derive what didn't go well from incomplete items and failing memories. */
function extractWhatDidnt(
  items: SprintDataItem[],
  memories: TaskMemory[],
  budgetUsed: number,
  budget: number,
): string[] {
  const didnt: string[] = [];

  const incomplete = items.filter(
    (i) => i.status !== "completed" && i.status !== "deferred",
  );
  if (incomplete.length > 0) {
    didnt.push(
      `${incomplete.length} item(s) not completed: ${incomplete.map((i) => `"${i.title}" (${i.status})`).join(", ")}`,
    );
  }

  // Budget overrun
  if (budget > 0 && budgetUsed > budget) {
    didnt.push(
      `Budget exceeded: $${budgetUsed.toFixed(2)} spent vs $${budget.toFixed(2)} budget (+${Math.round(((budgetUsed - budget) / budget) * 100)}%)`,
    );
  }

  // High difficulty failures
  const hardFailures = memories.filter(
    (m) => m.outcome === "failure" && m.difficulty >= 4,
  );
  if (hardFailures.length > 0) {
    didnt.push(
      `${hardFailures.length} high-difficulty task(s) failed (difficulty ≥4) — consider breaking down scope`,
    );
  }

  // Memory failures overall
  const failedMemories = memories.filter((m) => m.outcome === "failure");
  if (failedMemories.length > 0 && memories.length > 0) {
    const failRate = failedMemories.length / memories.length;
    if (failRate > 0.3) {
      didnt.push(
        `Elevated failure rate: ${Math.round(failRate * 100)}% of recorded tasks failed (${failedMemories.length}/${memories.length})`,
      );
    }
  }

  return didnt;
}

/** Build human-readable learnings from pattern analysis. */
function compileLearnings(
  whatWentWell: string[],
  whatDidnt: string[],
  recurringBlockers: string[],
  memories: TaskMemory[],
): string[] {
  const learnings: string[] = [];

  if (whatWentWell.length > 0) {
    learnings.push(
      `STRENGTHS: ${whatWentWell.length} positive pattern(s) identified — maintain these practices going forward`,
    );
  }

  if (whatDidnt.length > 0) {
    learnings.push(
      `GAPS: ${whatDidnt.length} improvement area(s) detected — prioritise remediation in next sprint`,
    );
  }

  if (recurringBlockers.length > 0) {
    learnings.push(
      `BLOCKERS: ${recurringBlockers.length} recurring obstacle(s) — address root causes in plan phase`,
    );
  }

  // Token efficiency insight
  const totalTokens = memories.reduce((sum, m) => sum + (m.tokensUsed ?? 0), 0);
  if (memories.length > 0 && totalTokens > 0) {
    const avgTokens = Math.round(totalTokens / memories.length);
    learnings.push(
      `COST: Average ${avgTokens.toLocaleString()} tokens per task across ${memories.length} recorded run(s)`,
    );
  }

  // High difficulty success stories
  const hardSuccess = memories.filter(
    (m) => m.outcome === "success" && m.difficulty >= 4,
  );
  if (hardSuccess.length > 0) {
    learnings.push(
      `GROWTH: ${hardSuccess.length} high-difficulty task(s) successfully completed — team capability expanding`,
    );
  }

  return learnings;
}

/** Generate actionable recommendations for the next sprint. */
function compileRecommendations(
  items: SprintDataItem[],
  memories: TaskMemory[],
  budgetUsed: number,
  budget: number,
  whatDidnt: string[],
  recurringBlockers: string[],
): string[] {
  const recommendations: string[] = [];

  const completionRate =
    items.length > 0
      ? items.filter((i) => i.status === "completed").length / items.length
      : 0;

  if (completionRate < 0.7) {
    recommendations.push(
      "Reduce sprint scope: completion rate below 70%. Consider carrying fewer items next sprint.",
    );
  }

  if (budget > 0 && budgetUsed > budget) {
    recommendations.push(
      "Tighten model routing: budget exceeded. Ensure Haiku handles low-complexity items and only escalate to Sonnet/Opus when necessary.",
    );
  }

  if (recurringBlockers.length >= 2) {
    recommendations.push(
      "Schedule a blocker-review session before sprint planning to clear known impediments.",
    );
  }

  const failedMemories = memories.filter((m) => m.outcome === "failure");
  if (failedMemories.length > 2) {
    recommendations.push(
      "Add pre-flight checks: multiple task failures suggest agents need clearer prompts, better context, or task decomposition.",
    );
  }

  const highDiffItems = memories.filter((m) => m.difficulty >= 4);
  if (highDiffItems.length > 0) {
    recommendations.push(
      "Break down complex items (difficulty ≥4) into smaller sub-tasks before assigning to ensure better agent outcomes.",
    );
  }

  if (whatDidnt.length === 0 && completionRate >= 0.9) {
    recommendations.push(
      "Sprint executed well. Consider increasing scope or complexity in the next cycle to maintain growth trajectory.",
    );
  }

  if (recommendations.length === 0) {
    recommendations.push(
      "No critical issues detected. Maintain current practices and monitor token costs for efficiency gains.",
    );
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a sprint retrospective from a completed sprint file and task memories.
 *
 * Pure function — no I/O, no side effects.
 *
 * @param sprintData   - The sprint JSON object (matches SprintFile shape).
 * @param taskMemories - Flat array of all task memories recorded during the sprint.
 */
export function generateRetrospective(
  sprintData: SprintData,
  taskMemories: TaskMemory[],
): SprintRetrospective {
  const items = sprintData.items ?? [];
  const budgetUsed = sprintData.budgetUsed ?? 0;
  const budget = sprintData.budget ?? 0;

  // ── Metrics ───────────────────────────────────────────────────────────────

  const itemsCompleted = items.filter((i) => i.status === "completed").length;
  const itemsTotal = items.length;

  const totalTokens = taskMemories.reduce(
    (sum, m) => sum + (m.tokensUsed ?? 0),
    0,
  );

  // Duration: from sprint creation to last completedAt, or 0 if unresolvable
  const completedAts = items
    .filter((i) => i.completedAt)
    .map((i) => new Date(i.completedAt!).getTime());
  const lastCompletedMs =
    completedAts.length > 0 ? Math.max(...completedAts) : 0;
  const createdAtMs = new Date(sprintData.createdAt).getTime();
  const durationMs =
    lastCompletedMs > createdAtMs ? lastCompletedMs - createdAtMs : 0;

  // Unique agents from sprint data + task memories
  const agentsSet = new Set<string>([
    ...(sprintData.agentsInvolved ?? []),
    ...items.map((i) => i.assignee).filter(Boolean),
  ]);
  const agentsUsed = Array.from(agentsSet).sort();

  const avgCostPerItem =
    itemsCompleted > 0 ? budgetUsed / itemsCompleted : 0;

  // ── Pattern extraction ────────────────────────────────────────────────────

  const whatWentWell = extractWhatWentWell(items, taskMemories, budgetUsed, budget);
  const whatDidnt = extractWhatDidnt(items, taskMemories, budgetUsed, budget);
  const recurringBlockers = extractBlockers(items, taskMemories);

  // ── Synthesis ─────────────────────────────────────────────────────────────

  const learnings = compileLearnings(
    whatWentWell,
    whatDidnt,
    recurringBlockers,
    taskMemories,
  );

  const recommendations = compileRecommendations(
    items,
    taskMemories,
    budgetUsed,
    budget,
    whatDidnt,
    recurringBlockers,
  );

  return {
    sprintId: sprintData.sprintId,
    version: sprintData.version,
    metrics: {
      itemsCompleted,
      itemsTotal,
      totalCostUsd: budgetUsed,
      avgCostPerItem: Math.round(avgCostPerItem * 10000) / 10000,
      totalTokens,
      durationMs,
      agentsUsed,
    },
    patterns: {
      whatWentWell,
      whatDidnt,
      recurringBlockers,
    },
    learnings,
    recommendations,
  };
}
