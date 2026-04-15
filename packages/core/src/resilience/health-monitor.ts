import type { ServiceHealth, HealthMonitorConfig, HealthSummary } from './types.js';

interface CallRecord {
  success: boolean;
  at: number; // epoch ms
}

/**
 * HealthMonitor — tracks success/failure rates per named service and
 * auto-opens a circuit when the failure rate exceeds a configurable threshold
 * within a rolling time window.
 *
 * @example
 * const monitor = new HealthMonitor();
 * monitor.record('stripe', true);
 * monitor.record('stripe', false);
 * const health = monitor.getHealth('stripe');
 */
export class HealthMonitor {
  private readonly failureRateThreshold: number;
  private readonly windowMs: number;
  private readonly minCallsBeforeOpen: number;

  private services = new Map<string, {
    calls: CallRecord[];
    circuitOpen: boolean;
    circuitOpenedAt?: string;
    lastFailureAt?: string;
    lastSuccessAt?: string;
    totalCalls: number;
    successCount: number;
    failureCount: number;
  }>();

  constructor(config: HealthMonitorConfig = {}) {
    this.failureRateThreshold = config.failureRateThreshold ?? 0.5;
    this.windowMs = config.windowMs ?? 30_000;
    this.minCallsBeforeOpen = config.minCallsBeforeOpen ?? 5;
  }

  /**
   * Record a call outcome for a service.
   * Automatically evaluates the circuit after recording.
   */
  record(service: string, success: boolean): void {
    if (!this.services.has(service)) {
      this.services.set(service, {
        calls: [],
        circuitOpen: false,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
      });
    }

    const state = this.services.get(service)!;
    const now = Date.now();
    const iso = new Date().toISOString();

    state.calls.push({ success, at: now });
    state.totalCalls++;

    if (success) {
      state.successCount++;
      state.lastSuccessAt = iso;
      // If circuit was open and we see success, try half-open recovery
      if (state.circuitOpen) {
        state.circuitOpen = false;
        delete state.circuitOpenedAt;
      }
    } else {
      state.failureCount++;
      state.lastFailureAt = iso;
    }

    this._pruneWindow(state, now);
    this._evaluateCircuit(service, state, now);
  }

  /** Get health snapshot for a specific service. */
  getHealth(service: string): ServiceHealth {
    const state = this.services.get(service);
    if (!state) {
      return {
        service,
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 1,
        circuitOpen: false,
      };
    }

    const windowCalls = this._windowCalls(state, Date.now());
    const windowSuccess = windowCalls.filter(c => c.success).length;
    const successRate = windowCalls.length > 0
      ? windowSuccess / windowCalls.length
      : 1;

    const h: ServiceHealth = {
      service,
      totalCalls: state.totalCalls,
      successCount: state.successCount,
      failureCount: state.failureCount,
      successRate: Math.round(successRate * 10000) / 10000,
      circuitOpen: state.circuitOpen,
    };
    if (state.lastFailureAt) h.lastFailureAt = state.lastFailureAt;
    if (state.lastSuccessAt) h.lastSuccessAt = state.lastSuccessAt;
    if (state.circuitOpenedAt) h.circuitOpenedAt = state.circuitOpenedAt;
    return h;
  }

  /** List all tracked services. */
  listServices(): string[] {
    return Array.from(this.services.keys());
  }

  /** Get a full summary including all services. */
  summary(): HealthSummary {
    const services = this.listServices().map(s => this.getHealth(s));
    return {
      services,
      healthyCount: services.filter(s => !s.circuitOpen).length,
      degradedCount: services.filter(s => s.circuitOpen).length,
      timestamp: new Date().toISOString(),
    };
  }

  /** Manually close the circuit for a service (operator override). */
  closeCircuit(service: string): void {
    const state = this.services.get(service);
    if (state) {
      state.circuitOpen = false;
      delete state.circuitOpenedAt;
      state.calls = [];
    }
  }

  /** Reset all state for a service. */
  resetService(service: string): void {
    this.services.delete(service);
  }

  /** Reset all state. */
  resetAll(): void {
    this.services.clear();
  }

  private _windowCalls(
    state: { calls: CallRecord[] },
    now: number,
  ): CallRecord[] {
    return state.calls.filter(c => now - c.at <= this.windowMs);
  }

  private _pruneWindow(
    state: { calls: CallRecord[] },
    now: number,
  ): void {
    state.calls = this._windowCalls(state, now);
  }

  private _evaluateCircuit(
    _service: string,
    state: {
      calls: CallRecord[];
      circuitOpen: boolean;
      circuitOpenedAt?: string;
      totalCalls: number;
    },
    now: number,
  ): void {
    if (state.circuitOpen) return; // already open

    const windowCalls = this._windowCalls(state, now);
    if (windowCalls.length < this.minCallsBeforeOpen) return;

    const failures = windowCalls.filter(c => !c.success).length;
    const failureRate = failures / windowCalls.length;

    if (failureRate > this.failureRateThreshold) {
      state.circuitOpen = true;
      state.circuitOpenedAt = new Date().toISOString();
    }
  }
}
