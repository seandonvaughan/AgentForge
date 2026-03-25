/**
 * DecisionLog — Append-only decision audit trail for the v3 communication layer.
 *
 * Records decisions made during agent execution with full context:
 * what was decided, what alternatives existed, why this option was chosen,
 * and links to any produced artifacts.
 *
 * Persists to `.agentforge/decisions/` as individual JSON files.
 *
 * Iron Law 5: Zero new npm dependencies.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { DecisionType, DecisionEntry } from "../types/decision.js";

// ---------------------------------------------------------------------------
// DecisionLog
// ---------------------------------------------------------------------------

export class DecisionLog {
  private readonly decisionsDir: string;
  private decisionsRecorded = 0;

  constructor(projectRoot: string) {
    this.decisionsDir = path.join(projectRoot, ".agentforge", "decisions");
  }

  // =========================================================================
  // Write
  // =========================================================================

  /**
   * Record a decision. Returns the generated entry ID.
   *
   * The caller provides all fields except `id` and `timestamp`, which are
   * auto-generated. This ensures decisions are immutable once recorded.
   */
  async record(
    entry: Omit<DecisionEntry, "id" | "timestamp">,
  ): Promise<string> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    const full: DecisionEntry = {
      ...entry,
      id,
      timestamp,
    };

    await this.writeToDisk(full);
    this.decisionsRecorded++;
    return id;
  }

  // =========================================================================
  // Read
  // =========================================================================

  /** Load the most recent N decisions (default: 20). */
  async getRecent(count = 20): Promise<DecisionEntry[]> {
    const all = await this.loadAll();
    // Sort by timestamp descending
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return all.slice(0, count);
  }

  /** Load all decisions of a specific type. */
  async queryByType(type: DecisionType): Promise<DecisionEntry[]> {
    const all = await this.loadAll();
    return all.filter((d) => d.type === type);
  }

  /** Load all decisions made by a specific agent. */
  async queryByAgent(agent: string): Promise<DecisionEntry[]> {
    const all = await this.loadAll();
    return all.filter((d) => d.agent === agent);
  }

  /** Load all decisions for a specific session. */
  async queryBySession(sessionId: string): Promise<DecisionEntry[]> {
    const all = await this.loadAll();
    return all.filter((d) => d.sessionId === sessionId);
  }

  /** Load every decision entry from disk. */
  async loadAll(): Promise<DecisionEntry[]> {
    try {
      const files = await fs.readdir(this.decisionsDir);
      const results: DecisionEntry[] = [];
      for (const file of files.filter((f) => f.endsWith(".json"))) {
        try {
          const raw = await fs.readFile(
            path.join(this.decisionsDir, file),
            "utf-8",
          );
          results.push(JSON.parse(raw) as DecisionEntry);
        } catch {
          // Skip corrupted files
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  // =========================================================================
  // Metrics
  // =========================================================================

  /** Number of decisions recorded during this log's lifetime. */
  getDecisionsRecordedCount(): number {
    return this.decisionsRecorded;
  }

  // =========================================================================
  // Disk I/O
  // =========================================================================

  private async writeToDisk(entry: DecisionEntry): Promise<void> {
    await fs.mkdir(this.decisionsDir, { recursive: true });
    // Filename: timestamp-id.json (timestamp sanitized for filesystem)
    const safeTimestamp = entry.timestamp.replace(/[:.]/g, "-");
    const filename = `${safeTimestamp}-${entry.id.slice(0, 8)}.json`;
    const filePath = path.join(this.decisionsDir, filename);
    await fs.writeFile(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }
}
