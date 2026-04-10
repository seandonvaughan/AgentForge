import type { FastifyInstance } from 'fastify';
import { SelfProposalEngine, ConfidenceRouter, EscalationProtocol, AdaptiveRouter, EvaluationPipeline } from '@agentforge/core';

// Singletons per server
const proposals = new SelfProposalEngine();
const router = new ConfidenceRouter();
const escalation = new EscalationProtocol();
const adaptive = new AdaptiveRouter();
const evaluation = new EvaluationPipeline(proposals);

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  // --- Proposals ---
  app.get('/api/v5/proposals', async (req, reply) => {
    const { status } = req.query as { status?: string };
    return reply.send({ data: proposals.list(status as any), meta: {} });
  });

  app.post('/api/v5/proposals', async (req, reply) => {
    const { agentId, title, description, tags } = req.body as any;
    const p = proposals.propose({ agentId }, title, description, tags);
    return reply.status(201).send({ data: p });
  });

  app.patch<{ Params: { id: string } }>('/api/v5/proposals/:id/approve', async (req, reply) => {
    const p = proposals.approve(req.params.id);
    return p ? reply.send({ data: p }) : reply.status(404).send({ error: 'Not found' });
  });

  app.patch<{ Params: { id: string } }>('/api/v5/proposals/:id/reject', async (req, reply) => {
    const p = proposals.reject(req.params.id);
    return p ? reply.send({ data: p }) : reply.status(404).send({ error: 'Not found' });
  });

  // POST /api/v5/proposals/from-sessions — auto-generate proposals from session data
  app.post('/api/v5/proposals/from-sessions', async (req, reply) => {
    const { sessions } = req.body as {
      sessions: Array<{
        agentId: string;
        status: string;
        costUsd?: number;
        inputTokens?: number;
        outputTokens?: number;
        task?: string;
      }>;
    };

    if (!Array.isArray(sessions) || sessions.length === 0) {
      return reply.status(400).send({ error: 'sessions array is required and must not be empty' });
    }

    const generated = proposals.fromSessions(sessions);
    return reply.status(201).send({
      data: generated,
      meta: { generated: generated.length, timestamp: new Date().toISOString() },
    });
  });

  // --- Routing ---
  app.post('/api/v5/routing/decide', async (req, reply) => {
    const { agentId, task, minConfidence, defaultModel } = req.body as any;
    const decision = router.route(agentId, task, minConfidence, defaultModel);
    const recommended = adaptive.recommend(agentId, defaultModel ?? 'sonnet');
    return reply.send({ data: { ...decision, adaptiveRecommendation: recommended } });
  });

  app.post('/api/v5/routing/feedback', async (req, reply) => {
    const { agentId, model, outcome, taskComplexity } = req.body as any;
    adaptive.recordOutcome(agentId, model, outcome, taskComplexity);
    return reply.send({ ok: true });
  });

  app.get('/api/v5/routing/performance', async (_req, reply) => {
    return reply.send({ data: adaptive.getPerformance() });
  });

  // --- Escalations ---
  app.get('/api/v5/escalations', async (req, reply) => {
    const { resolved } = req.query as { resolved?: string };
    const r = resolved === undefined ? undefined : resolved === 'true';
    return reply.send({ data: escalation.list(r), meta: escalation.getStats() });
  });

  app.post('/api/v5/escalations', async (req, reply) => {
    const { fromAgentId, task, reason, level } = req.body as any;
    const e = escalation.escalate(fromAgentId, task, reason, level);
    return reply.status(201).send({ data: e });
  });

  app.patch<{ Params: { id: string } }>('/api/v5/escalations/:id/resolve', async (req, reply) => {
    const { resolution } = req.body as { resolution: string };
    const e = escalation.resolve(req.params.id, resolution);
    return e ? reply.send({ data: e }) : reply.status(404).send({ error: 'Not found' });
  });

  // --- Evaluation Pipeline ---
  app.post('/api/v5/evaluation/record', async (req, reply) => {
    const { agentId, status, costUsd, durationMs } = req.body as {
      agentId: string;
      status: string;
      costUsd?: number;
      durationMs?: number;
    };
    evaluation.record({ agentId, status, costUsd: costUsd ?? 0, ...(durationMs !== undefined ? { durationMs } : {}) });
    return reply.send({ ok: true });
  });

  app.post('/api/v5/evaluation/trigger', async (req, reply) => {
    const { workspaceId } = req.body as { workspaceId?: string };
    const result = evaluation.evaluate(workspaceId ?? 'default');
    return reply.send({ data: result });
  });

  app.get('/api/v5/evaluation/metrics', async (_req, reply) => {
    const snapshot = evaluation.collector.snapshot('default');
    const anomalies = evaluation.anomalies();
    return reply.send({ data: { snapshot, anomalies, proposalCount: evaluation.listProposals().length } });
  });
}
