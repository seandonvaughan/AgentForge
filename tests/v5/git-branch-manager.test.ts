import { describe, it, expect, beforeEach } from 'vitest';
import { GitBranchManager } from '../../packages/core/src/git/git-branch-manager.js';
import { AgentPool } from '../../packages/core/src/git/agent-pool.js';

// ── GitBranchManager ──────────────────────────────────────────────────────────

describe('GitBranchManager', () => {
  let mgr: GitBranchManager;

  beforeEach(() => {
    mgr = new GitBranchManager(true); // dry-run
  });

  it('createBranch returns correct name format (agent/<agentId>/<taskId>)', () => {
    const branch = mgr.createBranch('coder', 'task-abc123');
    expect(branch.name).toBe('agent/coder/task-abc123');
  });

  it('createBranch sets agentId and taskId', () => {
    const branch = mgr.createBranch('architect', 'task-xyz');
    expect(branch.agentId).toBe('architect');
    expect(branch.taskId).toBe('task-xyz');
  });

  it('createBranch defaults targetBranch to main', () => {
    const branch = mgr.createBranch('coder', 'task-1');
    expect(branch.targetBranch).toBe('main');
  });

  it('createBranch accepts custom targetBranch', () => {
    const branch = mgr.createBranch('coder', 'task-2', 'develop');
    expect(branch.targetBranch).toBe('develop');
  });

  it('createBranch stores branch with active status', () => {
    const branch = mgr.createBranch('debugger', 'task-debug');
    expect(branch.status).toBe('active');
    expect(mgr.getBranch(branch.id)).toBeDefined();
  });

  it('createBranch stores branch in list', () => {
    const b1 = mgr.createBranch('coder', 'task-1');
    const b2 = mgr.createBranch('linter', 'task-2');
    const all = mgr.listBranches();
    expect(all).toHaveLength(2);
    expect(all.map(b => b.id)).toContain(b1.id);
    expect(all.map(b => b.id)).toContain(b2.id);
  });

  it('createBranch assigns a unique id and ISO timestamps', () => {
    const branch = mgr.createBranch('coder', 'task-ts');
    expect(branch.id).toBeTruthy();
    expect(new Date(branch.createdAt).toISOString()).toBe(branch.createdAt);
    expect(new Date(branch.updatedAt).toISOString()).toBe(branch.updatedAt);
  });

  it('submitForReview moves branch to review status', () => {
    const branch = mgr.createBranch('coder', 'task-r');
    mgr.submitForReview(branch.id);
    expect(mgr.getBranch(branch.id)?.status).toBe('review');
    expect(mgr.getBranch(branch.id)?.reviewStatus).toBe('pending');
  });

  it('submitForReview adds item to merge queue', () => {
    const branch = mgr.createBranch('coder', 'task-q');
    const item = mgr.submitForReview(branch.id, 'P0');
    expect(item.priority).toBe('P0');
    expect(item.branchId).toBe(branch.id);
    expect(item.branchName).toBe(branch.name);
    expect(mgr.getMergeQueue()).toHaveLength(1);
  });

  it('submitForReview throws if branch not found', () => {
    expect(() => mgr.submitForReview('nonexistent-id')).toThrow('Branch nonexistent-id not found');
  });

  it('approveReview sets reviewStatus to approved', () => {
    const branch = mgr.createBranch('coder', 'task-approve');
    mgr.submitForReview(branch.id);
    mgr.approveReview(branch.id, 'lead-reviewer');
    const updated = mgr.getBranch(branch.id);
    expect(updated?.reviewStatus).toBe('approved');
    expect(updated?.reviewedBy).toBe('lead-reviewer');
  });

  it('mergeBranch marks branch merged', () => {
    const branch = mgr.createBranch('coder', 'task-m');
    const merged = mgr.mergeBranch(branch.id);
    expect(merged.status).toBe('merged');
    expect(merged.mergedAt).toBeTruthy();
  });

  it('mergeBranch updates merge queue item status', () => {
    const branch = mgr.createBranch('coder', 'task-mq');
    mgr.submitForReview(branch.id);
    mgr.mergeBranch(branch.id);
    const queueItem = mgr.getMergeQueue()[0];
    expect(queueItem?.status).toBe('merged');
    expect(queueItem?.mergedAt).toBeTruthy();
  });

  it('mergeBranch throws if branch not found', () => {
    expect(() => mgr.mergeBranch('bad-id')).toThrow('Branch bad-id not found');
  });

  it('markConflict marks branch with conflict status and info', () => {
    const branch = mgr.createBranch('coder', 'task-conflict');
    mgr.submitForReview(branch.id);
    mgr.markConflict(branch.id, 'Merge conflict in src/index.ts');
    const updated = mgr.getBranch(branch.id);
    expect(updated?.status).toBe('conflict');
    expect(updated?.conflictInfo).toBe('Merge conflict in src/index.ts');
  });

  it('markConflict updates merge queue item', () => {
    const branch = mgr.createBranch('coder', 'task-cq');
    mgr.submitForReview(branch.id);
    mgr.markConflict(branch.id, 'type mismatch');
    const qi = mgr.getMergeQueue()[0];
    expect(qi?.status).toBe('conflict');
    expect(qi?.blockReason).toBe('type mismatch');
  });

  it('listBranches filters by status correctly', () => {
    const b1 = mgr.createBranch('coder', 'task-f1');
    const b2 = mgr.createBranch('linter', 'task-f2');
    mgr.mergeBranch(b2.id);

    const active = mgr.listBranches('active');
    const merged = mgr.listBranches('merged');

    expect(active.map(b => b.id)).toContain(b1.id);
    expect(active.map(b => b.id)).not.toContain(b2.id);
    expect(merged.map(b => b.id)).toContain(b2.id);
    expect(merged.map(b => b.id)).not.toContain(b1.id);
  });

  it('listBranches returns all when no status filter', () => {
    mgr.createBranch('a1', 't1');
    mgr.createBranch('a2', 't2');
    mgr.createBranch('a3', 't3');
    expect(mgr.listBranches()).toHaveLength(3);
  });

  it('getMergeQueue filters by status correctly', () => {
    const b1 = mgr.createBranch('coder', 'task-qf1');
    const b2 = mgr.createBranch('linter', 'task-qf2');
    mgr.submitForReview(b1.id);
    mgr.submitForReview(b2.id);
    mgr.mergeBranch(b2.id);

    const pending = mgr.getMergeQueue('pending');
    const merged = mgr.getMergeQueue('merged');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.branchId).toBe(b1.id);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.branchId).toBe(b2.id);
  });

  it('getBranchByName finds branch by name', () => {
    const branch = mgr.createBranch('coder', 'task-byname');
    const found = mgr.getBranchByName('agent/coder/task-byname');
    expect(found?.id).toBe(branch.id);
  });

  it('getBranchByName returns undefined for unknown name', () => {
    expect(mgr.getBranchByName('agent/nobody/nothing')).toBeUndefined();
  });

  it('report returns correct counts', () => {
    const b1 = mgr.createBranch('a', 't1'); // active
    const b2 = mgr.createBranch('b', 't2'); // -> review
    const b3 = mgr.createBranch('c', 't3'); // -> merged
    const b4 = mgr.createBranch('d', 't4'); // -> conflict

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
    expect(r.timestamp).toBeTruthy();
  });

  it('report mergeQueue counts only pending and in_progress items', () => {
    const b1 = mgr.createBranch('a', 't1');
    const b2 = mgr.createBranch('b', 't2');
    mgr.submitForReview(b1.id);
    mgr.submitForReview(b2.id);
    mgr.mergeBranch(b2.id); // merged removes from pending count

    const r = mgr.report();
    expect(r.mergeQueue).toBe(1); // only b1 is still pending
  });

  it('deleteBranch removes from registry', () => {
    const branch = mgr.createBranch('coder', 'task-del');
    expect(mgr.getBranch(branch.id)).toBeDefined();
    mgr.deleteBranch(branch.id);
    expect(mgr.getBranch(branch.id)).toBeUndefined();
    expect(mgr.listBranches()).toHaveLength(0);
  });
});

