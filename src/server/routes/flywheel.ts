import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';

interface FlywheelMetrics {
  sessionCount: number;
  successRate: number;
  totalCostUsd: number;
  avgDurationMs: number;
  modelBreakdown: Record<string, number>;
  recentTrend: 'improving' | 'stable' | 'declining';
}

export async function flywheelRoutes(
  app: FastifyInstance,
  opts: { adapter: SqliteAdapter }
) {
  const { adapter } = opts;

  app.get('/api/v1/flywheel', async (_req, reply) => {
    try {
      const sessions = adapter.listSessions();
      const costs = adapter.getAllCosts();

      const sessionCount = sessions.length;

      // Success rate from sessions
      const successCount = sessions.filter(
        s => s.status === 'completed' || s.status === 'success'
      ).length;
      const successRate = sessionCount > 0 ? successCount / sessionCount : 0;

      // Total cost
      const totalCostUsd = costs.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);

      // Average duration
      const sessionsWithDuration = sessions.filter(
        s => s.started_at && s.completed_at
      );
      const avgDurationMs =
        sessionsWithDuration.length > 0
          ? sessionsWithDuration.reduce((sum, s) => {
              const start = new Date(s.started_at).getTime();
              const end = new Date(s.completed_at!).getTime();
              return sum + (end - start);
            }, 0) / sessionsWithDuration.length
          : 0;

      // Model breakdown (cost by model)
      const modelBreakdown: Record<string, number> = {};
      for (const cost of costs) {
        const model = cost.model ?? 'unknown';
        modelBreakdown[model] = (modelBreakdown[model] ?? 0) + cost.cost_usd;
      }

      // Recent trend: compare last 10 vs prior 10 success rates
      let recentTrend: 'improving' | 'stable' | 'declining' = 'stable';
      if (sessions.length >= 20) {
        const sorted = [...sessions].sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        const recent = sorted.slice(0, 10);
        const prior = sorted.slice(10, 20);

        const recentSuccess =
          recent.filter(
            s => s.status === 'completed' || s.status === 'success'
          ).length / 10;
        const priorSuccess =
          prior.filter(
            s => s.status === 'completed' || s.status === 'success'
          ).length / 10;

        if (recentSuccess > priorSuccess + 0.05) {
          recentTrend = 'improving';
        } else if (recentSuccess < priorSuccess - 0.05) {
          recentTrend = 'declining';
        }
      }

      const metrics: FlywheelMetrics = {
        sessionCount,
        successRate,
        totalCostUsd,
        avgDurationMs,
        modelBreakdown,
        recentTrend,
      };

      return reply.send({
        data: metrics,
        meta: { computedAt: new Date().toISOString() },
      });
    } catch {
      const metrics: FlywheelMetrics = {
        sessionCount: 0,
        successRate: 0,
        totalCostUsd: 0,
        avgDurationMs: 0,
        modelBreakdown: {},
        recentTrend: 'stable',
      };
      return reply.send({
        data: metrics,
        meta: { computedAt: new Date().toISOString() },
      });
    }
  });
}
