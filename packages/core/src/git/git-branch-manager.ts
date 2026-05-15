import { generateId, nowIso } from '@agentforge/shared';
import type { WorkspaceAdapter, GitBranchRow, GitMergeQueueRow } from '@agentforge/db';
import type { AgentBranch, BranchStatus, MergeQueueItem, BranchReport } from './types.js';

export class GitBranchManager {
  // In-memory state — used only when no adapter is provided (dry-run / tests).
  private branches = new Map<string, AgentBranch>();
  private mergeQueue: MergeQueueItem[] = [];
  private readonly dryRun: boolean;
  // exactOptionalPropertyTypes requires the explicit union rather than `?:`
  private readonly adapter: WorkspaceAdapter | undefined;

  constructor(dryRun = true, adapter?: WorkspaceAdapter) {
    this.dryRun = dryRun;
    this.adapter = adapter;
  }

  /** Create a feature branch for an agent working on a task. */
  createBranch(agentId: string, taskId: string, targetBranch = 'main'): AgentBranch {
    const id = generateId();
    const name = `agent/${agentId}/${taskId}`;
    const now = nowIso();
    const branch: AgentBranch = {
      id,
      name,
      agentId,
      taskId,
      targetBranch,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    if (this.adapter) {
      this.adapter.insertGitBranch({
        id,
        name,
        agentId,
        taskId,
        targetBranch,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
    } else {
      this.branches.set(id, branch);
    }
    // In dry-run: just record. In production: exec `git checkout -b <name>`
    return branch;
  }

  /** Submit a branch for review — moves it into the merge queue. */
  submitForReview(branchId: string, priority: MergeQueueItem['priority'] = 'P1'): MergeQueueItem {
    if (this.adapter) {
      const row = this.adapter.getGitBranch(branchId);
      if (!row) throw new Error(`Branch ${branchId} not found`);
      this.adapter.updateGitBranch(branchId, { status: 'review', review_status: 'pending' });
      const item: MergeQueueItem = {
        id: generateId(),
        branchId,
        branchName: row.name,
        agentId: row.agent_id,
        priority,
        status: 'pending',
        queuedAt: nowIso(),
      };
      this.adapter.insertGitMergeQueueItem(item);
      return item;
    }

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
    if (this.adapter) {
      this.adapter.updateGitBranch(branchId, { review_status: 'approved', reviewed_by: reviewedBy });
      const qi = this.adapter.getGitMergeQueueItemByBranchId(branchId);
      if (qi) this.adapter.updateGitMergeQueueItem(qi.id, { status: 'pending' });
      return;
    }

    this._updateBranch(branchId, { reviewStatus: 'approved', reviewedBy });
    const qi = this.mergeQueue.find(q => q.branchId === branchId);
    if (qi) qi.status = 'pending'; // still in queue, now approved
  }

  /** Merge a branch — removes from queue, marks as merged. */
  mergeBranch(branchId: string): AgentBranch {
    if (this.adapter) {
      const row = this.adapter.getGitBranch(branchId);
      if (!row) throw new Error(`Branch ${branchId} not found`);
      const mergedAt = nowIso();
      this.adapter.updateGitBranch(branchId, { status: 'merged', merged_at: mergedAt });
      const qi = this.adapter.getGitMergeQueueItemByBranchId(branchId);
      if (qi) this.adapter.updateGitMergeQueueItem(qi.id, { status: 'merged', mergedAt });
      return this._rowToAgentBranch(this.adapter.getGitBranch(branchId)!);
    }

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
    if (this.adapter) {
      this.adapter.updateGitBranch(branchId, { status: 'conflict', conflict_info: conflictInfo });
      const qi = this.adapter.getGitMergeQueueItemByBranchId(branchId);
      if (qi) this.adapter.updateGitMergeQueueItem(qi.id, { status: 'conflict', blockReason: conflictInfo });
      return;
    }

    this._updateBranch(branchId, { status: 'conflict', conflictInfo });
    const qi = this.mergeQueue.find(q => q.branchId === branchId);
    if (qi) {
      qi.status = 'conflict';
      qi.blockReason = conflictInfo;
    }
  }

  /** Delete a merged branch (in dry-run: just remove from registry). */
  deleteBranch(branchId: string): void {
    if (this.adapter) {
      this.adapter.deleteGitBranch(branchId);
      return;
    }
    this.branches.delete(branchId);
  }

  getBranch(id: string): AgentBranch | undefined {
    if (this.adapter) {
      const row = this.adapter.getGitBranch(id);
      return row ? this._rowToAgentBranch(row) : undefined;
    }
    return this.branches.get(id);
  }

  getBranchByName(name: string): AgentBranch | undefined {
    if (this.adapter) {
      const row = this.adapter.getGitBranchByName(name);
      return row ? this._rowToAgentBranch(row) : undefined;
    }
    for (const b of this.branches.values()) {
      if (b.name === name) return b;
    }
    return undefined;
  }

  listBranches(status?: BranchStatus): AgentBranch[] {
    if (this.adapter) {
      return this.adapter.listGitBranches(status).map(r => this._rowToAgentBranch(r));
    }
    const all = Array.from(this.branches.values());
    return status ? all.filter(b => b.status === status) : all;
  }

  getMergeQueue(status?: MergeQueueItem['status']): MergeQueueItem[] {
    if (this.adapter) {
      return this.adapter.listGitMergeQueue(status).map(r => this._rowToMergeQueueItem(r));
    }
    return status
      ? this.mergeQueue.filter(q => q.status === status)
      : [...this.mergeQueue];
  }

  report(): BranchReport {
    if (this.adapter) {
      const all = this.adapter.listGitBranches().map(r => this._rowToAgentBranch(r));
      const count = (s: BranchStatus) => all.filter(b => b.status === s).length;
      const queueActive = this.adapter.listGitMergeQueue()
        .filter(q => q.status === 'pending' || q.status === 'in_progress').length;
      return {
        total: all.length,
        active: count('active'),
        review: count('review'),
        merged: count('merged'),
        conflict: count('conflict'),
        stale: count('stale'),
        mergeQueue: queueActive,
        timestamp: nowIso(),
      };
    }

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

  private _rowToAgentBranch(row: GitBranchRow): AgentBranch {
    // Build the required fields first, then conditionally set optional ones
    // to satisfy exactOptionalPropertyTypes (undefined !== absent).
    const branch: AgentBranch = {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      taskId: row.task_id,
      targetBranch: row.target_branch,
      status: row.status as BranchStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.merged_at !== null) branch.mergedAt = row.merged_at;
    if (row.conflict_info !== null) branch.conflictInfo = row.conflict_info;
    if (row.review_status !== null) branch.reviewStatus = row.review_status as NonNullable<AgentBranch['reviewStatus']>;
    if (row.reviewed_by !== null) branch.reviewedBy = row.reviewed_by;
    return branch;
  }

  private _rowToMergeQueueItem(row: GitMergeQueueRow): MergeQueueItem {
    const item: MergeQueueItem = {
      id: row.id,
      branchId: row.branch_id,
      branchName: row.branch_name,
      agentId: row.agent_id,
      priority: row.priority as MergeQueueItem['priority'],
      status: row.status as MergeQueueItem['status'],
      queuedAt: row.queued_at,
    };
    if (row.merged_at !== null) item.mergedAt = row.merged_at;
    if (row.block_reason !== null) item.blockReason = row.block_reason;
    return item;
  }
}
