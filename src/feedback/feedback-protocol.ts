/**
 * FeedbackProtocol — v4.6 P0-4
 *
 * Structured agent feedback capture: per-task entries, sprint summaries,
 * markdown formatting, and file-based persistence via pluggable adapter.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FeedbackEntry {
  agentId: string;
  taskId: string;
  sprintId: string;
  timestamp: string;
  whatWorked: string[];
  whatDidnt: string[];
  recommendations: string[];
  timeSpentMs: number;
  blockers: string[];
  selfAssessment: "exceeded" | "met" | "partial" | "failed";
  modelTierAppropriate: boolean;
}

export interface FeedbackSummary {
  sprintId: string;
  agentCount: number;
  entryCount: number;
  topWins: string[];
  topBlockers: string[];
  topRecommendations: string[];
  avgSelfAssessment: number;
  modelMismatchCount: number;
}

export interface FeedbackFileAdapter {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  fileExists(path: string): boolean;
}

// ---------------------------------------------------------------------------
// File adapters
// ---------------------------------------------------------------------------

export class RealFeedbackFileAdapter implements FeedbackFileAdapter {
  readFile(path: string): string {
    return readFileSync(path, "utf-8");
  }
  writeFile(path: string, content: string): void {
    writeFileSync(path, content, "utf-8");
  }
  fileExists(path: string): boolean {
    return existsSync(path);
  }
}

export class InMemoryFeedbackFileAdapter implements FeedbackFileAdapter {
  files = new Map<string, string>();

  readFile(path: string): string {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    return content;
  }
  writeFile(path: string, content: string): void {
    this.files.set(path, content);
  }
  fileExists(path: string): boolean {
    return this.files.has(path);
  }
}

// ---------------------------------------------------------------------------
// Snapshot shape for persistence
// ---------------------------------------------------------------------------

interface FeedbackSnapshot {
  entries: FeedbackEntry[];
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FeedbackProtocolOptions {
  fileAdapter?: FeedbackFileAdapter;
  autoSavePath?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSESSMENT_SCORE: Record<FeedbackEntry["selfAssessment"], number> = {
  failed: 0,
  partial: 1,
  met: 2,
  exceeded: 3,
};

/**
 * Collect all strings from a list of string arrays, count frequency, return
 * the top-N by descending frequency. Ties resolved by first-seen order.
 */
function topByFrequency(items: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item]) => item);
}

// ---------------------------------------------------------------------------
// FeedbackProtocol
// ---------------------------------------------------------------------------

export class FeedbackProtocol {
  private entries: FeedbackEntry[] = [];
  private readonly fileAdapter: FeedbackFileAdapter;
  private readonly autoSavePath?: string;

  constructor(options?: FeedbackProtocolOptions) {
    this.fileAdapter = options?.fileAdapter ?? new RealFeedbackFileAdapter();
    this.autoSavePath = options?.autoSavePath;
  }

  // -------------------------------------------------------------------------
  // Record & query
  // -------------------------------------------------------------------------

  recordEntry(entry: FeedbackEntry): void {
    this.entries.push({ ...entry });
    this.maybeAutoSave();
  }

  getEntries(filter?: { agentId?: string; sprintId?: string }): FeedbackEntry[] {
    let result = this.entries.map((e) => ({ ...e }));
    if (filter?.agentId !== undefined) {
      result = result.filter((e) => e.agentId === filter.agentId);
    }
    if (filter?.sprintId !== undefined) {
      result = result.filter((e) => e.sprintId === filter.sprintId);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Sprint summary
  // -------------------------------------------------------------------------

  generateSprintSummary(sprintId: string): FeedbackSummary {
    const sprintEntries = this.entries.filter((e) => e.sprintId === sprintId);
    const agentIds = new Set(sprintEntries.map((e) => e.agentId));

    const allWins = sprintEntries.flatMap((e) => e.whatWorked);
    const allBlockers = sprintEntries.flatMap((e) => e.blockers);
    const allRecommendations = sprintEntries.flatMap((e) => e.recommendations);

    const avgSelfAssessment =
      sprintEntries.length === 0
        ? 0
        : sprintEntries.reduce((sum, e) => sum + ASSESSMENT_SCORE[e.selfAssessment], 0) /
          sprintEntries.length;

    const modelMismatchCount = sprintEntries.filter((e) => !e.modelTierAppropriate).length;

    return {
      sprintId,
      agentCount: agentIds.size,
      entryCount: sprintEntries.length,
      topWins: topByFrequency(allWins, 3),
      topBlockers: topByFrequency(allBlockers, 3),
      topRecommendations: topByFrequency(allRecommendations, 3),
      avgSelfAssessment,
      modelMismatchCount,
    };
  }

  // -------------------------------------------------------------------------
  // Markdown formatting
  // -------------------------------------------------------------------------

  generateMarkdown(entry: FeedbackEntry): string {
    const date = entry.timestamp.split("T")[0] ?? entry.timestamp;
    const modelTierLabel = entry.modelTierAppropriate ? "yes" : "no";

    const listOrNone = (items: string[]): string =>
      items.length === 0 ? "_none_\n" : items.map((i) => `- ${i}`).join("\n") + "\n";

    return [
      `# Agent Feedback — ${entry.agentId} — ${date}`,
      "",
      `**Task:** ${entry.taskId}  `,
      `**Sprint:** ${entry.sprintId}  `,
      `**Self-Assessment:** ${entry.selfAssessment}  `,
      `**Model Tier Appropriate:** ${modelTierLabel}  `,
      `**Time Spent:** ${entry.timeSpentMs}ms`,
      "",
      "## What Worked",
      listOrNone(entry.whatWorked),
      "## What Didn't Work",
      listOrNone(entry.whatDidnt),
      "## Recommendations",
      listOrNone(entry.recommendations),
      "## Blockers",
      listOrNone(entry.blockers),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  save(path: string): void {
    const snapshot: FeedbackSnapshot = {
      entries: this.entries.map((e) => ({ ...e })),
      savedAt: new Date().toISOString(),
    };
    this.fileAdapter.writeFile(path, JSON.stringify(snapshot, null, 2));
  }

  static load(path: string, options?: FeedbackProtocolOptions): FeedbackProtocol {
    const fileAdapter = options?.fileAdapter ?? new RealFeedbackFileAdapter();

    if (!fileAdapter.fileExists(path)) {
      return new FeedbackProtocol({ ...options, fileAdapter });
    }

    const raw = fileAdapter.readFile(path);
    const snapshot: FeedbackSnapshot = JSON.parse(raw);

    const protocol = new FeedbackProtocol({ ...options, fileAdapter });
    (protocol as any).entries = snapshot.entries ?? [];
    return protocol;
  }

  private maybeAutoSave(): void {
    if (this.autoSavePath) {
      this.save(this.autoSavePath);
    }
  }
}
