import type { FastifyInstance } from 'fastify';
import { generateId, nowIso } from '@agentforge/shared';

export interface ApprovalItem {
  id: string;
  proposalId: string;
  proposalTitle: string;
  executionId: string;
  status: 'pending' | 'approved' | 'rejected' | 'rolled_back';
  diff?: string;
  testSummary?: { passed: number; failed: number; total: number };
  impactSummary: string;
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  notes?: string;
}

// In-memory store (production: persist to DB)
const approvalQueue = new Map<string, ApprovalItem>();

export async function approvalsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v5/approvals — list approval queue
  app.get('/api/v5/approvals', async (req, reply) => {
    const { status } = req.query as { status?: string };
    const items = [...approvalQueue.values()];
    const filtered = status ? items.filter(i => i.status === status) : items;
    return reply.send({
      data: filtered.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
      meta: {
        total: filtered.length,
        pending: items.filter(i => i.status === 'pending').length,
        timestamp: nowIso(),
      },
    });
  });

  // GET /api/v5/approvals/:id
  app.get<{ Params: { id: string } }>('/api/v5/approvals/:id', async (req, reply) => {
    const item = approvalQueue.get(req.params.id);
    if (!item) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ data: item });
  });

  // POST /api/v5/approvals — submit an execution result for approval
  app.post('/api/v5/approvals', async (req, reply) => {
    const { proposalId, proposalTitle, executionId, diff, testSummary, impactSummary } = req.body as {
      proposalId: string;
      proposalTitle: string;
      executionId: string;
      diff?: string;
      testSummary?: { passed: number; failed: number; total: number };
      impactSummary: string;
    };

    if (!proposalId || !executionId) {
      return reply.status(400).send({ error: 'proposalId and executionId are required' });
    }

    const item: ApprovalItem = {
      id: generateId(),
      proposalId,
      proposalTitle: proposalTitle ?? 'Untitled',
      executionId,
      status: 'pending',
      ...(diff !== undefined && { diff }),
      ...(testSummary !== undefined && { testSummary }),
      impactSummary: impactSummary ?? 'No impact summary provided.',
      submittedAt: nowIso(),
    };

    approvalQueue.set(item.id, item);

    return reply.status(201).send({ data: item });
  });

  // PATCH /api/v5/approvals/:id/approve
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/approve', async (req, reply) => {
    const item = approvalQueue.get(req.params.id);
    if (!item) return reply.status(404).send({ error: 'Not found' });
    if (item.status !== 'pending') return reply.status(409).send({ error: `Cannot approve — current status: ${item.status}` });

    const { reviewedBy, notes } = req.body as { reviewedBy?: string; notes?: string };
    item.status = 'approved';
    item.reviewedAt = nowIso();
    item.reviewedBy = reviewedBy ?? 'unknown';
    if (notes !== undefined) item.notes = notes;

    return reply.send({ data: item });
  });

  // PATCH /api/v5/approvals/:id/reject
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/reject', async (req, reply) => {
    const item = approvalQueue.get(req.params.id);
    if (!item) return reply.status(404).send({ error: 'Not found' });
    if (item.status !== 'pending') return reply.status(409).send({ error: `Cannot reject — current status: ${item.status}` });

    const { reviewedBy, notes } = req.body as { reviewedBy?: string; notes?: string };
    item.status = 'rejected';
    item.reviewedAt = nowIso();
    item.reviewedBy = reviewedBy ?? 'unknown';
    if (notes !== undefined) item.notes = notes;

    return reply.send({ data: item });
  });

  // PATCH /api/v5/approvals/:id/rollback — mark approved item as rolled back
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/rollback', async (req, reply) => {
    const item = approvalQueue.get(req.params.id);
    if (!item) return reply.status(404).send({ error: 'Not found' });
    if (item.status !== 'approved') return reply.status(409).send({ error: 'Only approved items can be rolled back' });

    item.status = 'rolled_back';
    item.reviewedAt = nowIso();

    return reply.send({ data: item });
  });
}
