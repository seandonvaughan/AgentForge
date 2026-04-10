/**
 * SessionMemoryManager — v4.5 P0-3
 *
 * Persists cross-session memory so agents retain context across
 * Claude Code restarts. Saves key learnings, decisions, and patterns
 * to disk on session end, and reloads them on session start.
 *
 * Rolling window: keeps the last N sessions, compacting older ones
 * into summary records.
 *
 * Zero new npm dependencies (Iron Law 5).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single memory entry from a session. */
export interface SessionMemoryEntry {
  /** Unique identifier. */
  id: string;
  /** Which session produced this entry. */
  sessionId: string;
  /** Category of memory. */
  category: "task-outcome" | "pattern-discovered" | "agent-interaction" | "error-recovery" | "gate-verdict";
  /** Agent that produced or is associated with this entry. */
  agentId: string;
  /** Summary of what happened. */
  summary: string;
  /** Whether the associated task/interaction was successful. */
  success: boolean;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /**
   * Optional structured payload for category-specific data.
   * For "gate-verdict" entries written by GatePhaseHandler this carries
   * { cycleId, verdict, rationale, criticalFindings, majorFindings }.
   */
  metadata?: Record<string, unknown>;
}

/** A session summary for the rolling history. */
export interface SessionSummaryRecord {
  /** Session ID. */
  sessionId: string;
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 end time. */
  endedAt: string;
  /** Number of agent runs in this session. */
  agentRuns: number;
  /** Total cost in USD. */
  totalCostUsd: number;
  /** Key entries from this session. */
  entries: SessionMemoryEntry[];
}

/** The full persisted memory state. */
export interface SessionMemoryState {
  /** Version of the memory format. */
  version: string;
  /** Rolling session summaries (newest first). */
  sessions: SessionSummaryRecord[];
  /** Compacted summaries from older sessions. */
  compactedSummaries: string[];
  /** Last updated timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of full session records to retain. */
const MAX_SESSIONS = 20;

/** Default file path relative to project root. */
const DEFAULT_RELATIVE_PATH = ".agentforge/memory/session-history.json";

// ---------------------------------------------------------------------------
// SessionMemoryManager
// ---------------------------------------------------------------------------

export class SessionMemoryManager {
  private state: SessionMemoryState;
  private readonly filePath: string;
  private dirty = false;

  private constructor(filePath: string, state: SessionMemoryState) {
    this.filePath = filePath;
    this.state = state;
  }

  // =========================================================================
  // Factory
  // =========================================================================

  /**
   * Load or create a SessionMemoryManager.
   * Reads from disk if the file exists; creates an empty state otherwise.
   */
  static async load(projectRoot: string): Promise<SessionMemoryManager> {
    const filePath = path.join(projectRoot, DEFAULT_RELATIVE_PATH);

    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const state = JSON.parse(raw) as SessionMemoryState;
      return new SessionMemoryManager(filePath, state);
    } catch {
      const emptyState: SessionMemoryState = {
        version: "1.0",
        sessions: [],
        compactedSummaries: [],
        updatedAt: new Date().toISOString(),
      };
      return new SessionMemoryManager(filePath, emptyState);
    }
  }

  /**
   * Create a manager with a specific file path (for testing).
   */
  static createWithPath(filePath: string): SessionMemoryManager {
    const emptyState: SessionMemoryState = {
      version: "1.0",
      sessions: [],
      compactedSummaries: [],
      updatedAt: new Date().toISOString(),
    };
    return new SessionMemoryManager(filePath, emptyState);
  }

  // =========================================================================
  // Recording
  // =========================================================================

  /**
   * Record a completed session with its memory entries.
   */
  recordSession(summary: SessionSummaryRecord): void {
    // Prepend newest first
    this.state.sessions.unshift({
      ...summary,
      entries: summary.entries.map((e) => ({ ...e })),
    });

    // Compact if over the rolling window limit
    while (this.state.sessions.length > MAX_SESSIONS) {
      const oldest = this.state.sessions.pop()!;
      const compacted = `Session ${oldest.sessionId} (${oldest.startedAt}): ${oldest.agentRuns} agent runs, $${oldest.totalCostUsd.toFixed(4)} spent, ${oldest.entries.length} entries`;
      this.state.compactedSummaries.push(compacted);
    }

    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
  }

  /**
   * Add a single memory entry to the current (most recent) session.
   * If no sessions exist, creates a placeholder session.
   */
  addEntry(entry: SessionMemoryEntry): void {
    if (this.state.sessions.length === 0) {
      this.state.sessions.push({
        sessionId: entry.sessionId,
        startedAt: entry.timestamp,
        endedAt: entry.timestamp,
        agentRuns: 0,
        totalCostUsd: 0,
        entries: [],
      });
    }

    const current = this.state.sessions[0];
    current.entries.push({ ...entry });
    current.endedAt = entry.timestamp;
    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
  }

  // =========================================================================
  // Retrieval
  // =========================================================================

  /**
   * Get the most recent N sessions.
   */
  getRecentSessions(count?: number): SessionSummaryRecord[] {
    const n = count ?? MAX_SESSIONS;
    return this.state.sessions
      .slice(0, n)
      .map((s) => ({
        ...s,
        entries: s.entries.map((e) => ({ ...e })),
      }));
  }

  /**
   * Get all entries matching a category across all sessions.
   */
  getEntriesByCategory(
    category: SessionMemoryEntry["category"],
  ): SessionMemoryEntry[] {
    const results: SessionMemoryEntry[] = [];
    for (const session of this.state.sessions) {
      for (const entry of session.entries) {
        if (entry.category === category) {
          results.push({ ...entry });
        }
      }
    }
    return results;
  }

  /**
   * Get all entries for a specific agent across all sessions.
   */
  getEntriesForAgent(agentId: string): SessionMemoryEntry[] {
    const results: SessionMemoryEntry[] = [];
    for (const session of this.state.sessions) {
      for (const entry of session.entries) {
        if (entry.agentId === agentId) {
          results.push({ ...entry });
        }
      }
    }
    return results;
  }

  /**
   * Build a context string suitable for injection into an agent's prompt.
   * Summarizes recent session history for continuity.
   */
  buildContextSummary(maxEntries?: number): string {
    const limit = maxEntries ?? 10;
    const recentEntries: SessionMemoryEntry[] = [];

    for (const session of this.state.sessions) {
      for (const entry of session.entries) {
        if (recentEntries.length >= limit) break;
        recentEntries.push(entry);
      }
      if (recentEntries.length >= limit) break;
    }

    if (recentEntries.length === 0) {
      return "No previous session history available.";
    }

    const lines = recentEntries.map(
      (e) =>
        `[${e.category}] ${e.agentId}: ${e.summary} (${e.success ? "success" : "failure"})`,
    );

    return `Recent session history (${recentEntries.length} entries):\n${lines.join("\n")}`;
  }

  /**
   * Get the total number of sessions in history.
   */
  getSessionCount(): number {
    return this.state.sessions.length;
  }

  /**
   * Get compacted summaries from older sessions.
   */
  getCompactedSummaries(): string[] {
    return [...this.state.compactedSummaries];
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  /**
   * Save the current state to disk.
   */
  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(this.state, null, 2),
      "utf-8",
    );
    this.dirty = false;
  }

  /**
   * Check if there are unsaved changes.
   */
  isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Get the raw state (for testing/inspection).
   */
  getState(): SessionMemoryState {
    return JSON.parse(JSON.stringify(this.state));
  }
}
