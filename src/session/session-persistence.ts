/**
 * SessionPersistence — Sprint 4.4 P0-2
 *
 * Writes V4Session records to disk so the dashboard, flywheel, and
 * MetaLearningEngine can read real outcomes without holding state in-process.
 *
 * Files written:
 *   <dir>/<sessionId>.json  — full session record
 *   <dir>/index.json        — append-only summary array
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { V4Session } from "./v4-session-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  agentName?: string;
  model?: string;
  task: string;
  response?: string;
  startedAt: string;
  completedAt?: string;
  estimatedTokens?: number;
  status: string;
  autonomyTier?: number;
  resumeCount?: number;
}

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  model?: string;
  task: string;
  status: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionToRecord(session: V4Session): SessionRecord {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    task: session.taskDescription,
    response: session.result,
    startedAt: session.createdAt,
    completedAt: session.status === "completed" || session.status === "expired"
      ? session.updatedAt
      : undefined,
    status: session.status,
    autonomyTier: session.autonomyTier,
    resumeCount: session.resumeCount,
  };
}

function sessionToSummary(session: V4Session): SessionSummary {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    task: session.taskDescription.slice(0, 120),
    status: session.status,
    completedAt: session.status === "completed" || session.status === "expired"
      ? session.updatedAt
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// SessionPersistence
// ---------------------------------------------------------------------------

export class SessionPersistence {
  constructor(private readonly dir: string) {}

  /**
   * Write the full session record and append a summary to index.json.
   * Creates the output directory if it does not exist.
   */
  async save(session: V4Session): Promise<void> {
    await mkdir(this.dir, { recursive: true });

    const record = sessionToRecord(session);
    const recordPath = join(this.dir, `${session.sessionId}.json`);
    await writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");

    const indexPath = join(this.dir, "index.json");
    const existing = await this.loadIndex();

    // Replace existing entry for this session (idempotent) or append
    const idx = existing.findIndex((s) => s.sessionId === session.sessionId);
    const summary = sessionToSummary(session);
    if (idx >= 0) {
      existing[idx] = summary;
    } else {
      existing.push(summary);
    }

    await writeFile(indexPath, JSON.stringify(existing, null, 2), "utf8");
  }

  /**
   * Read the summary index. Returns [] if index.json does not exist yet.
   */
  async loadIndex(): Promise<SessionSummary[]> {
    const indexPath = join(this.dir, "index.json");
    try {
      const raw = await readFile(indexPath, "utf8");
      return JSON.parse(raw) as SessionSummary[];
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return [];
      throw err;
    }
  }

  /**
   * Load the full record for a session by ID. Returns null if not found.
   */
  async loadSession(id: string): Promise<SessionRecord | null> {
    const recordPath = join(this.dir, `${id}.json`);
    try {
      const raw = await readFile(recordPath, "utf8");
      return JSON.parse(raw) as SessionRecord;
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === "ENOENT") return null;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
