// packages/server/src/routes/v5/workspaces-active.ts
//
// T4.7 — GET /api/v5/workspaces/active
//
// Returns the currently allocated WorktreeHandles from the singleton
// WorktreePool, each enriched with:
//   - ageSeconds: seconds since allocation
//   - currentItem: best-effort lookup from the cycle's execute.json phase file
//
// The WorktreePool is obtained via a singleton getter so the same pool
// instance is reused across requests (and testable via the exported setter).

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreePool, type WorktreeHandle } from '@agentforge/core';

// ---------------------------------------------------------------------------
// Singleton pool management
// ---------------------------------------------------------------------------

let _pool: WorktreePool | null = null;
let _projectRoot: string = process.cwd();

/** Returns the current singleton pool. Creates a default one on first call. */
export function getPool(): WorktreePool {
  if (!_pool) {
    _pool = new WorktreePool({ projectRoot: _projectRoot });
  }
  return _pool;
}

/** Replace the singleton pool (for tests). */
export function _setPool(pool: WorktreePool | null): void {
  _pool = pool;
}

/** Update the projectRoot used when auto-creating the pool. */
export function _setProjectRoot(root: string): void {
  _projectRoot = root;
}

// ---------------------------------------------------------------------------
// currentItem resolution
// ---------------------------------------------------------------------------

export interface SprintItem {
  id: string;
  title?: string;
  status?: string;
  agentId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface ExecutePhase {
  items?: SprintItem[];
  [key: string]: unknown;
}

/**
 * Attempt to read the execute.json phase file for the most-recent active
 * cycle and find the item being worked on by the given agentId+sessionId.
 *
 * Returns null when:
 *  - no cycles directory exists
 *  - execute.json is missing or unparseable
 *  - no item matches the agentId+sessionId
 */
export function resolveCurrentItem(
  projectRoot: string,
  agentId: string,
  sessionId: string,
): SprintItem | null {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) return null;

  // Walk cycle directories (sorted descending by name so we check newest first)
  let cycleDirs: string[] = [];
  try {
    cycleDirs = readdirSync(cyclesDir);
  } catch {
    return null;
  }

  cycleDirs.sort((a, b) => b.localeCompare(a));

  for (const cycleDir of cycleDirs) {
    const executePath = join(cyclesDir, cycleDir, 'phases', 'execute.json');
    if (!existsSync(executePath)) continue;

    let phase: ExecutePhase;
    try {
      phase = JSON.parse(readFileSync(executePath, 'utf8')) as ExecutePhase;
    } catch {
      continue;
    }

    const items = phase.items ?? [];
    const match = items.find(
      (item) =>
        (item.agentId === agentId || item.sessionId === sessionId),
    );
    if (match) return match;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Active worktree response shape
// ---------------------------------------------------------------------------

export interface ActiveWorktreeEntry {
  id: string;
  agentId: string;
  branch: string;
  path: string;
  allocatedAt: string;
  ageSeconds: number;
  currentItem: SprintItem | null;
}

export interface WorkspacesActiveResponse {
  active: ActiveWorktreeEntry[];
  stats: {
    active: number;
    totalAllocations: number;
    totalReleases: number;
    totalGcd: number;
  };
}

export function buildEntry(
  handle: WorktreeHandle,
  projectRoot: string,
): ActiveWorktreeEntry {
  const allocatedMs = new Date(handle.allocatedAt).getTime();
  const ageSeconds = isNaN(allocatedMs)
    ? 0
    : Math.floor((Date.now() - allocatedMs) / 1000);

  const currentItem = resolveCurrentItem(projectRoot, handle.agentId, handle.sessionId);

  return {
    id: handle.id,
    agentId: handle.agentId,
    branch: handle.branch,
    path: handle.path,
    allocatedAt: handle.allocatedAt,
    ageSeconds,
    currentItem,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export interface WorkspacesActiveRouteOptions {
  projectRoot?: string;
  /** Inject an already-constructed pool (overrides singleton). */
  pool?: WorktreePool;
}

export async function workspacesActiveRoutes(
  app: FastifyInstance,
  opts: WorkspacesActiveRouteOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  // Update the module-level default so the auto-created pool uses the right root.
  _setProjectRoot(projectRoot);
  if (opts.pool) {
    _setPool(opts.pool);
  }

  /** GET /api/v5/workspaces/active — list all live worktrees */
  app.get('/api/v5/workspaces/active', async (_req, reply) => {
    const pool = getPool();

    let handles: WorktreeHandle[] = [];
    try {
      handles = await pool.listActive();
    } catch (err) {
      // If git is not available or repo is not set up, return empty list.
      const msg = err instanceof Error ? err.message : String(err);
      app.log.warn(`[workspaces-active] listActive() failed: ${msg}`);
    }

    const active: ActiveWorktreeEntry[] = handles.map((h) =>
      buildEntry(h, projectRoot),
    );

    const stats = pool.getStats();

    const body: WorkspacesActiveResponse = { active, stats };
    return reply.send(body);
  });
}
