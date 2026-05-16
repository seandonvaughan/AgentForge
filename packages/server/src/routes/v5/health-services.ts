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

// ---------------------------------------------------------------------------
// Latency history buffer — rolling 60-sample buffer per service
// ---------------------------------------------------------------------------

/** Maximum samples to retain per service (one per minute over 1 hour). */
const LATENCY_BUFFER_MAX = 60;

/**
 * In-memory rolling latency buffer keyed by service name.
 * Exported for test inspection and reset.
 */
export const _latencyBuffers = new Map<string, number[]>();

/**
 * Record a latency sample for the given service.
 * Maintains a rolling buffer capped at LATENCY_BUFFER_MAX samples.
 * Exported for testing.
 */
export function recordLatencySample(service: string, latencyMs: number): void {
  if (!_latencyBuffers.has(service)) {
    _latencyBuffers.set(service, []);
  }
  const buf = _latencyBuffers.get(service)!;
  buf.push(latencyMs);
  // Cap at max to prevent unbounded growth
  if (buf.length > LATENCY_BUFFER_MAX) {
    buf.splice(0, buf.length - LATENCY_BUFFER_MAX);
  }
}

/**
 * Get the latency history for a service (copy to avoid mutation).
 * Returns an empty array if no samples recorded yet.
 * Exported for testing.
 */
export function getLatencyHistory(service: string): number[] {
  return [...(_latencyBuffers.get(service) ?? [])];
}

/**
 * Reset all latency buffers (for test isolation).
 * Exported for testing.
 */
export function _resetLatencyBuffers(): void {
  _latencyBuffers.clear();
}

export function registerHealthServicesRoutes(app: FastifyInstance): void {
  /**
   * GET /api/v5/health/services
   * Returns per-service health status including circuit state, success rates,
   * and a rolling latency history (last 60 samples, one per minute).
   */
  app.get('/api/v5/health/services', async (_req, reply) => {
    // Ensure all known services appear in the summary (with empty data if not yet tracked)
    const listed = healthMonitor.listServices();
    const allServices = [...new Set([...KNOWN_SERVICES, ...listed])];

    const services = allServices.map(s => {
      const health = healthMonitor.getHealth(s);
      return {
        ...health,
        latencyHistory: getLatencyHistory(s),
      };
    });

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
