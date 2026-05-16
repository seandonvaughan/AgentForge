import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';

export async function costsRoutes(
  app: FastifyInstance,
  opts: { adapter: WorkspaceAdapter },
): Promise<void> {
  /** Summary — per-model totals + daily rollups + token breakdown.
   *
   * Fix 5: supports optional `?since=<ISO_date>` query parameter that
   * filters costs to only those recorded on or after that timestamp.
   */
  app.get('/api/v5/costs/summary', async (req, reply) => {
    const q = req.query as { since?: string };

    // Validate since if provided — must be a parseable ISO date string.
    let sinceIso: string | null = null;
    if (q.since !== undefined && q.since.length > 0) {
      const parsed = new Date(q.since);
      if (isNaN(parsed.getTime())) {
        return reply.status(400).send({ error: 'Invalid since parameter: must be an ISO date string' });
      }
      sinceIso = parsed.toISOString();
    }

    const allCosts = opts.adapter.getAllCosts();

    // Fix 5: filter by since if provided.
    const costs = sinceIso !== null
      ? allCosts.filter((c) => (c.created_at ?? '') >= sinceIso!)
      : allCosts;

    const totalCostUsd = costs.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0);

    // Per-model-tier totals
    const byModel: Record<string, { costUsd: number; sessions: number; inputTokens: number; outputTokens: number }> = {};
    for (const c of costs) {
      const key = c.model ?? 'unknown';
      if (!byModel[key]) byModel[key] = { costUsd: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
      byModel[key]!.costUsd += c.cost_usd ?? 0;
      byModel[key]!.sessions += 1;
      byModel[key]!.inputTokens += c.input_tokens ?? 0;
      byModel[key]!.outputTokens += c.output_tokens ?? 0;
    }

    // Daily rollups — group by date prefix of created_at
    const byDay: Record<string, { costUsd: number; sessions: number }> = {};
    for (const c of costs) {
      const day = (c.created_at ?? '').slice(0, 10) || 'unknown';
      if (!byDay[day]) byDay[day] = { costUsd: 0, sessions: 0 };
      byDay[day]!.costUsd += c.cost_usd ?? 0;
      byDay[day]!.sessions += 1;
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
        since: sinceIso,
        timestamp: new Date().toISOString(),
      },
    });
  });
}
