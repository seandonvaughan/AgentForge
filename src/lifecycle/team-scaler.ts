/**
 * TeamScaler — Agent Identity Hub Phase 5
 *
 * Monitors team health via utilization metrics and generates
 * hiring recommendations when teams are consistently overloaded.
 * Recommendations are persisted to the hiring_recommendations table
 * and can be approved or denied by an executive agent.
 */

import { randomUUID } from "node:crypto";
import type { AgentDatabase } from "../db/database.js";
import type {
  TeamUnit,
  HiringRecommendation,
  HiringStatus,
  AgentRole,
  SeniorityLevel,
} from "../types/lifecycle.js";
import { SENIORITY_CONFIG } from "../types/lifecycle.js";

// ---------------------------------------------------------------------------
// Row types for SQLite result mapping
// ---------------------------------------------------------------------------

interface HiringRecommendationRow {
  id: string;
  team_id: string;
  requested_role: string;
  requested_seniority: string;
  requested_skills: string | null;
  justification: string | null;
  status: string;
  requested_by: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

// ---------------------------------------------------------------------------
// TeamScaler
// ---------------------------------------------------------------------------

/** Default overload threshold (85 % utilization). */
const DEFAULT_OVERLOAD_THRESHOLD = 0.85;
/** Number of utilization data-points to retain per team. */
const UTILIZATION_HISTORY_LIMIT = 10;
/** Minimum consecutive overloaded readings to consider a team "consistently overloaded". */
const CONSISTENTLY_OVERLOADED_MIN_READINGS = 3;

export class TeamScaler {
  /** All tracked hiring recommendations, keyed by recommendation ID. */
  private recommendations: Map<string, HiringRecommendation> = new Map();
  /** teamId → rolling array of utilization values (latest appended). */
  private utilizationHistory: Map<string, number[]> = new Map();
  private db: AgentDatabase | null;

  constructor({ db }: { db?: AgentDatabase } = {}) {
    this.db = db ?? null;
  }

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  /**
   * Create a TeamScaler pre-loaded with pending recommendations from the DB.
   */
  static loadFromDb(db: AgentDatabase): TeamScaler {
    const scaler = new TeamScaler({ db });

    const rows = db
      .getDb()
      .prepare<[], HiringRecommendationRow>(
        "SELECT * FROM hiring_recommendations WHERE status = 'pending'"
      )
      .all();

    for (const row of rows) {
      const rec = TeamScaler._rowToRecommendation(row);
      scaler.recommendations.set(rec.id, rec);
    }

    return scaler;
  }

  // ---------------------------------------------------------------------------
  // Health analysis
  // ---------------------------------------------------------------------------

  /**
   * Compute the current utilization of a team and determine whether it is
   * overloaded and how much headroom remains.
   *
   * utilization = currentLoad / (maxCapacity × averageConcurrency)
   * where averageConcurrency is the mean maxConcurrentTasks of all specialists
   * (derived from their seniority; defaults to mid-level = 2 if no specialists).
   */
  analyzeTeamHealth(
    team: TeamUnit
  ): { utilization: number; isOverloaded: boolean; headroomSlots: number } {
    // Derive average concurrency from specialists' seniority configs.
    // TeamUnit.specialists is an array of agent IDs; we can't look up individual
    // seniority here, so we use the mid-level default (2) as a conservative
    // estimate when the roster isn't available.  Callers that need accuracy
    // should pass enriched TeamUnit objects with specialist counts matching
    // their actual seniority distribution.
    const specialistCount = team.specialists.length;
    const averageConcurrency =
      specialistCount > 0
        ? SENIORITY_CONFIG["mid"].maxConcurrentTasks
        : SENIORITY_CONFIG["mid"].maxConcurrentTasks;

    const denominator = team.maxCapacity * averageConcurrency;
    const utilization = denominator > 0 ? team.currentLoad / denominator : 0;

    const isOverloaded = utilization > DEFAULT_OVERLOAD_THRESHOLD;
    const headroomSlots = Math.max(0, team.maxCapacity - specialistCount);

    return { utilization, isOverloaded, headroomSlots };
  }

  // ---------------------------------------------------------------------------
  // Utilization history
  // ---------------------------------------------------------------------------

  /**
   * Append a utilization value for a team.
   * Retains only the last UTILIZATION_HISTORY_LIMIT entries.
   */
  recordUtilization(teamId: string, utilization: number): void {
    let history = this.utilizationHistory.get(teamId);
    if (!history) {
      history = [];
      this.utilizationHistory.set(teamId, history);
    }
    history.push(utilization);
    if (history.length > UTILIZATION_HISTORY_LIMIT) {
      history.splice(0, history.length - UTILIZATION_HISTORY_LIMIT);
    }
  }

