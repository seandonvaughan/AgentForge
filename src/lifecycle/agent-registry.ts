/**
 * AgentRegistry — Agent Identity Hub Phase 1.2
 *
 * Manages agent identity CRUD with in-memory Map for fast lookup
 * and SQLite persistence via agent_careers + career_events tables.
 */

import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "../db/database.js";
import type {
  AgentIdentity,
  AgentStatus,
  TechnicalLayer,
} from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Row types for SQLite result mapping
// ---------------------------------------------------------------------------

interface AgentCareerRow {
  agent_id: string;
  hired_at: string;
  current_team: string;
  current_role: string;
  seniority: string;
  autonomy_tier: number;
  tasks_completed: number;
  success_rate: number;
  avg_task_duration: number;
  peer_review_score: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private agents: Map<string, AgentIdentity> = new Map();
  private db: AgentDatabase | null;

  private constructor(db: AgentDatabase | null) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create an AgentRegistry pre-loaded from the database.
   * Agents are reconstructed with a minimal identity from the career table.
   * Fields not stored in agent_careers (model, currentTasks, maxConcurrentTasks)
   * are seeded with sensible defaults.
   */
  static loadFromDb(db: AgentDatabase): AgentRegistry {
    const registry = new AgentRegistry(db);
    const rows = db
      .getDb()
      .prepare<[], AgentCareerRow>("SELECT * FROM agent_careers")
      .all();

    for (const row of rows) {
      const identity: AgentIdentity = {
        id: row.agent_id,
        name: row.agent_id, // fallback; callers may update via update()
        role: row.current_role as AgentIdentity["role"],
        seniority: row.seniority as AgentIdentity["seniority"],
        layer: "backend" as TechnicalLayer, // default; update() to correct
        teamId: row.current_team,
        model: "sonnet" as AgentIdentity["model"],
        status: "idle",
        hiredAt: row.hired_at,
        currentTasks: [],
        maxConcurrentTasks: 1,
      };
      registry.agents.set(identity.id, identity);
    }

    return registry;
  }

  /**
   * Create an AgentRegistry without a database (useful for tests or
   * in-memory-only usage).
   */
  static createInMemory(): AgentRegistry {
    return new AgentRegistry(null);
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  /**
   * Register a new agent. Persists to agent_careers and inserts a "hired"
   * career event. Throws if the agent ID is already registered.
   */
  register(identity: AgentIdentity): void {
    if (this.agents.has(identity.id)) {
      throw new Error(`Agent "${identity.id}" is already registered`);
    }

    this.agents.set(identity.id, { ...identity });

    if (this.db) {
      const now = new Date().toISOString();
      const sqlite = this.db.getDb();

      // Insert career record
      sqlite
        .prepare(
          `INSERT INTO agent_careers
           (agent_id, hired_at, current_team, current_role, seniority, autonomy_tier, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          identity.id,
          identity.hiredAt,
          identity.teamId,
          identity.role,
          identity.seniority,
          1, // default autonomy tier
          now
        );

      // Insert "hired" career event
      sqlite
        .prepare(
          `INSERT INTO career_events (id, agent_id, event_type, details, timestamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          identity.id,
          "hired",
          JSON.stringify({
            team: identity.teamId,
            role: identity.role,
            seniority: identity.seniority,
          }),
          now
        );
    }
  }

  /**
   * Look up an agent by ID. Returns undefined if not found.
   */
  get(id: string): AgentIdentity | undefined {
    return this.agents.get(id);
  }

  /**
   * Apply a partial update to an existing agent identity.
   * Persists changed career fields (team, role, seniority) to SQLite.
   * Throws if the agent does not exist.
   */
  update(id: string, partial: Partial<AgentIdentity>): AgentIdentity {
    const existing = this.agents.get(id);
    if (!existing) {
      throw new Error(`Agent "${id}" not found`);
    }

    const updated: AgentIdentity = { ...existing, ...partial };
    this.agents.set(id, updated);

    if (this.db) {
      const now = new Date().toISOString();
      this.db
        .getDb()
        .prepare(
          `UPDATE agent_careers
           SET current_team = ?, current_role = ?, seniority = ?, updated_at = ?
           WHERE agent_id = ?`
        )
        .run(
          updated.teamId,
          updated.role,
          updated.seniority,
          now,
          id
        );
    }

    return updated;
  }

  /**
   * Mark an agent as terminated. Updates status in memory and persists to DB.
   * Inserts a "terminated" career event.
   * Throws if the agent does not exist.
   */
  terminate(id: string, reason?: string): void {
    const existing = this.agents.get(id);
    if (!existing) {
      throw new Error(`Agent "${id}" not found`);
    }

    const terminated: AgentIdentity = { ...existing, status: "terminated" };
    this.agents.set(id, terminated);

    if (this.db) {
      const now = new Date().toISOString();
      const sqlite = this.db.getDb();

      sqlite
        .prepare(
          `UPDATE agent_careers SET updated_at = ? WHERE agent_id = ?`
        )
        .run(now, id);

      sqlite
        .prepare(
          `INSERT INTO career_events (id, agent_id, event_type, details, timestamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          id,
          "terminated",
          JSON.stringify({ reason: reason ?? "unspecified" }),
          now
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Return all registered agents (snapshot). */
  list(): AgentIdentity[] {
    return Array.from(this.agents.values());
  }

  /** Return all agents belonging to the given team. */
  listByTeam(teamId: string): AgentIdentity[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.teamId === teamId
    );
  }

  /** Return all agents in the given technical layer. */
  listByLayer(layer: TechnicalLayer): AgentIdentity[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.layer === layer
    );
  }

  /** Return all agents with the given status. */
  listByStatus(status: AgentStatus): AgentIdentity[] {
    return Array.from(this.agents.values()).filter(
      (a) => a.status === status
    );
  }
}
