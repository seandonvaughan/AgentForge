export interface WorktreeHandle {
  /** Unique within the pool — `agent-<agentId>-<sessionId>`. */
  id: string;
  /** Absolute path to the worktree's root directory. */
  path: string;
  /** Branch checked out in the worktree (e.g. `autonomous/agent-coder-abc123`). */
  branch: string;
  /** ISO timestamp when the worktree was allocated. */
  allocatedAt: string;
  /** The agentId the worktree was allocated for (informational). */
  agentId: string;
  /** Session id (cycle id or any caller-supplied correlation id). */
  sessionId: string;
}

export interface WorktreePoolStats {
  active: number;
  totalAllocations: number;
  totalReleases: number;
  totalGcd: number;
}