  /**
   * Return true if the last CONSISTENTLY_OVERLOADED_MIN_READINGS (3) utilization
   * values for this team are all above the given threshold.
   */
  isConsistentlyOverloaded(
    teamId: string,
    threshold: number = DEFAULT_OVERLOAD_THRESHOLD
  ): boolean {
    const history = this.utilizationHistory.get(teamId);
    if (!history || history.length < CONSISTENTLY_OVERLOADED_MIN_READINGS) {
      return false;
    }

    const recent = history.slice(-CONSISTENTLY_OVERLOADED_MIN_READINGS);
    return recent.every((v) => v > threshold);
  }

  // ---------------------------------------------------------------------------
  // Recommendations
  // ---------------------------------------------------------------------------

  /**
   * Generate a new hiring recommendation for a team and persist it to the DB.
   */
  generateHiringRecommendation(
    teamId: string,
    justification: string,
    requestedBy: string,
    requestedRole?: AgentRole,
    requestedSeniority?: SeniorityLevel,
    requestedSkills?: string[]
  ): HiringRecommendation {
    const now = new Date().toISOString();
    const rec: HiringRecommendation = {
      id: randomUUID(),
      teamId,
      requestedRole: requestedRole ?? "specialist",
      requestedSeniority: requestedSeniority ?? "mid",
      requestedSkills: requestedSkills ?? [],
      justification,
      status: "pending",
      requestedBy,
      createdAt: now,
    };

    this.recommendations.set(rec.id, rec);

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `INSERT INTO hiring_recommendations
           (id, team_id, requested_role, requested_seniority, requested_skills,
            justification, status, requested_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          rec.id,
          rec.teamId,
          rec.requestedRole,
          rec.requestedSeniority,
          JSON.stringify(rec.requestedSkills),
          rec.justification,
          rec.status,
          rec.requestedBy,
          rec.createdAt
        );
    }

    return rec;
  }

  /**
   * Approve a pending hiring recommendation.
   * Returns the updated recommendation, or null if not found.
   */
  approveRecommendation(
    id: string,
    decidedBy: string
  ): HiringRecommendation | null {
    return this._updateDecision(id, "approved", decidedBy);
  }

  /**
   * Deny a pending hiring recommendation.
   * Returns the updated recommendation, or null if not found.
   */
  denyRecommendation(
    id: string,
    decidedBy: string
  ): HiringRecommendation | null {
    return this._updateDecision(id, "denied", decidedBy);
  }

  /**
   * Return all recommendations that are still pending.
   */
  getPendingRecommendations(): HiringRecommendation[] {
    return Array.from(this.recommendations.values()).filter(
      (r) => r.status === "pending"
    );
  }

  /**
   * Return all recommendations associated with a given team, in any status.
   */
  getRecommendationsByTeam(teamId: string): HiringRecommendation[] {
    return Array.from(this.recommendations.values()).filter(
      (r) => r.teamId === teamId
    );
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply an approve/deny decision to a recommendation, persist to DB, and
   * return the updated object.
   */
  private _updateDecision(
    id: string,
    status: HiringStatus,
    decidedBy: string
  ): HiringRecommendation | null {
    const rec = this.recommendations.get(id);
    if (!rec) return null;

    const now = new Date().toISOString();
    const updated: HiringRecommendation = {
      ...rec,
      status,
      decidedBy,
      decidedAt: now,
    };
    this.recommendations.set(id, updated);

    if (this.db) {
      this.db
        .getDb()
        .prepare(
          `UPDATE hiring_recommendations
           SET status = ?, decided_by = ?, decided_at = ?
           WHERE id = ?`
        )
        .run(status, decidedBy, now, id);
    }

    return updated;
  }

  /**
   * Map a raw DB row to a HiringRecommendation domain object.
   */
  private static _rowToRecommendation(
    row: HiringRecommendationRow
  ): HiringRecommendation {
    return {
      id: row.id,
      teamId: row.team_id,
      requestedRole: row.requested_role as AgentRole,
      requestedSeniority: row.requested_seniority as SeniorityLevel,
      requestedSkills: row.requested_skills
        ? JSON.parse(row.requested_skills)
        : [],
      justification: row.justification ?? "",
      status: row.status as HiringStatus,
      requestedBy: row.requested_by ?? "",
      decidedBy: row.decided_by ?? undefined,
      createdAt: row.created_at,
      decidedAt: row.decided_at ?? undefined,
    };
  }
}
