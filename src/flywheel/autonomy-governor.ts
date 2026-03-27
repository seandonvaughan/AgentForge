/**
 * AutonomyGovernor — Sprint 5.2a
 *
 * 4-tier autonomy system with promotion/demotion based on performance.
 * Tiers: 1=Supervised, 2=Assisted, 3=Autonomous, 4=Strategic
 *
 * Promotion: 5 consecutive successes → promote one tier
 * Demotion: 3 consecutive failures → demote one tier
 */

import type { V4MessageBus } from "../communication/v4-message-bus.js";
import type { AgentDatabase } from "../db/database.js";

const PROMOTION_THRESHOLD = 5;
const DEMOTION_THRESHOLD = 3;
const MAX_TIER = 4;
const MIN_TIER = 1;

export interface AgentAutonomyRecord {
  agentId: string;
  tier: number;
  consecutiveSuccesses: number;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface TierChangeResult {
  promoted: boolean;
  demoted: boolean;
  agentId: string;
  previousTier: number;
  newTier: number;
  timestamp: string;
}

export interface AutonomyGovernorOptions {
  bus?: V4MessageBus;
  db?: AgentDatabase; // optional SQLite persistence
}

interface AgentAutonomyRow {
  agent_id: string;
  current_tier: number;
  consecutive_successes: number;
  consecutive_failures: number;
  total_successes: number;
  total_failures: number;
  promoted_at: string | null;
  demoted_at: string | null;
  created_at: string;
  updated_at: string;
}

export class AutonomyGovernor {
  private records = new Map<string, AgentAutonomyRecord>();
  private promotionHistory: TierChangeResult[] = [];
  private readonly bus?: V4MessageBus;
  private readonly db?: AgentDatabase;

  constructor(busOrOptions?: V4MessageBus | AutonomyGovernorOptions) {
    if (!busOrOptions) {
      // No args
    } else if (busOrOptions instanceof Object && 'publish' in busOrOptions) {
      // Legacy: V4MessageBus passed directly
      this.bus = busOrOptions as V4MessageBus;
    } else {
      // New: AutonomyGovernorOptions object
      const opts = busOrOptions as AutonomyGovernorOptions;
      this.bus = opts.bus;
      this.db = opts.db;
    }
  }

  /**
   * Factory: creates a governor and loads all agent records from the DB.
   */
  static loadFromDb(db: AgentDatabase, bus?: V4MessageBus): AutonomyGovernor {
    const gov = new AutonomyGovernor({ bus, db });
    const rows = db.getDb()
      .prepare<[], AgentAutonomyRow>('SELECT * FROM agent_autonomy')
      .all();
    for (const row of rows) {
      gov.records.set(row.agent_id, {
        agentId: row.agent_id,
        tier: row.current_tier,
        consecutiveSuccesses: row.consecutive_successes,
        consecutiveFailures: row.consecutive_failures,
        totalSuccesses: row.total_successes,
        totalFailures: row.total_failures,
      });
    }
    return gov;
  }

  private persistRecord(agentId: string): void {
    if (!this.db) return;
    const r = this.records.get(agentId);
    if (!r) return;
    this.db.getDb().prepare(`
      INSERT INTO agent_autonomy (
        agent_id, current_tier, consecutive_successes, consecutive_failures,
        total_successes, total_failures, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        current_tier = excluded.current_tier,
        consecutive_successes = excluded.consecutive_successes,
        consecutive_failures = excluded.consecutive_failures,
        total_successes = excluded.total_successes,
        total_failures = excluded.total_failures,
        updated_at = excluded.updated_at
    `).run(
      r.agentId,
      r.tier,
      r.consecutiveSuccesses,
      r.consecutiveFailures,
      r.totalSuccesses,
      r.totalFailures,
    );
  }

