import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServerV5 } from '../../packages/server/src/server.js';
import { MessageBusV2 } from '../../packages/core/src/message-bus/message-bus.js';

describe('approvals gateway', () => {
  let server: Awaited<ReturnType<typeof createServerV5>>;

  beforeAll(async () => {
    server = await createServerV5({ port: 4798, bus: new MessageBusV2({ workspaceId: 'test' }), listen: false });
  });

  afterAll(() => server.app.close());

  it('GET /api/v5/approvals returns empty queue', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/approvals' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /api/v5/approvals submits an item', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: {
        proposalId: 'prop-1',
        proposalTitle: 'Fix login reliability',
        executionId: 'exec-1',
        diff: '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-// broken\n+// fixed',
        testSummary: { passed: 10, failed: 0, total: 10 },
        impactSummary: 'Fixes 20% of login failures. Low risk.',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('pending');
    expect(body.data.id).toBeTruthy();
  });

  it('PATCH /api/v5/approvals/:id/approve approves pending item', async () => {
    // Create an item
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: { proposalId: 'prop-2', proposalTitle: 'Optimize queries', executionId: 'exec-2', impactSummary: 'Reduces DB latency 30%.' },
    });
    const { id } = JSON.parse(create.body).data;

    const res = await server.app.inject({
      method: 'PATCH',
      url: `/api/v5/approvals/${id}/approve`,
      payload: { reviewedBy: 'ceo' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('approved');
    expect(body.data.reviewedBy).toBe('ceo');
  });

  it('PATCH /api/v5/approvals/:id/reject rejects pending item', async () => {
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: { proposalId: 'prop-3', proposalTitle: 'Risky refactor', executionId: 'exec-3', impactSummary: 'High risk change.' },
    });
    const { id } = JSON.parse(create.body).data;

    const res = await server.app.inject({
      method: 'PATCH',
      url: `/api/v5/approvals/${id}/reject`,
      payload: { reviewedBy: 'cto', notes: 'Too risky without more testing' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('rejected');
    expect(body.data.notes).toContain('risky');
  });

  it('GET /api/v5/approvals/:id/nonexistent returns 404', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/v5/approvals/doesnotexist' });
    expect(res.statusCode).toBe(404);
  });

  it('cannot approve an already-rejected item', async () => {
    const create = await server.app.inject({
      method: 'POST',
      url: '/api/v5/approvals',
      payload: { proposalId: 'prop-4', proposalTitle: 'Already rejected', executionId: 'exec-4', impactSummary: 'Test.' },
    });
    const { id } = JSON.parse(create.body).data;

    await server.app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/reject`, payload: {} });
    const res = await server.app.inject({ method: 'PATCH', url: `/api/v5/approvals/${id}/approve`, payload: {} });
    expect(res.statusCode).toBe(409);
  });
});
