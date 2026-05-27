export interface WorktreeHandle {
  /** Unique deterministic key within the pool — `agent-<safe-agent>-<hash>`. */
  id: string;
  /** Absolute path to the worktree's root directory. */
  path: string;
  /** Branch checked out in the worktree (e.g. `autonomous/agent-<safe-agent>-<hash>`). */
  branch: string;
  /** Commit that HEAD pointed to when the worktree was allocated. */
  baselineHead?: string;
  /** Whether release should delete the local branch after removing the worktree. */
  deleteBranchOnRelease?: boolean;
  /** Source ref used when the branch/worktree was created. */
  sourceRef?: string;
  /** ISO timestamp when the worktree was allocated. */
  allocatedAt: string;
  /** The agentId the worktree was allocated for (informational). */
  agentId: string;
  /** Session id (cycle id or any caller-supplied correlation id). */
  sessionId: string;
}

export interface WorktreeAllocateOptions {
  agentId: string;
  sessionId: string;
  /**
   * Explicit branch to check out. Used for gate-retry correction work so the
   * agent fixes the rejected PR branch in place instead of starting from base.
   */
  branchName?: string;
  /** Ref used when creating branchName, for example origin/codex/rejected. */
  sourceRef?: string;
  /**
   * Defaults true for generated agent branches and false for explicit branches.
   * Retry branches should survive release so their PR stays intact.
   */
  deleteBranchOnRelease?: boolean;
}

export interface WorktreePoolStats {
  active: number;
  totalAllocations: number;
  totalReleases: number;
  totalGcd: number;
}
