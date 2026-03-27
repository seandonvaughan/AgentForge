import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter, CostRow } from '../../db/index.js';

export interface CostSummary {
  groupKey: string;
  totalUsd: number;
  rowCount: number;
}

function groupCosts(
  rows: CostRow[],
  groupBy: 'agent' | 'model' | 'day',
): CostSummary[] {
  const map = new Map<string, { totalUsd: number; rowCount: number }>();

  for (const row of rows) {
    let key: string;
    if (groupBy === 'agent') {
      key = row.agent_id;
    } else if (groupBy === 'model') {
      key = row.model;
    } else {
      // day: extract YYYY-MM-DD from created_at
      const dateStr = row.created_at;
      key = dateStr && dateStr.length >= 10 ? dateStr.slice(0, 10) : 'unknown';
    }

    const entry = map.get(key) ?? { totalUsd: 0, rowCount: 0 };
    entry.totalUsd += row.cost_usd;
    entry.rowCount += 1;
    map.set(key, entry);
  }

  const summaries: CostSummary[] = [];
  for (const [groupKey, { totalUsd, rowCount }] of map) {
    summaries.push({ groupKey, totalUsd, rowCount });
  }

  // Sort by totalUsd descending
  summaries.sort((a, b) => b.totalUsd - a.totalUsd);
  return summaries;
}

export async function costsRoutes(app: FastifyInstance, opts: { adapter: SqliteAdapter }) {
  const { adapter } = opts;

  // GET /api/v1/costs
  // Query params: agentId?, model?, groupBy? ('agent' | 'model' | 'day', default 'agent')
  // Returns: { data: CostSummary[], meta: { totalUsd } }
  app.get('/api/v1/costs', async (req, reply) => {
    const query = req.query as {
      agentId?: string;
      model?: string;
      groupBy?: string;
    };

    const groupBy = (query.groupBy === 'model' || query.groupBy === 'day')
      ? query.groupBy
      : 'agent';

    // Fetch cost rows — filter by agentId if provided
    let rows: CostRow[];
    if (query.agentId) {
      rows = adapter.getAgentCosts(query.agentId);
    } else {
      // Use raw DB to get all costs
      rows = adapter.getAllCosts();
    }

    // Filter by model if specified
    if (query.model) {
      rows = rows.filter(r => r.model === query.model);
    }

    const data = groupCosts(rows, groupBy as 'agent' | 'model' | 'day');
    const totalUsd = rows.reduce((sum, r) => sum + r.cost_usd, 0);

    return reply.send({
      data,
      meta: { totalUsd },
    });
  });
}
