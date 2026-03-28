import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';

export async function costsRoutes(
  app: FastifyInstance,
  opts: { adapter: WorkspaceAdapter },
): Promise<void> {
  /** Summary — per-model totals + daily rollups + token breakdown. */
  app.get('/api/v5/costs/summary', async (_req, reply) => {
    const costs = opts.adapter.getAllCosts();
    const totalCostUsd = opts.adapter.getTotalCost();

    // Per-model-tier totals
    const byModel: Record<string, { costUsd: number; sessions: number; inputTokens: number; outputTokens: number }> = {};
    for (const c of costs) {
      const key = c.model ?? 'unknown';
      if (!byModel[key]) byModel[key] = { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
      byModel[key].costUsd += c.cost_usd ?? 0;
      byModel[key].sessions += 1;
      byModel[key].inputTokens += c.input_tokens ?? 0;
      byModel[key].outputTokens += c.output_tokens ?? 0;
    }

    // Daily rollups — group by date prefix of created_at
    const byDay: Record<string, { costUsd: number; sessions: number }> = {};
    for (const c of costs) {
      const day = (c.created_at ?? '').slice(0, 10) || 'unknown';
      if (!byDay[day]) byDay[day] = { costUsd: 0, sessions: 0 };
      byDay[day].costUsd += c.cost_usd ?? 0;
      byDay[day].sessions += 1;
    }

    const dailyRollups = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, ...d }));

    return reply.send({
      data: {
        totalCostUsd,
        totalSessions: costs.length,
        byModel: Object.entries(byModel).map(([model, d]) => ({ model, ...d })),
        dailyRollups,
      },
      meta: {
        workspaceId: opts.adapter.workspaceId,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
