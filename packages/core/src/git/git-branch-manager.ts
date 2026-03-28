import { generateId, nowIso } from '@agentforge/shared';
import type { AgentBranch, BranchStatus, MergeQueueItem, BranchReport } from './types.js';

export class GitBranchManager {
  private branches = new Map<string, AgentBranch>();
  private mergeQueue: MergeQueueItem[] = [];
  private readonly dryRun: boolean;

  constructor(dryRun = true) {
    this.dryRun = dryRun;
  }

  /** Create a feature branch for an agent working on a task. */
  createBranch(agentId: string, taskId: string, targetBranch = 'main'): AgentBranch {
    const id = generateId();
    const name = `agent/${agentId}/${taskId}`;
    const branch: AgentBranch = {
      id,
      name,
      agentId,
      taskId,
      targetBranch,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.branches.set(id, branch);
    // In dry-run: just record. In production: exec `git checkout -b <name>`
    return branch;
  }

  /** Submit a branch for review — moves it into the merge queue. */
  submitForReview(branchId: string, priority: MergeQueueItem['priority'] = 'P1'): MergeQueueItem {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    this._updateBranch(branchId, { status: 'review', reviewStatus: 'pending' });

    const item: MergeQueueItem = {
      id: generateId(),
      branchId,
      branchName: branch.name,
      agentId: branch.agentId,
      priority,
      status: 'pending',
      queuedAt: nowIso(),
    };
    this.mergeQueue.push(item);
    return item;
  }

  /** Approve a branch review — moves it to mergeable. */
  approveReview(branchId: string, reviewedBy: string): void {
    this._updateBranch(branchId, { reviewStatus: 'approved', reviewedBy });
    const qi = this.mergeQueue.find(q => q.branchId === branchId);
    if (qi) qi.status = 'pending'; // still in queue, now approved
  }

  /** Merge a branch — removes from queue, marks as merged. */
  mergeBranch(branchId: string): AgentBranch {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    this._updateBranch(branchId, { status: 'merged', mergedAt: nowIso() });

    const qIdx = this.mergeQueue.findIndex(q => q.branchId === branchId);
    if (qIdx >= 0) {
      this.mergeQueue[qIdx]!.status = 'merged';
      this.mergeQueue[qIdx]!.mergedAt = nowIso();
    }
    return this.branches.get(branchId)!;
  }

  /** Mark a branch as having a conflict. */
  markConflict(branchId: string, conflictInfo: string): void {
    this._updateBranch(branchId, { status: 'conflict', conflictInfo });
    const qi = this.mergeQueue.find(q => q.branchId === branchId);
    if (qi) {
      qi.status = 'conflict';
      qi.blockReason = conflictInfo;
    }
  }

  /** Delete a merged branch (in dry-run: just remove from registry). */
  deleteBranch(branchId: string): void {
    this.branches.delete(branchId);
  }

  getBranch(id: string): AgentBranch | undefined {
    return this.branches.get(id);
  }

  getBranchByName(name: string): AgentBranch | undefined {
    for (const b of this.branches.values()) {
      if (b.name === name) return b;
    }
    return undefined;
  }

  listBranches(status?: BranchStatus): AgentBranch[] {
    const all = Array.from(this.branches.values());
    return status ? all.filter(b => b.status === status) : all;
  }

  getMergeQueue(status?: MergeQueueItem['status']): MergeQueueItem[] {
    return status
      ? this.mergeQueue.filter(q => q.status === status)
      : [...this.mergeQueue];
  }

  report(): BranchReport {
    const all = Array.from(this.branches.values());
    const count = (s: BranchStatus) => all.filter(b => b.status === s).length;
    return {
      total: all.length,
      active: count('active'),
      review: count('review'),
      merged: count('merged'),
      conflict: count('conflict'),
      stale: count('stale'),
      mergeQueue: this.mergeQueue.filter(q => q.status === 'pending' || q.status === 'in_progress').length,
      timestamp: nowIso(),
    };
  }

  private _updateBranch(id: string, updates: Partial<AgentBranch>): void {
    const b = this.branches.get(id);
    if (b) this.branches.set(id, { ...b, ...updates, updatedAt: nowIso() });
  }
}
