import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProgressLedger } from "../types/orchestration.js";

/**
 * Persists ProgressLedger snapshots to .agentforge/sessions/ for cross-session learning.
 * Used by ReforgeEngine (Phase 2) to analyze performance trends across sessions.
 */
export class SessionStore {
  private sessionsDir: string;

  constructor(projectRoot: string) {
    this.sessionsDir = path.join(projectRoot, ".agentforge", "sessions");
  }

  /** Save a ledger snapshot with timestamp. */
  async saveSnapshot(ledger: ProgressLedger): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const filePath = path.join(
      this.sessionsDir,
      `${ledger.task_id}-${Date.now()}.json`,
    );
    await fs.writeFile(filePath, JSON.stringify(ledger, null, 2), "utf-8");
  }

  /** Load the most recent snapshot for a given task. */
  async loadLatest(taskId: string): Promise<ProgressLedger | null> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      // Use taskId + "-" prefix to avoid matching "task-1" against "task-10"
      const prefix = taskId + "-";
      const snapshots = entries
        .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
        .sort();

      if (snapshots.length === 0) return null;

      const latest = path.join(this.sessionsDir, snapshots[snapshots.length - 1]);
      const data = await fs.readFile(latest, "utf-8");
      return JSON.parse(data) as ProgressLedger;
    } catch {
      return null;
    }
  }

  /** Load all snapshots for cross-session learning — used by ReforgeEngine. */
  async loadAllSnapshots(): Promise<ProgressLedger[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      const results: ProgressLedger[] = [];
      for (const f of entries.filter((e) => e.endsWith(".json"))) {
        try {
          const data = await fs.readFile(path.join(this.sessionsDir, f), "utf-8");
          results.push(JSON.parse(data) as ProgressLedger);
        } catch {
          // Skip corrupted files
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
