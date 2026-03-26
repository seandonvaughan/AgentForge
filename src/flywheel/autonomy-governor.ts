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

export class AutonomyGovernor {
  private records = new Map<string, AgentAutonomyRecord>();
  private promotionHistory: TierChangeResult[] = [];

  constructor(private readonly bus?: V4MessageBus) {}

  register(agentId: string, startingTier: number): void {
    this.records.set(agentId, {
      agentId,
      tier: Math.min(Math.max(startingTier, MIN_TIER), MAX_TIER),
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    });
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
  }

  recordFailure(agentId: string): void {
    const r = this.require(agentId);
    r.consecutiveFailures++;
    r.consecutiveSuccesses = 0;
    r.totalFailures++;
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
