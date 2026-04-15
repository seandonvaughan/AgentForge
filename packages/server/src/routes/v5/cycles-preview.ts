// packages/server/src/routes/v5/cycles-preview.ts
//
// v6.5.3 Agent C — cost preview / dry-run for the autonomous cycle launcher.
//
// POST /api/v5/cycles/preview runs ONLY the PLAN stage (proposal scan +
// scoring agent + backlog build) and returns the projected cost + ranked
// items WITHOUT spawning a full cycle. The preview now uses the same
// WorkspaceAdapter-backed telemetry adapters as the canonical CLI path.
//
// Lives in a separate file from cycles.ts to avoid merge conflicts with
// the parallel v6.5.3-B SSE work on cycles.ts.

import type { FastifyInstance } from 'fastify';
import { getWorkspace } from '@agentforge/core';

interface CyclesPreviewOpts {
  projectRoot: string;
  /**
   * Optional override for the autonomous module loader. Tests inject a
   * fake module so no real `claude -p` calls are made and so the test
   * doesn't depend on the cli build artifacts.
   */
  loadAutonomous?: () => Promise<AutonomousModuleLike>;
}

interface AutonomousModuleLike {
  previewCycle: (options: {
    projectRoot: string;
    budgetUsd?: number;
    maxItems?: number;
  }) => Promise<unknown>;
}

interface PreviewBody {
  budgetUsd?: number;
  maxItems?: number;
  branchPrefix?: string;
  comment?: string;
  dryRun?: boolean;
}

function isValidBody(v: unknown): v is PreviewBody {
  if (v === undefined || v === null) return true; // empty body is OK
  if (typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if ('budgetUsd' in obj && obj.budgetUsd !== undefined) {
    if (typeof obj.budgetUsd !== 'number' || !Number.isFinite(obj.budgetUsd) || obj.budgetUsd < 0) return false;
  }
  if ('maxItems' in obj && obj.maxItems !== undefined) {
    if (typeof obj.maxItems !== 'number' || !Number.isFinite(obj.maxItems) || obj.maxItems < 1) return false;
  }
  if ('branchPrefix' in obj && obj.branchPrefix !== undefined && typeof obj.branchPrefix !== 'string') return false;
  if ('comment' in obj && obj.comment !== undefined && typeof obj.comment !== 'string') return false;
  if ('dryRun' in obj && obj.dryRun !== undefined && typeof obj.dryRun !== 'boolean') return false;
  return true;
}

export async function cyclesPreviewRoutes(
  app: FastifyInstance,
  opts: CyclesPreviewOpts,
): Promise<void> {
  const loadAutonomous: () => Promise<AutonomousModuleLike> =
    opts.loadAutonomous ??
    (async () => {
      // Lazy import to keep server boot cheap and avoid pulling the
      // anthropic SDK on `--help`-style paths.
      const mod = await import('@agentforge/core');
      return mod as unknown as AutonomousModuleLike;
    });

  // POST /api/v5/cycles/preview ────────────────────────────────────────────
  app.post('/api/v5/cycles/preview', async (req, reply) => {
    const startedAt = Date.now();
    const body = (req.body ?? {}) as unknown;

    if (!isValidBody(body)) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    // v6.6.0 — resolve project root from ?workspaceId= query param or
    // x-workspace-id header. Backwards compatible: no param = use the
    // route's launch projectRoot.
    const q = (req.query ?? {}) as { workspaceId?: string };
    const headerVal = (req.headers['x-workspace-id'] ?? '') as string;
    const workspaceId =
      (typeof q.workspaceId === 'string' && q.workspaceId.length > 0
        ? q.workspaceId
        : headerVal.length > 0 ? headerVal : null);
    let projectRoot = opts.projectRoot;
    if (workspaceId) {
      const ws = getWorkspace(workspaceId);
      if (!ws) return reply.status(404).send({ error: 'workspace not found', workspaceId });
      projectRoot = ws.path;
    }

    let result;
    try {
      const mod = await loadAutonomous();
      result = await mod.previewCycle({
        projectRoot,
        ...(typeof (body as PreviewBody).budgetUsd === 'number'
          ? { budgetUsd: (body as PreviewBody).budgetUsd }
          : {}),
        ...(typeof (body as PreviewBody).maxItems === 'number'
          ? { maxItems: (body as PreviewBody).maxItems }
          : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `Preview failed: ${msg}` });
    }

    return reply.send(result);
  });
}
