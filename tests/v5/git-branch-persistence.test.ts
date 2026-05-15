/**
 * Tests for GitBranchManager persistence via WorkspaceAdapter (SQLite).
 *
 * Verifies that branch and merge-queue state survives across manager
 * instances — the key behaviour lost when using the in-memory singleton.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';
import { GitBranchManager } from '@agentforge/core';

function makeAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
}

function makeManager(adapter: WorkspaceAdapter): GitBranchManager {
  return new GitBranchManager(true, adapter);
}

// ── Basic CRUD via adapter ────────────────────────────────────────────────────

describe('GitBranchManager (adapter-backed) — basic CRUD', () => {
  let adapter: WorkspaceAdapter;
  let mgr: GitBranchManager;

  beforeEach(() => {
    adapter = makeAdapter();
    mgr = makeManager(adapter);
  });

  it('createBranch persists to SQLite and returns correct shape', () => {
    const branch = mgr.createBranch('coder', 'task-abc123');
    expect(branch.name).toBe('agent/coder/task-abc123');
    expect(branch.agentId).toBe('coder');
    expect(branch.taskId).toBe('task-abc123');
    expect(branch.status).toBe('active');
    expect(branch.targetBranch).toBe('main');
    expect(branch.id).toBeTruthy();
  });

  it('getBranch reads back from SQLite', () => {
    const branch = mgr.createBranch('coder', 'task-get');
    const found = mgr.getBranch(branch.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe(branch.name);
  });

  it('getBranchByName reads back from SQLite', () => {
    const branch = mgr.createBranch('coder', 'task-byname');
    const found = mgr.getBranchByName('agent/coder/task-byname');
    expect(found?.id).toBe(branch.id);
  });

  it('getBranchByName returns undefined for unknown name', () => {
    expect(mgr.getBranchByName('agent/nobody/nothing')).toBeUndefined();
  });

  it('listBranches returns all branches when no status filter', () => {
    mgr.createBranch('a1', 't1');
    mgr.createBranch('a2', 't2');
    mgr.createBranch('a3', 't3');
    expect(mgr.listBranches()).toHaveLength(3);
  });

  it('listBranches filters by status', () => {
    const b1 = mgr.createBranch('coder', 'task-f1');
    const b2 = mgr.createBranch('linter', 'task-f2');
    mgr.mergeBranch(b2.id);

    expect(mgr.listBranches('active').map(b => b.id)).toContain(b1.id);
    expect(mgr.listBranches('merged').map(b => b.id)).toContain(b2.id);
    expect(mgr.listBranches('active').map(b => b.id)).not.toContain(b2.id);
  });

  it('deleteBranch removes branch from SQLite', () => {
    const branch = mgr.createBranch('coder', 'task-del');
    expect(mgr.getBranch(branch.id)).toBeDefined();
    mgr.deleteBranch(branch.id);
    expect(mgr.getBranch(branch.id)).toBeUndefined();
    expect(mgr.listBranches()).toHaveLength(0);
  });
});

// ── Lifecycle transitions ──────────────────────────────────────────────────────

describe('GitBranchManager (adapter-backed) — lifecycle transitions', () => {
  let adapter: WorkspaceAdapter;
  let mgr: GitBranchManager;

  beforeEach(() => {
    adapter = makeAdapter();
    mgr = makeManager(adapter);
  });

  it('submitForReview moves branch to review status and adds queue item', () => {
    const branch = mgr.createBranch('coder', 'task-r');
    mgr.submitForReview(branch.id);
    expect(mgr.getBranch(branch.id)?.status).toBe('review');
    expect(mgr.getBranch(branch.id)?.reviewStatus).toBe('pending');
    expect(mgr.getMergeQueue()).toHaveLength(1);
    expect(mgr.getMergeQueue()[0]!.branchId).toBe(branch.id);
  });

  it('submitForReview throws when branch not found', () => {
    expect(() => mgr.submitForReview('nonexistent-id')).toThrow('Branch nonexistent-id not found');
  });

  it('approveReview updates reviewStatus in SQLite', () => {
    const branch = mgr.createBranch('coder', 'task-approve');
    mgr.submitForReview(branch.id);
    mgr.approveReview(branch.id, 'lead-reviewer');
    const updated = mgr.getBranch(branch.id);
    expect(updated?.reviewStatus).toBe('approved');
    expect(updated?.reviewedBy).toBe('lead-reviewer');
  });

  it('mergeBranch marks branch merged and records mergedAt', () => {
    const branch = mgr.createBranch('coder', 'task-m');
    const merged = mgr.mergeBranch(branch.id);
    expect(merged.status).toBe('merged');
    expect(merged.mergedAt).toBeTruthy();
  });

  it('mergeBranch throws when branch not found', () => {
    expect(() => mgr.mergeBranch('bad-id')).toThrow('Branch bad-id not found');
  });

  it('mergeBranch updates the merge queue item status', () => {
    const branch = mgr.createBranch('coder', 'task-mq');
    mgr.submitForReview(branch.id);
    mgr.mergeBranch(branch.id);
    const queueItem = mgr.getMergeQueue()[0];
    expect(queueItem?.status).toBe('merged');
    expect(queueItem?.mergedAt).toBeTruthy();
  });

  it('markConflict sets conflict status and info in SQLite', () => {
    const branch = mgr.createBranch('coder', 'task-conflict');
    mgr.submitForReview(branch.id);
    mgr.markConflict(branch.id, 'Merge conflict in src/index.ts');
    const updated = mgr.getBranch(branch.id);
    expect(updated?.status).toBe('conflict');
    expect(updated?.conflictInfo).toBe('Merge conflict in src/index.ts');
  });

  it('markConflict updates the merge queue item to conflict', () => {
    const branch = mgr.createBranch('coder', 'task-cq');
    mgr.submitForReview(branch.id);
    mgr.markConflict(branch.id, 'type mismatch');
    const qi = mgr.getMergeQueue()[0];
    expect(qi?.status).toBe('conflict');
    expect(qi?.blockReason).toBe('type mismatch');
  });

  it('getMergeQueue filters by status', () => {
    const b1 = mgr.createBranch('coder', 'task-qf1');
    const b2 = mgr.createBranch('linter', 'task-qf2');
    mgr.submitForReview(b1.id);
    mgr.submitForReview(b2.id);
    mgr.mergeBranch(b2.id);

    expect(mgr.getMergeQueue('pending')).toHaveLength(1);
    expect(mgr.getMergeQueue('pending')[0]!.branchId).toBe(b1.id);
    expect(mgr.getMergeQueue('merged')).toHaveLength(1);
    expect(mgr.getMergeQueue('merged')[0]!.branchId).toBe(b2.id);
  });

  it('report returns correct counts from SQLite', () => {
    const b1 = mgr.createBranch('a', 't1'); // stays active
    const b2 = mgr.createBranch('b', 't2'); // → review
    const b3 = mgr.createBranch('c', 't3'); // → merged
    const b4 = mgr.createBranch('d', 't4'); // → conflict

    mgr.submitForReview(b2.id);
    mgr.submitForReview(b3.id);
    mgr.mergeBranch(b3.id);
    mgr.submitForReview(b4.id);
    mgr.markConflict(b4.id, 'conflict');

    const r = mgr.report();
    expect(r.total).toBe(4);
    expect(r.active).toBe(1);
    expect(r.review).toBe(1);
    expect(r.merged).toBe(1);
    expect(r.conflict).toBe(1);
    expect(r.stale).toBe(0);
    // b2 and b4 are in queue but not pending/in_progress after conflict; b2 is still pending
    expect(r.mergeQueue).toBe(1);
    expect(r.timestamp).toBeTruthy();

    // suppress unused-variable lint for b1
    void b1;
  });
});

// ── Cross-instance persistence ────────────────────────────────────────────────

describe('GitBranchManager (adapter-backed) — cross-instance persistence', () => {
  it('branch state survives creation of a new manager over the same adapter', () => {
    const adapter = makeAdapter();

    // First manager instance — simulate "previous server run"
    const mgr1 = makeManager(adapter);
    const b1 = mgr1.createBranch('coder', 'task-persist-1');
    const b2 = mgr1.createBranch('linter', 'task-persist-2');
    mgr1.submitForReview(b1.id);
    mgr1.mergeBranch(b1.id);

    // Second manager instance over the same adapter — simulate "server restart"
    const mgr2 = makeManager(adapter);
    expect(mgr2.listBranches()).toHaveLength(2);
    expect(mgr2.getBranch(b1.id)?.status).toBe('merged');
    expect(mgr2.getBranch(b2.id)?.status).toBe('active');
    expect(mgr2.getMergeQueue('merged')).toHaveLength(1);
    expect(mgr2.getMergeQueue('merged')[0]!.branchId).toBe(b1.id);
  });

  it('mutations made by one manager instance are visible to another', () => {
    const adapter = makeAdapter();
    const mgr1 = makeManager(adapter);
    const mgr2 = makeManager(adapter);

    const branch = mgr1.createBranch('coder', 'task-shared');
    // mgr2 sees it immediately (same in-process adapter → same SQLite connection)
    expect(mgr2.getBranch(branch.id)?.status).toBe('active');

    mgr2.submitForReview(branch.id);
    expect(mgr1.getBranch(branch.id)?.status).toBe('review');
  });
});

// ── deleteBranch cascades to merge queue ────────────────────────────────────────

describe('GitBranchManager (adapter-backed) — delete cascade', () => {
  it('deleting a branch removes its merge-queue entry via ON DELETE CASCADE', () => {
    const adapter = makeAdapter();
    const mgr = makeManager(adapter);

    const branch = mgr.createBranch('coder', 'task-cascade');
    mgr.submitForReview(branch.id);
    expect(mgr.getMergeQueue()).toHaveLength(1);

    mgr.deleteBranch(branch.id);
    expect(mgr.listBranches()).toHaveLength(0);
    expect(mgr.getMergeQueue()).toHaveLength(0);
  });
});
