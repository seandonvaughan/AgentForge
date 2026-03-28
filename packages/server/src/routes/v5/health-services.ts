import type { FastifyInstance } from 'fastify';
import { HealthMonitor } from '@agentforge/core';

/** Shared singleton HealthMonitor for the process. */
export const healthMonitor = new HealthMonitor({
  failureRateThreshold: 0.5,
  windowMs: 30_000,
  minCallsBeforeOpen: 5,
});

/**
 * Seed a small set of known service names so they appear even before
 * the first real call. This is a convenience warm-up, not a requirement.
 */
const KNOWN_SERVICES = ['anthropic', 'database', 'embeddings', 'git', 'federation'];

export function registerHealthServicesRoutes(app: FastifyInstance): void {
  /**
   * GET /api/v5/health/services
   * Returns per-service health status including circuit state and success rates.
   */
  app.get('/api/v5/health/services', async (_req, reply) => {
    // Ensure all known services appear in the summary (with empty data if not yet tracked)
    const listed = healthMonitor.listServices();
    const allServices = [...new Set([...KNOWN_SERVICES, ...listed])];

    const services = allServices.map(s => healthMonitor.getHealth(s));
    const degradedCount = services.filter(s => s.circuitOpen).length;
    const overallStatus =
      degradedCount === 0 ? 'healthy' :
      degradedCount < services.length ? 'degraded' :
      'unhealthy';

    return reply.send({
      status: overallStatus,
      healthyCount: services.filter(s => !s.circuitOpen).length,
      degradedCount,
      services,
      timestamp: new Date().toISOString(),
    });
  });
}
