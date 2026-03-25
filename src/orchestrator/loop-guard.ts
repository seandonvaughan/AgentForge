/**
 * Loop Guard for the AgentForge Orchestrator.
 *
 * Tracks iteration counters at key cycle points and prevents
 * infinite loops by enforcing configurable limits.  When a limit
 * is hit the orchestrator should escalate rather than silently
 * continuing.
 */

import type { LoopLimits } from "../types/collaboration.js";

/** Result returned by {@link LoopGuard.increment}. */
export interface LimitCheckResult {
  /** Whether the action is still allowed. */
  allowed: boolean;
  /** Human-readable reason when the action is blocked. */
  reason?: string;
}

/**
 * Default iteration limits applied when no overrides are provided.
 */
const DEFAULT_LIMITS: LoopLimits = {
  review_cycle: 3,
  delegation_depth: 5,
  retry_same_agent: 2,
  total_actions: 50,
};

/**
 * Guards against infinite loops by maintaining per-limit-type
 * counters and refusing further increments once the configured
 * ceiling is reached.
 */
export class LoopGuard {
  private readonly counters: Record<keyof LoopLimits, number>;
  private readonly limits: LoopLimits;

  constructor(limits?: Partial<LoopLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.counters = {
      review_cycle: 0,
      delegation_depth: 0,
      retry_same_agent: 0,
      total_actions: 0,
    };
  }

  /**
   * Increments the counter for the given limit type and checks
   * whether the new value is still within the allowed ceiling.
   *
   * Returns `{ allowed: true }` when the action is permitted,
   * or `{ allowed: false, reason }` when the limit has been
   * exceeded.
   */
  increment(limitType: keyof LoopLimits): LimitCheckResult {
    this.counters[limitType] += 1;

    if (this.counters[limitType] > this.limits[limitType]) {
      return {
        allowed: false,
        reason: `${limitType} limit (${this.limits[limitType]}) exceeded`,
      };
    }

    return { allowed: true };
  }

  /**
   * Resets a specific counter back to zero.
   */
  reset(limitType: keyof LoopLimits): void {
    this.counters[limitType] = 0;
  }

  /**
   * Returns a snapshot of all current counter values.
   *
   * The returned object is a copy; mutating it does not affect
   * the guard's internal state.
   */
  getCounters(): Record<keyof LoopLimits, number> {
    return { ...this.counters };
  }
}