// ── AgentPool ─────────────────────────────────────────────────────────────────

describe('AgentPool', () => {
  it('acquire and release frees slot', async () => {
    const pool = new AgentPool(5);
    const release = await pool.acquire('coder', 'task-1');
    expect(pool.activeCount()).toBe(1);
    release();
    expect(pool.activeCount()).toBe(0);
  });

  it('activeCount tracks correctly across multiple acquires', async () => {
    const pool = new AgentPool(10);
    const r1 = await pool.acquire('a1', 't1');
    const r2 = await pool.acquire('a2', 't2');
    const r3 = await pool.acquire('a3', 't3');
    expect(pool.activeCount()).toBe(3);
    r1();
    expect(pool.activeCount()).toBe(2);
    r2();
    r3();
    expect(pool.activeCount()).toBe(0);
  });

  it('listActive returns all active slots', async () => {
    const pool = new AgentPool(10);
    const r1 = await pool.acquire('coder', 'task-list');
    const r2 = await pool.acquire('linter', 'task-list2');
    const active = pool.listActive();
    expect(active).toHaveLength(2);
    expect(active.map(s => s.agentId)).toContain('coder');
    expect(active.map(s => s.agentId)).toContain('linter');
    r1();
    r2();
  });

  it('queueDepth grows when at ceiling', async () => {
    const pool = new AgentPool(1);
    const r1 = await pool.acquire('agent', 'task-ceil');
    expect(pool.isAtCeiling()).toBe(true);

    // Start second acquire (will queue) — don't await yet
    const p2 = pool.acquire('agent', 'task-ceil2');
    // Allow microtasks to process so the queue registers
    await Promise.resolve();
    expect(pool.queueDepth()).toBe(1);

    r1(); // release to unblock
    const r2 = await p2;
    expect(pool.queueDepth()).toBe(0);
    r2();
  });

  it('isAtCeiling returns true at limit', async () => {
    const pool = new AgentPool(2);
    expect(pool.isAtCeiling()).toBe(false);
    const r1 = await pool.acquire('a', 't1');
    expect(pool.isAtCeiling()).toBe(false);
    const r2 = await pool.acquire('b', 't2');
    expect(pool.isAtCeiling()).toBe(true);
    r1();
    expect(pool.isAtCeiling()).toBe(false);
    r2();
  });

  it('pool with maxConcurrent=1 queues second acquire until first releases', async () => {
    const pool = new AgentPool(1);
    const order: string[] = [];

    const r1 = await pool.acquire('agent', 'first');
    order.push('acquired-1');

    // Second acquire — will queue
    const p2 = pool.acquire('agent', 'second').then(release => {
      order.push('acquired-2');
      return release;
    });

    await Promise.resolve(); // let queue register
    expect(pool.queueDepth()).toBe(1);
    expect(order).toEqual(['acquired-1']); // second not yet acquired

    r1(); // release first
    order.push('released-1');

    const r2 = await p2;
    expect(order).toEqual(['acquired-1', 'released-1', 'acquired-2']);
    expect(pool.activeCount()).toBe(1);
    r2();
    expect(pool.activeCount()).toBe(0);
  });

  it('pool respects maxConcurrent default of 20', () => {
    const pool = new AgentPool();
    expect(pool.maxConcurrent).toBe(20);
  });
});
