/**
 * AgentLifecycleManager — Agent Identity Hub Phase 1.3
 *
 * Central facade that coordinates AgentRegistry and TeamRegistry.
 * Handles agent identity, team management, and hiring recommendations.
 */

import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "../db/database.js";
import type { V4MessageBus } from "../communication/v4-message-bus.js";
import { AgentRegistry } from "./agent-registry.js";
import { TeamRegistry } from "./team-registry.js";
import type {
  AgentIdentity,
  TeamUnit,
  HiringRecommendation,
  TechnicalLayer,
} from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LifecycleManagerOptions {
  db?: AgentDatabase;
  bus?: V4MessageBus;
}

// ---------------------------------------------------------------------------
// AgentLifecycleManager
// ---------------------------------------------------------------------------

export class AgentLifecycleManager {
  private agentRegistry: AgentRegistry;
  private teamRegistry: TeamRegistry;
  private db: AgentDatabase | null;
  private bus: V4MessageBus | null;

  private constructor(
    agentRegistry: AgentRegistry,
    teamRegistry: TeamRegistry,
    db: AgentDatabase | null,
    bus: V4MessageBus | null
  ) {
    this.agentRegistry = agentRegistry;
    this.teamRegistry = teamRegistry;
    this.db = db;
    this.bus = bus;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create and initialise an AgentLifecycleManager.
   * When a db is provided, both registries are loaded from persistent storage.
   */
  static create(options: LifecycleManagerOptions = {}): AgentLifecycleManager {
    const { db, bus } = options;

    const agentRegistry = db
      ? AgentRegistry.loadFromDb(db)
      : AgentRegistry.createInMemory();

    const teamRegistry = db
      ? TeamRegistry.loadFromDb(db)
      : TeamRegistry.createInMemory();

    return new AgentLifecycleManager(
      agentRegistry,
      teamRegistry,
      db ?? null,
      bus ?? null
    );
  }

  // ---------------------------------------------------------------------------
  // Agent API
  // ---------------------------------------------------------------------------

  /**
   * Look up an agent by ID. Returns undefined if not found.
   */
  getAgent(id: string): AgentIdentity | undefined {
    return this.agentRegistry.get(id);
  }

  /**
   * Register a new agent. Persists to DB and emits a "hired" career event.
   * Throws if the agent ID already exists.
   */
  registerAgent(identity: AgentIdentity): void {
    this.agentRegistry.register(identity);
  }

  /**
   * Terminate an agent, recording the reason.
   * Throws if the agent does not exist.
   */
  terminateAgent(id: string, reason?: string): void {
    this.agentRegistry.terminate(id, reason);
  }

  // ---------------------------------------------------------------------------
  // Team API
  // ---------------------------------------------------------------------------

  /**
   * Look up a team by ID. Returns undefined if not found.
   */
  getTeam(id: string): TeamUnit | undefined {
    return this.teamRegistry.getTeam(id);
  }

  /**
   * Register a new team. Persists to DB.
   * Throws if a team with the same ID already exists.
   */
  createTeam(unit: TeamUnit): void {
    this.teamRegistry.createTeam(unit);
  }

  /**
   * Move an agent from their current team to another team.
   * Updates both the TeamRegistry membership and the AgentRegistry identity.
   * Throws if the agent or either team does not exist.
   */
  reassignAgent(agentId: string, toTeamId: string): void {
    const agent = this.agentRegistry.get(agentId);
    if (!agent) {
      throw new Error(`Agent "${agentId}" not found`);
    }

    const fromTeamId = agent.teamId;

    // Update team membership
    this.teamRegistry.reassignMember(agentId, fromTeamId, toTeamId);

    // Update agent identity
    this.agentRegistry.update(agentId, { teamId: toTeamId });

    // Persist reassignment career event if DB is available
    if (this.db) {
      const now = new Date().toISOString();
      this.db
        .getDb()
        .prepare(
          `INSERT INTO career_events (id, agent_id, event_type, details, timestamp)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          agentId,
          "reassigned",
          JSON.stringify({ fromTeam: fromTeamId, toTeam: toTeamId }),
          now
        );
    }
  }

  // ---------------------------------------------------------------------------
  // Hiring Recommendations API
  // ---------------------------------------------------------------------------

  /**
   * Submit a new hiring recommendation for review.
   * Persists to the hiring_recommendations table.
   * Returns the generated recommendation ID.
   */
  requestHire(
    recommendation: Omit<HiringRecommendation, "id" | "status" | "createdAt" | "decidedBy" | "decidedAt">
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `INSERT INTO hiring_recommendations
           (id, team_id, requested_role, requested_seniority, requested_skills,
            justification, status, requested_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          id,
          recommendation.teamId,
          recommendation.requestedRole,
          recommendation.requestedSeniority,
          JSON.stringify(recommendation.requestedSkills ?? []),
          recommendation.justification ?? null,
          recommendation.requestedBy ?? null,
          now
        );
    }

    return id;
  }

  /**
   * Approve a pending hiring recommendation.
   * Throws if the recommendation does not exist in the DB.
   */
  approveHire(recommendationId: string, decidedBy: string): void {
    this._updateHireStatus(recommendationId, "approved", decidedBy);
  }

  /**
   * Deny a pending hiring recommendation, recording the reason in justification.
   * Throws if the recommendation does not exist in the DB.
   */
  denyHire(
    recommendationId: string,
    decidedBy: string,
    reason?: string
  ): void {
    this._updateHireStatus(recommendationId, "denied", decidedBy, reason);
  }

  // ---------------------------------------------------------------------------
  // Convenience queries
  // ---------------------------------------------------------------------------

  /**
   * Return all agents belonging to a team.
   */
  getAgentsByTeam(teamId: string): AgentIdentity[] {
    return this.agentRegistry.listByTeam(teamId);
  }

  /**
   * Return the utilization ratio (currentLoad/maxCapacity) for a team.
   */
  getTeamUtilization(teamId: string): number {
    return this.teamRegistry.getUtilization(teamId);
  }

  /**
   * Return all agents in a technical layer.
   */
  getAgentsByLayer(layer: TechnicalLayer): AgentIdentity[] {
    return this.agentRegistry.listByLayer(layer);
  }

  /**
   * Return all teams in a technical layer.
   */
  getTeamsByLayer(layer: TechnicalLayer): TeamUnit[] {
    return this.teamRegistry.getTeamsByLayer(layer);
  }

  /**
   * Return all registered agents.
   */
  listAgents(): AgentIdentity[] {
    return this.agentRegistry.list();
  }

  /**
   * Return all registered teams.
   */
  listTeams(): TeamUnit[] {
    return this.teamRegistry.listTeams();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _updateHireStatus(
    recommendationId: string,
    status: "approved" | "denied",
    decidedBy: string,
    reason?: string
  ): void {
    if (!this.db) return;

    const now = new Date().toISOString();
    const sqlite = this.db.getDb();

    const info = sqlite
      .prepare(
        `UPDATE hiring_recommendations
         SET status = ?, decided_by = ?, decided_at = ?${reason ? ", justification = justification || ' | Decision reason: ' || ?" : ""}
         WHERE id = ?`
      )
      .run(
        ...(reason
          ? [status, decidedBy, now, reason, recommendationId]
          : [status, decidedBy, now, recommendationId])
      );

    if (info.changes === 0) {
      throw new Error(
        `Hiring recommendation "${recommendationId}" not found`
      );
    }
  }
}
