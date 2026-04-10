/**
 * Tests for the v6.7.4 cycle approval endpoints:
 *   GET  /api/v5/cycles/:id/approval
 *   POST /api/v5/cycles/:id/approve
 *   GET  /api/v5/cycle-sessions  (hasApprovalPending flag)
 *
 * These are the human-in-the-loop safety gates for the autonomous cycle.
 * The backend reads/writes approval-pending.json and approval-decision.json
 * inside .agentforge/cycles/:id/. The dashboard approval modal drives these
 * endpoints to unblock a waiting BudgetApproval.pollDecisionFile loop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cyclesRoutes } from '../cycles.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const CYCLE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Minimal approval-pending.json matching the BudgetApproval.collect() output shape. */
const PENDING_PAYLOAD = {
  cycleId: CYCLE_ID,
  requestedAt: '2026-04-10T10:00:00.000Z',
  budgetUsd: 200,
  newTotalUsd: 175,
  withinBudget: {
    totalCostUsd: 100,
    items: [
      {
        itemId: 'item-1',
        title: 'Fix auth bug',
        rank: 1,
        score: 0.95,
        confidence: 0.9,
        estimatedCostUsd: 50,
        estimatedDurationMinutes: 30,
        rationale: 'High impact, low risk',
        dependencies: [],
        suggestedAssignee: 'frontend-dev',
        suggestedTags: ['bug', 'auth'],
        withinBudget: true,
      },
      {
        itemId: 'item-2',
        title: 'Add unit tests',
        rank: 2,
        score: 0.82,
        confidence: 0.85,
        estimatedCostUsd: 50,
        estimatedDurationMinutes: 45,
        rationale: 'Improves coverage',
        dependencies: ['item-1'],
        suggestedAssignee: 'backend-dev',
        suggestedTags: ['testing'],
        withinBudget: true,
      },
    ],
  },
  overflow: {
    additionalCostUsd: 75,
    items: [
      {
        itemId: 'item-3',
        title: 'Refactor database layer',
        rank: 3,
        score: 0.7,
        confidence: 0.75,
        estimatedCostUsd: 75,
        estimatedDurationMinutes: 90,
        rationale: 'Nice to have',
        dependencies: [],
        suggestedAssignee: 'backend-dev',
        suggestedTags: ['refactor'],
        withinBudget: false,
      },
    ],
  },
  agentSummary: 'Two items within budget, one overflow item.',
};

// ── test setup ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-approval-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writePending(id: string, payload = PENDING_PAYLOAD): string {
  const dir = makeCycleDir(id);
  writeFileSync(join(dir, 'approval-pending.json'), JSON.stringify(payload));
  return dir;
}

function writeDecision(dir: string): void {
  writeFileSync(
    join(dir, 'approval-decision.json'),
    JSON.stringify({ decision: 'approved', decidedAt: new Date().toISOString() }),
  );
}

// ── GET /api/v5/cycles/:id/approval ──────────────────────────────────────────

describe('GET /api/v5/cycles/:id/approval', () => {
  it('returns 400 for an id containing dots (fails SAFE_ID)', async () => {
    // SAFE_ID = /^[a-zA-Z0-9_-]+$/ — dots are not allowed.
    // Fastify captures this as the :id param, then the handler rejects it.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/id.with.dots/approval',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('Invalid') });
  });

  it('returns 404 (No pending approval) when the cycle directory does not exist', async () => {
    // safeJoin constructs the path without checking existence, so the missing
    // cycle dir falls through to the existsSync(pendingFile) check → 404.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'No pending approval' });
  });

  it('returns 404 when cycle dir exists but approval-pending.json is absent', async () => {
    makeCycleDir(CYCLE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('pending') });
  });

  it('returns 409 when approval-decision.json already exists (already decided)', async () => {
    const dir = writePending(CYCLE_ID);
    writeDecision(dir);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('decided') });
  });

  it('returns 200 with the full approval-pending.json payload when awaiting decision', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Top-level shape matches what the dashboard store CycleApproval expects
    expect(body.cycleId).toBe(CYCLE_ID);
    expect(body.budgetUsd).toBe(200);
    expect(body.newTotalUsd).toBe(175);
    expect(body.withinBudget.items).toHaveLength(2);
    expect(body.overflow.items).toHaveLength(1);
    expect(body.agentSummary).toBe('Two items within budget, one overflow item.');
  });

  it('passes through all CycleApprovalItem fields that the modal needs', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    const item = res.json().withinBudget.items[0];
    expect(item).toMatchObject({
      itemId: 'item-1',
      title: 'Fix auth bug',
      rank: 1,
      score: 0.95,
      estimatedCostUsd: 50,
      estimatedDurationMinutes: 30,
      rationale: 'High impact, low risk',
      suggestedAssignee: 'frontend-dev',
      suggestedTags: ['bug', 'auth'],
      withinBudget: true,
    });
  });

  it('includes sprintVersion from sprint-link.json when present', async () => {
    const dir = writePending(CYCLE_ID);
    writeFileSync(
      join(dir, 'sprint-link.json'),
      JSON.stringify({ sprintVersion: '9.4.0', assignedAt: new Date().toISOString() }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sprintVersion).toBe('9.4.0');
  });

  it('omits sprintVersion when sprint-link.json is absent', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sprintVersion).toBeUndefined();
  });
});

