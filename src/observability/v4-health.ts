/**
 * V4HealthCheck — v4.1 bonus
 *
 * Unified health check that queries all v4 modules.
 */

export interface ModuleHealth {
  module: string;
  healthy: boolean;
  metrics: Record<string, number>;
}

export interface SystemHealth {
  timestamp: string;
  allHealthy: boolean;
  modules: ModuleHealth[];
}

export type HealthProbe = () => ModuleHealth;

export class V4HealthCheck {
  private probes: HealthProbe[] = [];

  registerProbe(probe: HealthProbe): void {
    this.probes.push(probe);
  }

  check(): SystemHealth {
    const modules = this.probes.map((probe) => probe());
    return {
      timestamp: new Date().toISOString(),
      allHealthy: modules.every((m) => m.healthy),
      modules,
    };
  }
}