  private persistRecordWithTimestamp(agentId: string, field: 'promoted_at' | 'demoted_at'): void {
    if (!this.db) return;
    const r = this.records.get(agentId);
    if (!r) return;
    const now = new Date().toISOString();
    this.db.getDb().prepare(`
      INSERT INTO agent_autonomy (
        agent_id, current_tier, consecutive_successes, consecutive_failures,
        total_successes, total_failures, ${field}, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id) DO UPDATE SET
        current_tier = excluded.current_tier,
        consecutive_successes = excluded.consecutive_successes,
        consecutive_failures = excluded.consecutive_failures,
        total_successes = excluded.total_successes,
        total_failures = excluded.total_failures,
        ${field} = excluded.${field},
        updated_at = excluded.updated_at
    `).run(
      r.agentId,
      r.tier,
      r.consecutiveSuccesses,
      r.consecutiveFailures,
      r.totalSuccesses,
      r.totalFailures,
      now,
    );
  }

  register(agentId: string, startingTier: number): void {
    this.records.set(agentId, {
      agentId,
      tier: Math.min(Math.max(startingTier, MIN_TIER), MAX_TIER),
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    });
    this.persistRecord(agentId);
  }

  getTier(agentId: string): number | null {
    return this.records.get(agentId)?.tier ?? null;
  }

  getRecord(agentId: string): AgentAutonomyRecord | null {
    const r = this.records.get(agentId);
    return r ? { ...r } : null;
  }

  recordSuccess(agentId: string): void {
    const r = this.require(agentId);
    r.consecutiveSuccesses++;
    r.consecutiveFailures = 0;
    r.totalSuccesses++;
    this.persistRecord(agentId);
  }

  recordFailure(agentId: string): void {
    const r = this.require(agentId);
    r.consecutiveFailures++;
    r.consecutiveSuccesses = 0;
    r.totalFailures++;
    this.persistRecord(agentId);
  }

  evaluatePromotion(agentId: string): TierChangeResult {
    const r = this.require(agentId);
    const result: TierChangeResult = {
      promoted: false,
      demoted: false,
      agentId,
      previousTier: r.tier,
      newTier: r.tier,
      timestamp: new Date().toISOString(),
    };

    if (r.consecutiveSuccesses >= PROMOTION_THRESHOLD && r.tier < MAX_TIER) {
      r.tier++;
      r.consecutiveSuccesses = 0;
      result.promoted = true;
      result.newTier = r.tier;
      this.promotionHistory.push(result);
      this.persistRecordWithTimestamp(agentId, 'promoted_at');
      if (this.bus) {
        this.bus.publish({
          from: "autonomy-governor",
          to: "broadcast",
          topic: "flywheel.autonomy.promoted",
          category: "status",
          payload: { ...result },
          priority: "normal",
        });
      }
    } else {
      this.persistRecord(agentId);
    }
    return result;
  }

  evaluateDemotion(agentId: string): TierChangeResult {
    const r = this.require(agentId);
    const result: TierChangeResult = {
      promoted: false,
      demoted: false,
      agentId,
      previousTier: r.tier,
      newTier: r.tier,
      timestamp: new Date().toISOString(),
    };

    if (r.consecutiveFailures >= DEMOTION_THRESHOLD && r.tier > MIN_TIER) {
      r.tier--;
      r.consecutiveFailures = 0;
      result.demoted = true;
      result.newTier = r.tier;
      this.promotionHistory.push(result);
      this.persistRecordWithTimestamp(agentId, 'demoted_at');
      if (this.bus) {
        this.bus.publish({
          from: "autonomy-governor",
          to: "broadcast",
          topic: "flywheel.autonomy.demoted",
          category: "status",
          payload: { ...result },
          priority: "normal",
        });
      }
    } else {
      this.persistRecord(agentId);
    }
    return result;
  }

  listByTier(tier: number): AgentAutonomyRecord[] {
    return Array.from(this.records.values())
      .filter((r) => r.tier === tier)
      .map((r) => ({ ...r }));
  }

  getPromotionHistory(): TierChangeResult[] {
    return this.promotionHistory.map((r) => ({ ...r }));
  }

  private require(agentId: string): AgentAutonomyRecord {
    const r = this.records.get(agentId);
    if (!r) throw new Error(`Agent "${agentId}" not registered`);
    return r;
  }
}