// ── POST /api/v5/cycles/:id/approve ──────────────────────────────────────────

describe('POST /api/v5/cycles/:id/approve', () => {
  it('returns 400 for an id containing dots (fails SAFE_ID)', async () => {
    // Mirrors the GET test — SAFE_ID rejects dots before any file system access.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/id.with.dots/approve',
      payload: { approveAll: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('Invalid') });
  });

  it('returns 404 when cycle dir exists but approval-pending.json is absent', async () => {
    makeCycleDir(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when approval-decision.json already exists', async () => {
    const dir = writePending(CYCLE_ID);
    writeDecision(dir);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('decided') });
  });

  it('returns 400 when no items are provided (empty arrays, no approveAll)', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approvedItemIds: [], rejectedItemIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('No items') });
  });

  it('approveAll: true approves all within-budget items and rejects overflow', async () => {
    const dir = writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.decision.approvedItemIds).toEqual(['item-1', 'item-2']);
    expect(body.decision.rejectedItemIds).toEqual(['item-3']);
    expect(body.decision.decision).toBe('approved');

    // approval-decision.json must be written so the runtime loop unblocks
    const decisionPath = join(dir, 'approval-decision.json');
    expect(existsSync(decisionPath)).toBe(true);
    const written = JSON.parse(readFileSync(decisionPath, 'utf8'));
    expect(written.cycleId).toBe(CYCLE_ID);
    expect(written.approvedItemIds).toEqual(['item-1', 'item-2']);
  });

  it('approves specific items and rejects the rest (partial selection)', async () => {
    const dir = writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: {
        approvedItemIds: ['item-1'],
        rejectedItemIds: ['item-2', 'item-3'],
        decidedBy: 'test-operator',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision.approvedItemIds).toEqual(['item-1']);
    expect(body.decision.rejectedItemIds).toEqual(['item-2', 'item-3']);
    expect(body.decision.decidedBy).toBe('test-operator');
    expect(body.decision.decision).toBe('approved');

    // Verify written to disk
    const written = JSON.parse(
      readFileSync(join(dir, 'approval-decision.json'), 'utf8'),
    );
    expect(written.approvedItemIds).toEqual(['item-1']);
  });

  it('sets decision = "rejected" when approvedItemIds is empty but rejectedItemIds has entries', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: {
        approvedItemIds: [],
        rejectedItemIds: ['item-1', 'item-2', 'item-3'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.decision).toBe('rejected');
  });

  it('sets decidedBy to "dashboard" when not supplied', async () => {
    writePending(CYCLE_ID);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    expect(res.json().decision.decidedBy).toBe('dashboard');
  });

  it('records a decidedAt ISO timestamp', async () => {
    writePending(CYCLE_ID);
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    const after = Date.now();
    const decidedAt = new Date(res.json().decision.decidedAt).getTime();
    expect(decidedAt).toBeGreaterThanOrEqual(before);
    expect(decidedAt).toBeLessThanOrEqual(after);
  });

  it('makes the cycle non-pending after approval (GET /approval returns 409)', async () => {
    writePending(CYCLE_ID);
    await app.inject({
      method: 'POST',
      url: `/api/v5/cycles/${CYCLE_ID}/approve`,
      payload: { approveAll: true },
    });
    // Now the decision file exists, so GET should return 409
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/approval`,
    });
    expect(getRes.statusCode).toBe(409);
  });
});

// ── GET /api/v5/cycle-sessions — hasApprovalPending flag ─────────────────────

describe('GET /api/v5/cycle-sessions — hasApprovalPending', () => {
  it('returns hasApprovalPending: false when no approval-pending.json', async () => {
    // Sessions list is populated by the cycleSessions manager which spawns
    // processes — in tests there are no real sessions, so we just verify the
    // endpoint doesn't crash and returns the counts shape.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycle-sessions',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('sessions');
    expect(body).toHaveProperty('counts');
    expect(body.counts).toHaveProperty('approvalPending');
    // No real sessions in test environment → approvalPending = 0
    expect(body.counts.approvalPending).toBe(0);
  });
});
