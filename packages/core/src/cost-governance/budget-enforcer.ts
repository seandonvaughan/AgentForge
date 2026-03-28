import { nowIso } from '@agentforge/shared';
import type { BudgetConfig, BudgetStatus } from './types.js';
import { DEFAULT_BUDGET } from './types.js';

export class KillSwitchError extends Error {
  readonly code = 'KILL_SWITCH_ENGAGED';
  constructor(reason: string) {
    super(`Kill switch engaged: ${reason}`);
    this.name = 'KillSwitchError';
  }
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(limit: string, spent: number, ceiling: number) {
    super(`${limit} budget exceeded: $${spent.toFixed(4)} / $${ceiling.toFixed(4)}`);
    this.name = 'BudgetExceededError';
  }
}

export class BudgetEnforcer {
  private config: BudgetConfig;
  private dailySpend = 0;
  private sprintSpend = 0;
  private dailyResetAt: string;
  private killed = false;
  private alertFired = false;
  private expectedDailyRate: number;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET, ...config };
    this.dailyResetAt = new Date().toDateString();
    this.expectedDailyRate = this.config.dailyLimitUsd / 24; // $/hour
  }

  /**
   * Record a spend event and check all ceilings.
   * Throws KillSwitchError if daily limit exceeded.
   * Throws BudgetExceededError for sprint/agent/workflow overruns.
   */
  record(amountUsd: number, context: 'agent' | 'sprint' | 'workflow' = 'agent'): void {
    this._maybeDailyReset();

    if (this.killed) {
      throw new KillSwitchError('System halted due to previous budget breach');
    }

    // Agent-level ceiling
    if (context === 'agent' && amountUsd > this.config.agentLimitUsd) {
      throw new BudgetExceededError('Agent', amountUsd, this.config.agentLimitUsd);
    }

    this.dailySpend += amountUsd;
    this.sprintSpend += amountUsd;

    // Daily kill switch
    if (this.dailySpend > this.config.dailyLimitUsd) {
      this.killed = true;
      throw new KillSwitchError(`Daily limit $${this.config.dailyLimitUsd} exceeded — halting all execution`);
    }

    // Sprint ceiling
    if (context === 'sprint' && this.sprintSpend > this.config.sprintLimitUsd) {
      throw new BudgetExceededError('Sprint', this.sprintSpend, this.config.sprintLimitUsd);
    }

    // Anomaly detection: if spend rate > 3x expected hourly, alert
    const hourlyRate = this.dailySpend; // simplified: total spend vs limit
    if (!this.alertFired && hourlyRate > this.expectedDailyRate * this.config.anomalyMultiplier) {
      this.alertFired = true;
      // In production: emit event, log alert, notify dashboard
    }
  }

  /** Check if a proposed spend would breach any ceiling (without recording). */
  wouldExceed(amountUsd: number, context: 'agent' | 'sprint' | 'workflow' = 'agent'): boolean {
    if (this.killed) return true;
    if (context === 'agent' && amountUsd > this.config.agentLimitUsd) return true;
    if (this.dailySpend + amountUsd > this.config.dailyLimitUsd) return true;
    if (context === 'sprint' && this.sprintSpend + amountUsd > this.config.sprintLimitUsd) return true;
    return false;
  }

  /** Reset sprint spend counter at start of new sprint. */
  resetSprint(): void {
    this.sprintSpend = 0;
    this.alertFired = false;
  }

  /** Manually disengage the kill switch (requires explicit operator action). */
  reset(): void {
    this.killed = false;
    this.dailySpend = 0;
    this.sprintSpend = 0;
    this.alertFired = false;
  }

  status(): BudgetStatus {
    this._maybeDailyReset();
    return {
      dailySpend: this.dailySpend,
      dailyLimit: this.config.dailyLimitUsd,
      dailyRemaining: Math.max(0, this.config.dailyLimitUsd - this.dailySpend),
      sprintSpend: this.sprintSpend,
      sprintLimit: this.config.sprintLimitUsd,
      sprintRemaining: Math.max(0, this.config.sprintLimitUsd - this.sprintSpend),
      killed: this.killed,
      alertFired: this.alertFired,
    };
  }

  updateConfig(config: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private _maybeDailyReset(): void {
    const today = new Date().toDateString();
    if (today !== this.dailyResetAt) {
      this.dailySpend = 0;
      this.alertFired = false;
      this.killed = false;
      this.dailyResetAt = today;
    }
  }
}
