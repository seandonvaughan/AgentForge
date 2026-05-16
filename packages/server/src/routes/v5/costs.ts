import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';

// ---------------------------------------------------------------------------
// Daily rollup types (exported for tests)
// ---------------------------------------------------------------------------

export interface DailyRollupByModel {
  opus: number;
  sonnet: number;
  haiku: number;
}

export interface DailyRollupItem {
  date: string;
  totalUsd: number;
  byModel: DailyRollupByModel;
  byTag?: Record<string, number>;
}

export interface DailyRollupsResponse {
  data: DailyRollupItem[];
  meta: { days: number; timestamp: string };
}

// ---------------------------------------------------------------------------
// Model tier classifier — maps model string → opus | sonnet | haiku
// ---------------------------------------------------------------------------

function classifyModel(model: string): keyof DailyRollupByModel {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet'; // default — covers sonnet, claude-3, unknown, etc.
}

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

  /**
   * GET /api/v5/costs/daily-rollups
   *
   * Returns daily aggregated cost totals for the last N days (default 30, max 365).
   * Used by the /cost dashboard page for its 30-day sparkline.
   *
   * Query params:
   *   ?days=N   Number of days to look back (default 30, max 365)
   *
   * Response shape:
   *   {
   *     data: Array<{
   *       date: string (YYYY-MM-DD),
   *       totalUsd: number,
   *       byModel: { opus: number, sonnet: number, haiku: number },
   *     }>,
   *     meta: { days: number, timestamp: string }
   *   }
   */
  app.get('/api/v5/costs/daily-rollups', async (req, reply) => {
    const q = req.query as { days?: string };

    // Validate days parameter
    let days = 30;
    if (q.days !== undefined && q.days.length > 0) {
      const parsed = parseInt(q.days, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return reply.status(400).send({ error: 'Invalid days parameter: must be a positive integer' });
      }
      if (parsed > 365) {
        return reply.status(400).send({ error: 'Invalid days parameter: maximum is 365' });
      }
      days = parsed;
    }

    // Compute the cutoff date (N days ago at midnight UTC)
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - days);
    cutoff.setUTCHours(0, 0, 0, 0);
    const cutoffIso = cutoff.toISOString();

    const allCosts = opts.adapter.getAllCosts();

    // Filter to the requested window
    const costs = allCosts.filter((c) => (c.created_at ?? '') >= cutoffIso);

    // Group by date (YYYY-MM-DD prefix of created_at)
    const byDay = new Map<string, DailyRollupItem>();

    for (const c of costs) {
      const date = (c.created_at ?? '').slice(0, 10);
      if (!date || date === '') continue;

      if (!byDay.has(date)) {
        byDay.set(date, {
          date,
          totalUsd: 0,
          byModel: { opus: 0, sonnet: 0, haiku: 0 },
        });
      }

      const entry = byDay.get(date)!;
      const costUsd = c.cost_usd ?? 0;
      entry.totalUsd += costUsd;

      const tier = classifyModel(c.model ?? '');
      entry.byModel[tier] += costUsd;
    }

    // Sort by date ascending and return
    const data = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    const response: DailyRollupsResponse = {
      data,
      meta: {
        days,
        timestamp: new Date().toISOString(),
      },
    };

    return reply.send(response);
  });
}
