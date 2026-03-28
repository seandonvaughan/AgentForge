/**
 * TeamRegistry — Agent Identity Hub Phase 1.2
 *
 * Manages team structure with in-memory Map for fast lookup
 * and SQLite persistence via the teams table.
 */

import type { AgentDatabase } from "../db/database.js";
import type { TeamUnit, TechnicalLayer } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Row types for SQLite result mapping
// ---------------------------------------------------------------------------

interface TeamRow {
  id: string;
  layer: string;
  manager_id: string | null;
  tech_lead_id: string | null;
  max_capacity: number;
  domain: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// TeamRegistry
// ---------------------------------------------------------------------------

export class TeamRegistry {
  /** In-memory team store keyed by team ID. */
  private teams: Map<string, TeamUnit> = new Map();
  private db: AgentDatabase | null;

  private constructor(db: AgentDatabase | null) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create a TeamRegistry pre-loaded from the database.
   * Members (specialists, currentLoad) are not stored in the teams table
   * and are initialised to empty/zero; callers should populate via addMember().
   */
  static loadFromDb(db: AgentDatabase): TeamRegistry {
    const registry = new TeamRegistry(db);
    const rows = db
      .getDb()
      .prepare<[], TeamRow>("SELECT * FROM teams")
      .all();

    for (const row of rows) {
      const unit: TeamUnit = {
        id: row.id,
        layer: row.layer as TechnicalLayer,
        manager: row.manager_id ?? "",
        techLead: row.tech_lead_id ?? "",
        specialists: [],
        maxCapacity: row.max_capacity,
        currentLoad: 0,
        domain: row.domain ? JSON.parse(row.domain) : [],
      };
      registry.teams.set(unit.id, unit);
    }

    return registry;
  }

  /**
   * Create a TeamRegistry without a database connection.
   */
  static createInMemory(): TeamRegistry {
    return new TeamRegistry(null);
  }

  // ---------------------------------------------------------------------------
  // Team CRUD
  // ---------------------------------------------------------------------------

  /**
   * Register a new team unit. Persists to the teams table.
   * Throws if a team with the same ID already exists.
   */
  createTeam(unit: TeamUnit): void {
    if (this.teams.has(unit.id)) {
      throw new Error(`Team "${unit.id}" already exists`);
    }

    this.teams.set(unit.id, { ...unit, specialists: [...unit.specialists] });

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `INSERT INTO teams (id, layer, manager_id, tech_lead_id, max_capacity, domain)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          unit.id,
          unit.layer,
          unit.manager || null,
          unit.techLead || null,
          unit.maxCapacity,
          JSON.stringify(unit.domain)
        );
    }
  }

  /**
   * Retrieve a team by ID. Returns undefined if not found.
   */
  getTeam(id: string): TeamUnit | undefined {
    return this.teams.get(id);
  }

  // ---------------------------------------------------------------------------
  // Membership management
  // ---------------------------------------------------------------------------

  /**
   * Add an agent to a team's specialists list.
   * Throws if the team does not exist or is at max capacity.
   */
  addMember(teamId: string, agentId: string): void {
    const team = this._requireTeam(teamId);

    if (team.specialists.includes(agentId)) {
      return; // idempotent
    }

    if (team.specialists.length >= team.maxCapacity) {
      throw new Error(
        `Team "${teamId}" is at max capacity (${team.maxCapacity})`
      );
    }

    team.specialists.push(agentId);
  }

  /**
   * Remove an agent from a team's specialists list.
   * No-op if the agent is not in the team.
   */
  removeMember(teamId: string, agentId: string): void {
    const team = this._requireTeam(teamId);
    const idx = team.specialists.indexOf(agentId);
    if (idx !== -1) {
      team.specialists.splice(idx, 1);
    }
  }

  /**
   * Move an agent from one team to another atomically.
   * Throws if either team does not exist, or if the destination team is full.
   */
  reassignMember(
    agentId: string,
    fromTeamId: string,
    toTeamId: string
  ): void {
    this.removeMember(fromTeamId, agentId);
    this.addMember(toTeamId, agentId);
  }

  // ---------------------------------------------------------------------------
  // Utilization
  // ---------------------------------------------------------------------------

  /**
   * Returns the utilization ratio for a team: currentLoad / maxCapacity.
   * Returns 0 if the team is empty or maxCapacity is 0.
   */
  getUtilization(teamId: string): number {
    const team = this._requireTeam(teamId);
    if (team.maxCapacity === 0) return 0;
    return team.currentLoad / team.maxCapacity;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /** Return all teams (snapshot). */
  listTeams(): TeamUnit[] {
    return Array.from(this.teams.values());
  }

  /** Return all teams in the given technical layer. */
  getTeamsByLayer(layer: TechnicalLayer): TeamUnit[] {
    return Array.from(this.teams.values()).filter((t) => t.layer === layer);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _requireTeam(teamId: string): TeamUnit {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team "${teamId}" not found`);
    }
    return team;
  }
}
