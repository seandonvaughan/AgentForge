import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter, ApprovalRow } from '@agentforge/db';
import { generateId, nowIso } from '@agentforge/shared';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import Sqlite from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Monorepo root: packages/server/src/routes/v5/ -> up 5 levels
const DEFAULT_PROJECT_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

export interface ApprovalsOptions {
  /**
   * WorkspaceAdapter to use for persistence. When provided, approvals are
   * stored in the workspace DB (WORKSPACE_DDL schema). This is the preferred
   * production path.
   */
  adapter?: WorkspaceAdapter;
  /**
   * Fallback: project root containing the .agentforge/ directory. Used when no
   * adapter is provided (e.g. the no-adapter server boot path). Defaults to
   * monorepo root.
   */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Internal row → ApprovalItem conversion (shared by both persistence paths)
// ---------------------------------------------------------------------------

function rowToItem(row: ApprovalRow): ApprovalItem {
  const item: ApprovalItem = {
    id: row.id,
    proposalId: row.proposal_id,
    proposalTitle: row.proposal_title,
    executionId: row.execution_id,
    status: row.status as ApprovalItem['status'],
    impactSummary: row.impact_summary,
    submittedAt: row.submitted_at,
  };
  if (row.diff !== null) item.diff = row.diff;
  if (row.test_summary_json !== null) {
    try { item.testSummary = JSON.parse(row.test_summary_json) as NonNullable<ApprovalItem['testSummary']>; } catch { /* malformed JSON — omit field */ }
  }
  if (row.reviewed_at !== null) item.reviewedAt = row.reviewed_at;
  if (row.reviewed_by !== null) item.reviewedBy = row.reviewed_by;
  if (row.notes !== null) item.notes = row.notes;
  return item;
}

// ---------------------------------------------------------------------------
// Standalone DB helpers (no-adapter fallback path only)
// ---------------------------------------------------------------------------

function openApprovalsDb(projectRoot: string): Sqlite.Database {
  const agentforgeDir = join(projectRoot, '.agentforge');
  if (!existsSync(agentforgeDir)) {
    mkdirSync(agentforgeDir, { recursive: true });
  }
  const db = new Sqlite(join(agentforgeDir, 'audit.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Idempotent schema — safe to run on every startup
  db.prepare(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      proposal_title TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      diff TEXT,
      test_summary_json TEXT,
      impact_summary TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      notes TEXT
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_approvals_submitted ON approvals(submitted_at)`).run();

  return db;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function approvalsRoutes(
  app: FastifyInstance,
  opts: ApprovalsOptions = {},
): Promise<void> {
  const { adapter } = opts;

  // --- Adapter path (workspace DB) ---
  if (adapter) {
    registerAdapterRoutes(app, adapter);
    return;
  }

  // --- Standalone path (audit.db fallback for no-adapter server boot) ---
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const db = openApprovalsDb(projectRoot);

  app.addHook('onClose', async () => {
    db.close();
  });

  registerStandaloneRoutes(app, db);
}

// ---------------------------------------------------------------------------
// Adapter-backed routes (uses WorkspaceAdapter — workspace DB)
// ---------------------------------------------------------------------------

function registerAdapterRoutes(app: FastifyInstance, adapter: WorkspaceAdapter): void {
  // GET /api/v5/approvals
  app.get('/api/v5/approvals', async (req, reply) => {
    const { status } = req.query as { status?: string };
    const allRows = adapter.listApprovals();
    const items = allRows.map(rowToItem);
    const filtered = status ? items.filter(i => i.status === status) : items;
    return reply.send({
      data: filtered,
      meta: {
        total: filtered.length,
        pending: items.filter(i => i.status === 'pending').length,
        timestamp: nowIso(),
      },
    });
  });

  // GET /api/v5/approvals/:id
  app.get<{ Params: { id: string } }>('/api/v5/approvals/:id', async (req, reply) => {
    const row = adapter.getApproval(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ data: rowToItem(row) });
  });

  // POST /api/v5/approvals
  app.post('/api/v5/approvals', async (req, reply) => {
    const { proposalId, proposalTitle, executionId, diff, testSummary, impactSummary } =
      req.body as {
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

    const row = adapter.createApproval({
      id: generateId(),
      proposalId,
      proposalTitle: proposalTitle ?? 'Untitled',
      executionId,
      diff: diff ?? null,
      testSummaryJson: testSummary !== undefined ? JSON.stringify(testSummary) : null,
      impactSummary: impactSummary ?? 'No impact summary provided.',
    });

    return reply.status(201).send({ data: rowToItem(row) });
  });

  // PATCH /api/v5/approvals/:id/approve
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/approve', async (req, reply) => {
    const row = adapter.getApproval(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'pending') {
      return reply.status(409).send({ error: `Cannot approve — current status: ${row.status}` });
    }
    const { reviewedBy, notes } = (req.body ?? {}) as { reviewedBy?: string; notes?: string };
    const approveUpdates: { reviewedBy: string; notes?: string } = { reviewedBy: reviewedBy ?? 'unknown' };
    if (notes !== undefined) approveUpdates.notes = notes;
    adapter.updateApprovalStatus(req.params.id, 'approved', approveUpdates);
    return reply.send({ data: rowToItem(adapter.getApproval(req.params.id)!) });
  });

  // PATCH /api/v5/approvals/:id/reject
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/reject', async (req, reply) => {
    const row = adapter.getApproval(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'pending') {
      return reply.status(409).send({ error: `Cannot reject — current status: ${row.status}` });
    }
    const { reviewedBy, notes } = (req.body ?? {}) as { reviewedBy?: string; notes?: string };
    const rejectUpdates: { reviewedBy: string; notes?: string } = { reviewedBy: reviewedBy ?? 'unknown' };
    if (notes !== undefined) rejectUpdates.notes = notes;
    adapter.updateApprovalStatus(req.params.id, 'rejected', rejectUpdates);
    return reply.send({ data: rowToItem(adapter.getApproval(req.params.id)!) });
  });

  // PATCH /api/v5/approvals/:id/rollback
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/rollback', async (req, reply) => {
    const row = adapter.getApproval(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'approved') {
      return reply.status(409).send({ error: 'Only approved items can be rolled back' });
    }
    adapter.updateApprovalStatus(req.params.id, 'rolled_back', {});
    return reply.send({ data: rowToItem(adapter.getApproval(req.params.id)!) });
  });
}

// ---------------------------------------------------------------------------
// Standalone-backed routes (direct SQLite — no-adapter fallback)
// ---------------------------------------------------------------------------

function registerStandaloneRoutes(app: FastifyInstance, db: Sqlite.Database): void {
  // GET /api/v5/approvals
  app.get('/api/v5/approvals', async (req, reply) => {
    const { status } = req.query as { status?: string };
    const allRows = db.prepare<[], ApprovalRow>(
      'SELECT * FROM approvals ORDER BY submitted_at DESC',
    ).all();
    const items = allRows.map(rowToItem);
    const filtered = status ? items.filter(i => i.status === status) : items;
    return reply.send({
      data: filtered,
      meta: {
        total: filtered.length,
        pending: items.filter(i => i.status === 'pending').length,
        timestamp: nowIso(),
      },
    });
  });

  // GET /api/v5/approvals/:id
  app.get<{ Params: { id: string } }>('/api/v5/approvals/:id', async (req, reply) => {
    const row = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ data: rowToItem(row) });
  });

  // POST /api/v5/approvals
  app.post('/api/v5/approvals', async (req, reply) => {
    const { proposalId, proposalTitle, executionId, diff, testSummary, impactSummary } =
      req.body as {
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

    const id = generateId();
    const submittedAt = nowIso();

    db.prepare<[string, string, string, string, string | null, string | null, string, string]>(`
      INSERT INTO approvals
        (id, proposal_id, proposal_title, execution_id, diff, test_summary_json, impact_summary, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      proposalId,
      proposalTitle ?? 'Untitled',
      executionId,
      diff ?? null,
      testSummary !== undefined ? JSON.stringify(testSummary) : null,
      impactSummary ?? 'No impact summary provided.',
      submittedAt,
    );

    const row = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(id)!;
    return reply.status(201).send({ data: rowToItem(row) });
  });

  // PATCH /api/v5/approvals/:id/approve
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/approve', async (req, reply) => {
    const row = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'pending') {
      return reply.status(409).send({ error: `Cannot approve — current status: ${row.status}` });
    }

    const { reviewedBy, notes } = (req.body ?? {}) as { reviewedBy?: string; notes?: string };
    db.prepare<[string, string, string | null, string]>(`
      UPDATE approvals
      SET status = 'approved', reviewed_at = ?, reviewed_by = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(nowIso(), reviewedBy ?? 'unknown', notes ?? null, req.params.id);

    const updated = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToItem(updated) });
  });

  // PATCH /api/v5/approvals/:id/reject
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/reject', async (req, reply) => {
    const row = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'pending') {
      return reply.status(409).send({ error: `Cannot reject — current status: ${row.status}` });
    }

    const { reviewedBy, notes } = (req.body ?? {}) as { reviewedBy?: string; notes?: string };
    db.prepare<[string, string, string | null, string]>(`
      UPDATE approvals
      SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(nowIso(), reviewedBy ?? 'unknown', notes ?? null, req.params.id);

    const updated = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToItem(updated) });
  });

  // PATCH /api/v5/approvals/:id/rollback
  app.patch<{ Params: { id: string } }>('/api/v5/approvals/:id/rollback', async (req, reply) => {
    const row = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id);
    if (!row) return reply.status(404).send({ error: 'Not found' });
    if (row.status !== 'approved') {
      return reply.status(409).send({ error: 'Only approved items can be rolled back' });
    }

    db.prepare<[string, string]>(`
      UPDATE approvals SET status = 'rolled_back', reviewed_at = ? WHERE id = ?
    `).run(nowIso(), req.params.id);

    const updated = db.prepare<[string], ApprovalRow>(
      'SELECT * FROM approvals WHERE id = ?',
    ).get(req.params.id)!;
    return reply.send({ data: rowToItem(updated) });
  });
}
