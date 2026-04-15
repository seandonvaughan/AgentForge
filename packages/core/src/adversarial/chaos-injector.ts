import { generateId, nowIso } from '@agentforge/shared';
import type { ChaosScenario, ChaosType } from './types.js';

export type ChaosResult<T> =
  | { kind: 'pass'; value: T }
  | { kind: 'chaos'; type: ChaosType; error?: Error; delayMs?: number };

/**
 * ChaosInjector — injects failures, latency, and errors to test system resilience.
 */
export class ChaosInjector {
  private scenarios = new Map<string, ChaosScenario>();
  private injectionLog: Array<{ scenarioId: string; component: string; type: ChaosType; timestamp: string }> = [];

  // ── Scenario management ──────────────────────────────────────────────────────

  addScenario(opts: {
    type: ChaosType;
    targetComponent: string;
    probability?: number;
    delayMs?: number;
    errorMessage?: string;
  }): ChaosScenario {
    const scenario: ChaosScenario = {
      id: generateId(),
      type: opts.type,
      targetComponent: opts.targetComponent,
      probability: opts.probability ?? 1.0,
      active: true,
      createdAt: nowIso(),
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    };
    this.scenarios.set(scenario.id, scenario);
    return scenario;
  }

  getScenario(id: string): ChaosScenario | undefined {
    return this.scenarios.get(id);
  }

  listScenarios(component?: string): ChaosScenario[] {
    const all = [...this.scenarios.values()];
    if (component) return all.filter(s => s.targetComponent === component);
    return all;
  }

  activateScenario(id: string): boolean {
    const s = this.scenarios.get(id);
    if (!s) return false;
    this.scenarios.set(id, { ...s, active: true });
    return true;
  }

  deactivateScenario(id: string): boolean {
    const s = this.scenarios.get(id);
    if (!s) return false;
    this.scenarios.set(id, { ...s, active: false });
    return true;
  }

  removeScenario(id: string): boolean {
    return this.scenarios.delete(id);
  }

  clearAll(): void {
    this.scenarios.clear();
    this.injectionLog = [];
  }

  // ── Injection ────────────────────────────────────────────────────────────────

  /**
   * Wrap a function call with chaos injection for a specific component.
   * If an active scenario matches the component and triggers (by probability),
   * chaos is injected instead of calling the function.
   */
  async inject<T>(
    component: string,
    fn: () => Promise<T>,
  ): Promise<ChaosResult<T>> {
    const scenario = this.findActiveScenario(component);

    if (scenario && this.shouldTrigger(scenario)) {
      this.logInjection(scenario);
      return this.applyScenario<T>(scenario);
    }

    try {
      const value = await fn();
      return { kind: 'pass', value };
    } catch (err) {
      return {
        kind: 'chaos',
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  /**
   * Synchronous version of inject for non-async code.
   */
  injectSync<T>(
    component: string,
    fn: () => T,
  ): ChaosResult<T> {
    const scenario = this.findActiveScenario(component);

    if (scenario && this.shouldTrigger(scenario)) {
      this.logInjection(scenario);
      if (scenario.type === 'error' || scenario.type === 'unavailable') {
        return {
          kind: 'chaos',
          type: scenario.type,
          error: new Error(scenario.errorMessage ?? `Chaos: ${scenario.type}`),
        };
      }
      return { kind: 'chaos', type: scenario.type };
    }

    try {
      return { kind: 'pass', value: fn() };
    } catch (err) {
      return {
        kind: 'chaos',
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  getInjectionLog(): typeof this.injectionLog {
    return [...this.injectionLog];
  }

  injectionCount(): number {
    return this.injectionLog.length;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private findActiveScenario(component: string): ChaosScenario | undefined {
    return [...this.scenarios.values()].find(
      s => s.active && (s.targetComponent === component || s.targetComponent === '*'),
    );
  }

  private shouldTrigger(scenario: ChaosScenario): boolean {
    return Math.random() < scenario.probability;
  }

  private logInjection(scenario: ChaosScenario): void {
    this.injectionLog.push({
      scenarioId: scenario.id,
      component: scenario.targetComponent,
      type: scenario.type,
      timestamp: nowIso(),
    });
  }

  private async applyScenario<T>(scenario: ChaosScenario): Promise<ChaosResult<T>> {
    switch (scenario.type) {
      case 'latency': {
        const delay = scenario.delayMs ?? 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        return { kind: 'chaos', type: 'latency', delayMs: delay };
      }

      case 'timeout': {
        await new Promise(resolve => setTimeout(resolve, 30_000));
        return { kind: 'chaos', type: 'timeout' };
      }

      case 'error':
      case 'unavailable': {
        return {
          kind: 'chaos',
          type: scenario.type,
          error: new Error(scenario.errorMessage ?? `Chaos: ${scenario.type} injected`),
        };
      }

      case 'partial': {
        return { kind: 'chaos', type: 'partial' };
      }

      default:
        return { kind: 'chaos', type: scenario.type };
    }
  }
}
