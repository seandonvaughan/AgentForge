import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import type { SessionRow } from '../../db/index.js';

export interface AgentSummary {
  agentId: string;
  sessionCount: number;
  successCount: number;
  failureCount: number;
  totalCostUsd: number;
  avgDurationMs: number;
}

function buildAgentSummary(agentId: string, sessions: SessionRow[]): AgentSummary {
  const sessionCount = sessions.length;
  const successCount = sessions.filter(s => s.status === 'completed').length;
  const failureCount = sessions.filter(s => s.status === 'failed').length;

  // Cost and duration derived from session fields (no cost table join here)
  let totalDurationMs = 0;
  let durationCount = 0;

  for (const s of sessions) {
    if (s.started_at && s.completed_at) {
      const durationMs = new Date(s.completed_at).getTime() - new Date(s.started_at).getTime();
      if (!isNaN(durationMs) && durationMs >= 0) {
        totalDurationMs += durationMs;
        durationCount++;
      }
    }
  }

  const avgDurationMs = durationCount > 0 ? Math.round(totalDurationMs / durationCount) : 0;

  return {
    agentId,
    sessionCount,
    successCount,
    failureCount,
    totalCostUsd: 0, // populated below from cost rows when adapter supports it
    avgDurationMs,
  };
}

function buildAgentSummaries(sessions: SessionRow[]): AgentSummary[] {
  const byAgent = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const arr = byAgent.get(s.agent_id) ?? [];
    arr.push(s);
    byAgent.set(s.agent_id, arr);
  }

  const summaries: AgentSummary[] = [];
  for (const [agentId, agentSessions] of byAgent) {
    summaries.push(buildAgentSummary(agentId, agentSessions));
  }
  return summaries;
}

export async function agentsRoutes(app: FastifyInstance, opts: { adapter: SqliteAdapter }) {
  const { adapter } = opts;

  // GET /api/v1/agents
  // Returns: { data: AgentSummary[], meta: { total } }
  app.get('/api/v1/agents', async (_req, reply) => {
    const allSessions = adapter.listSessions();
    const summaries = buildAgentSummaries(allSessions);

    // Enrich with cost data
    for (const summary of summaries) {
      const costs = adapter.getAgentCosts(summary.agentId);
      summary.totalCostUsd = costs.reduce((sum, c) => sum + c.cost_usd, 0);
    }

    return reply.send({
      data: summaries,
      meta: { total: summaries.length },
    });
  });

  // GET /api/v1/agents/:id
  // Returns: { data: AgentSummary & { recentSessions: SessionRow[] } }
  // Returns 404 if no sessions found for this agent
  app.get('/api/v1/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    const allSessions = adapter.listSessions({ agentId: id });
    if (allSessions.length === 0) {
      return reply.status(404).send({ error: 'Agent not found', id });
    }

    const summary = buildAgentSummary(id, allSessions);
    const costs = adapter.getAgentCosts(id);
    summary.totalCostUsd = costs.reduce((sum, c) => sum + c.cost_usd, 0);

    const recentSessions = allSessions.slice(0, 50);

    return reply.send({
      data: { ...summary, recentSessions },
    });
  });
}
