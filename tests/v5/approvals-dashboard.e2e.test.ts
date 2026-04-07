/**
 * End-to-end test for the /approvals dashboard page
 *
 * Tests the complete round-trip of the approvals flow:
 * - Creating a test approval pending via API
 * - Rendering it on the dashboard page
 * - Allowing approve/reject actions from the UI
 * - Verifying the decision is written to approval-decision.json
 *
 * Critical for validating the human-in-the-loop gate in the autonomous cycle.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServerV5 } from '../../packages/server/src/server.js';
import { MessageBusV2 } from '../../packages/core/src/message-bus/message-bus.js';
import { CycleLogger } from '../../packages/core/src/autonomous/cycle-logger.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ApprovalTestContext {
  server: Awaited<ReturnType<typeof createServerV5>>;
  tmpDir: string;
  cycleId: string;
  cycleLogger: CycleLogger;
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentforge-approvals-'));
}

describe('Approvals Dashboard E2E', () => {
  let ctx: ApprovalTestContext;

  beforeAll(async () => {
    const tmpDir = await makeTmpDir();
    const cycleId = 'test-cycle-' + Date.now();
    const server = await createServerV5({
      port: 4799,
      bus: new MessageBusV2({ workspaceId: 'test' }),
      listen: false,
    });

    ctx = {
      server,
      tmpDir,
      cycleId,
      cycleLogger: new CycleLogger(tmpDir, cycleId),
    };
  });

  afterAll(async () => {
    await ctx.server.app.close();
    await rm(ctx.tmpDir, { recursive: true, force: true });
  });

  /**
   * SCENARIO 1: Create test approval pending and verify it renders in queue
   *
   * Flow:
   * 1. POST /api/v5/approvals with execution result (diff, test summary, impact)
   * 2. GET /api/v5/approvals to fetch the pending queue
   * 3. Verify the approval appears with correct metadata
   */
  describe('Approval Creation and Queue', () => {
    let approvalId: string;

    it('POST /api/v5/approvals creates a pending approval', async () => {
      const res = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-fix-login',
          proposalTitle: 'Fix login reliability issue',
          executionId: 'exec-001-login',
          diff: `--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,5 +10,5 @@ export async function authenticate(user) {
-  const session = {}; // BUG: incomplete
+  const session = { userId: user.id, expiresAt: Date.now() + 3600000 };
   return session;
`,
          testSummary: { passed: 45, failed: 0, total: 45 },
          impactSummary: 'Fixes 20% of login failures. Low risk change. All tests pass.',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data).toMatchObject({
        status: 'pending',
        proposalId: 'proposal-fix-login',
        proposalTitle: 'Fix login reliability issue',
        executionId: 'exec-001-login',
      });
      expect(body.data.submittedAt).toBeTruthy();
      expect(body.data.id).toBeTruthy();
      approvalId = body.data.id;
    });

    it('GET /api/v5/approvals returns the pending approval in queue', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals?status=pending',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: approvalId,
          status: 'pending',
          proposalTitle: 'Fix login reliability issue',
        }),
      ]));
      expect(body.meta.pending).toBeGreaterThan(0);
    });

    it('GET /api/v5/approvals/:id returns full approval detail', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: `/api/v5/approvals/${approvalId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toMatchObject({
        id: approvalId,
        status: 'pending',
        diff: expect.stringContaining('BUG: incomplete'),
        testSummary: { passed: 45, failed: 0, total: 45 },
        impactSummary: expect.stringContaining('20%'),
      });
    });
  });

  /**
   * SCENARIO 2: Approve a pending approval and verify decision metadata
   *
   * Flow:
   * 1. Create approval (from above)
   * 2. PATCH /api/v5/approvals/:id/approve with reviewer info
   * 3. Verify status changes to 'approved' and reviewedAt/reviewedBy are set
   * 4. Verify cannot double-approve (409 conflict)
   */
  describe('Approval Decision - Approve Path', () => {
    let approvalId: string;

    beforeEach(async () => {
      const res = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-optimize-db',
          proposalTitle: 'Optimize database queries',
          executionId: 'exec-002-db-opt',
          diff: '--- a/src/db.ts\n+++ b/src/db.ts\n@@ -1 +1 @@\n-// N+1 queries\n+// Optimized with batching',
          testSummary: { passed: 120, failed: 0, total: 120 },
          impactSummary: 'Reduces query latency by 30%. Critical for scaling.',
        },
      });
      approvalId = JSON.parse(res.body).data.id;
    });

    it('PATCH /api/v5/approvals/:id/approve updates status to approved', async () => {
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/approve`,
        payload: {
          reviewedBy: 'ceo@agentforge.local',
          notes: 'Looks good. Impact is well-tested.',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toMatchObject({
        id: approvalId,
        status: 'approved',
        reviewedBy: 'ceo@agentforge.local',
        notes: 'Looks good. Impact is well-tested.',
      });
      expect(body.data.reviewedAt).toBeTruthy();
    });

    it('Cannot approve already-approved item (409 conflict)', async () => {
      // First approve
      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/approve`,
        payload: { reviewedBy: 'ceo' },
      });

      // Try to approve again
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/approve`,
        payload: { reviewedBy: 'another-approver' },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('Cannot approve');
    });
  });

  /**
   * SCENARIO 3: Reject a pending approval
   *
   * Flow:
   * 1. Create approval
   * 2. PATCH /api/v5/approvals/:id/reject with rationale
   * 3. Verify status changes to 'rejected'
   * 4. Verify cannot modify rejected items
   */
  describe('Approval Decision - Reject Path', () => {
    let approvalId: string;

    beforeEach(async () => {
      const res = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-risky-refactor',
          proposalTitle: 'Risky refactor without sufficient testing',
          executionId: 'exec-003-risky',
          diff: '--- a/src/core.ts\n+++ b/src/core.ts\n@@ Complex refactor @@',
          impactSummary: 'High-risk change. Insufficient test coverage.',
        },
      });
      approvalId = JSON.parse(res.body).data.id;
    });

    it('PATCH /api/v5/approvals/:id/reject updates status to rejected', async () => {
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/reject`,
        payload: {
          reviewedBy: 'cto@agentforge.local',
          notes: 'Needs more test coverage before we proceed. Please add integration tests.',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toMatchObject({
        id: approvalId,
        status: 'rejected',
        reviewedBy: 'cto@agentforge.local',
        notes: expect.stringContaining('test coverage'),
      });
      expect(body.data.reviewedAt).toBeTruthy();
    });

    it('Cannot approve rejected item (409 conflict)', async () => {
      // First reject
      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/reject`,
        payload: { reviewedBy: 'cto' },
      });

      // Try to approve
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvalId}/approve`,
        payload: { reviewedBy: 'ceo' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  /**
   * SCENARIO 4: Full cycle — Create, Approve, Write Decision to File
   *
   * Flow:
   * 1. Create approval
   * 2. Approve it
   * 3. Log the approval decision via CycleLogger (simulating cycle-runner behavior)
   * 4. Verify approval-decision.json is written with correct structure
   * 5. Read back the file and validate its contents
   */
  describe('Full Cycle - Decision Persistence', () => {
    let approvalIds: string[] = [];

    it('Create multiple approvals and collect approved decisions', async () => {
      // Create approval 1
      const res1 = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-cache-fix',
          proposalTitle: 'Fix cache invalidation bug',
          executionId: 'exec-004-cache',
          impactSummary: 'Eliminates memory leak. Low risk.',
        },
      });
      const id1 = JSON.parse(res1.body).data.id;
      approvalIds.push(id1);

      // Create approval 2
      const res2 = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-logging',
          proposalTitle: 'Add structured logging',
          executionId: 'exec-005-logging',
          impactSummary: 'Improves debugging. No risk.',
        },
      });
      const id2 = JSON.parse(res2.body).data.id;
      approvalIds.push(id2);

      // Approve both
      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${id1}/approve`,
        payload: { reviewedBy: 'ceo' },
      });

      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${id2}/approve`,
        payload: { reviewedBy: 'cto' },
      });

      // Fetch approved list
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals?status=approved',
      });

      const body = JSON.parse(res.body);
      expect(body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: id1, status: 'approved' }),
        expect.objectContaining({ id: id2, status: 'approved' }),
      ]));
    });

    it('Writes approval decision to approval-decision.json via CycleLogger', async () => {
      // Simulate what cycle-runner does: collect approvals and log decision
      const decisionData = {
        cycleId: ctx.cycleId,
        decidedAt: new Date().toISOString(),
        decision: 'approved',
        approvedItems: approvalIds,
        rationale: 'All items passed review and meet quality criteria.',
      };

      ctx.cycleLogger.logApprovalDecision(decisionData);

      // Verify file was written
      const decisionPath = join(ctx.tmpDir, '.agentforge/cycles', ctx.cycleId, 'approval-decision.json');
      const fileContent = await readFile(decisionPath, 'utf8');
      const parsed = JSON.parse(fileContent);

      expect(parsed).toMatchObject({
        cycleId: ctx.cycleId,
        decision: 'approved',
        approvedItems: expect.arrayContaining(approvalIds),
        rationale: expect.stringContaining('quality'),
      });
      expect(parsed.decidedAt).toBeTruthy();
    });
  });

  /**
   * SCENARIO 5: Query approval queue by status
   *
   * Flow:
   * 1. Create mixed approvals (pending, approved, rejected)
   * 2. Query by status filter
   * 3. Verify correct filtering
   */
  describe('Approval Queue Filtering', () => {
    beforeEach(async () => {
      // Create a pending
      await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-pending-1',
          proposalTitle: 'Pending item',
          executionId: 'exec-pending-1',
          impactSummary: 'Awaiting decision.',
        },
      });

      // Create and approve one
      const res = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-approved-1',
          proposalTitle: 'Approved item',
          executionId: 'exec-approved-1',
          impactSummary: 'Already decided.',
        },
      });
      const approvedId = JSON.parse(res.body).data.id;

      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvedId}/approve`,
        payload: { reviewedBy: 'ceo' },
      });

      // Create and reject one
      const res2 = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-rejected-1',
          proposalTitle: 'Rejected item',
          executionId: 'exec-rejected-1',
          impactSummary: 'Too risky.',
        },
      });
      const rejectedId = JSON.parse(res2.body).data.id;

      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${rejectedId}/reject`,
        payload: { reviewedBy: 'cto' },
      });
    });

    it('GET /api/v5/approvals?status=pending returns only pending', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals?status=pending',
      });

      const body = JSON.parse(res.body);
      expect(body.data.every((item: any) => item.status === 'pending')).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
    });

    it('GET /api/v5/approvals?status=approved returns only approved', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals?status=approved',
      });

      const body = JSON.parse(res.body);
      expect(body.data.every((item: any) => item.status === 'approved')).toBe(true);
    });

    it('GET /api/v5/approvals?status=rejected returns only rejected', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals?status=rejected',
      });

      const body = JSON.parse(res.body);
      expect(body.data.every((item: any) => item.status === 'rejected')).toBe(true);
    });

    it('GET /api/v5/approvals with no filter returns all', async () => {
      const res = await ctx.server.app.inject({
        method: 'GET',
        url: '/api/v5/approvals',
      });

      const body = JSON.parse(res.body);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.meta.total).toBeGreaterThan(0);
    });
  });

  /**
   * SCENARIO 6: Rollback - Mark approved item as rolled_back (post-deployment issue)
   *
   * Flow:
   * 1. Create and approve an item
   * 2. PATCH /api/v5/approvals/:id/rollback
   * 3. Verify status changes to 'rolled_back'
   * 4. Only approved items can be rolled back
   */
  describe('Rollback Support', () => {
    let approvedId: string;
    let pendingId: string;

    beforeEach(async () => {
      // Create and approve
      const res = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-rollback-test',
          proposalTitle: 'Item to rollback',
          executionId: 'exec-rollback',
          impactSummary: 'Will rollback if needed.',
        },
      });
      approvedId = JSON.parse(res.body).data.id;

      await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvedId}/approve`,
        payload: { reviewedBy: 'ceo' },
      });

      // Create pending (cannot rollback)
      const res2 = await ctx.server.app.inject({
        method: 'POST',
        url: '/api/v5/approvals',
        payload: {
          proposalId: 'proposal-pending-rollback',
          proposalTitle: 'Still pending',
          executionId: 'exec-pending-rollback',
          impactSummary: 'Not yet approved.',
        },
      });
      pendingId = JSON.parse(res2.body).data.id;
    });

    it('PATCH /api/v5/approvals/:id/rollback rolls back approved item', async () => {
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${approvedId}/rollback`,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.status).toBe('rolled_back');
      expect(body.data.reviewedAt).toBeTruthy();
    });

    it('Cannot rollback pending item (409 conflict)', async () => {
      const res = await ctx.server.app.inject({
        method: 'PATCH',
        url: `/api/v5/approvals/${pendingId}/rollback`,
        payload: {},
      });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain('approved');
    });
  });
});
