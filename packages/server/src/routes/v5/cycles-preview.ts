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

interface CycleConfig {
  budget: { perCycleUsd: number; perItemUsd?: number };
  limits: { maxItemsPerSprint: number };
  sourcing?: {
    lookbackDays?: number;
    minProposalConfidence?: number;
    includeTodoMarkers?: boolean;
    todoMarkerPattern?: string;
  };
  scoring?: {
    agentId?: string;
    maxRetries?: number;
    fallbackToStatic?: boolean;
  };
}

interface ScoringResult {
  withinBudget: unknown[];
  requiresApproval: unknown[];
  totalEstimatedCostUsd?: number;
  budgetOverflowUsd?: number;
  summary?: string;
  warnings?: string[];
  fallback?: 'static' | 'effort-estimator' | null;
}

interface AutonomousModuleLike {
  loadCycleConfig: (projectRoot: string) => CycleConfig;
  // Use `any` on all constructor parameters AND instance method signatures so
  // concrete types from @agentforge/core satisfy this duck-type interface.
  // TypeScript's contravariance rules block narrower types at both the
  // constructor-param level (e.g. ProposalAdapter vs unknown) and the
  // method-param level (e.g. BacklogItem[] vs unknown[]). Using `any` makes
  // assignment bi-directional at all type positions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ProposalToBacklog: new (...args: any[]) => { build: () => Promise<any[]> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ScoringPipeline: new (...args: any[]) => { scoreWithFallback: (backlog: any[]) => Promise<ScoringResult> };
  RuntimeAdapter: new (opts: { cwd: string }) => unknown;
  createAutonomousTelemetryAdapters?: (projectRoot: string) => {
    proposalAdapter: unknown;
    scoringAdapter: unknown;
    close: () => void;
  };
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

      // Apply any per-request budget / item-count overrides onto the loaded config.
      const config = mod.loadCycleConfig(projectRoot);
      if (typeof (body as PreviewBody).budgetUsd === 'number') {
        config.budget.perCycleUsd = (body as PreviewBody).budgetUsd!;
      }
      if (typeof (body as PreviewBody).maxItems === 'number') {
        config.limits.maxItemsPerSprint = (body as PreviewBody).maxItems!;
      }

      // Telemetry adapters — use module-supplied factory when available so tests
      // can inject lightweight stubs; fall back to no-op adapters otherwise.
      const telemetry = mod.createAutonomousTelemetryAdapters
        ? mod.createAutonomousTelemetryAdapters(projectRoot)
        : { proposalAdapter: {}, scoringAdapter: {}, close: () => {} };

      try {
        const backlog = await new mod.ProposalToBacklog(
          telemetry.proposalAdapter,
          projectRoot,
          config,
        ).build();

        if (backlog.length === 0) {
          result = {
            candidateCount: 0,
            rankedItems: [],
            totalEstimatedCostUsd: 0,
            budgetOverflowUsd: 0,
            withinBudget: 0,
            requiresApproval: 0,
            summary: 'No backlog items found — nothing to score.',
            warnings: ['Empty backlog: no proposals or TODO(autonomous) markers detected.'],
            durationMs: Date.now() - startedAt,
            scoringCostUsd: 0,
            fallback: null,
          };
        } else {
          // Full no-op stub matching the CycleLogger interface. All methods
          // must be present: ScoringPipeline receives this as its logger and
          // TypeScript strict builds will surface missing fields as errors.
          const noopLogger = {
            logPhaseStart: () => {},
            logSprintAssigned: () => {},
            logPhaseResult: () => {},
            logPhaseFailure: () => {},
            logScoring: () => {},
            logScoringFallback: () => {},
            logApprovalPending: () => {},
            logApprovalDecision: () => {},
            logKillSwitch: () => {},
            logCycleResult: () => {},
            logGitEvent: () => {},
            logTestRun: () => {},
            logPREvent: () => {},
          };

          const pipeline = new mod.ScoringPipeline(
            new mod.RuntimeAdapter({ cwd: projectRoot }),
            telemetry.scoringAdapter,
            config,
            noopLogger,
          );

          const scored = await pipeline.scoreWithFallback(backlog);
          const rankedItems = [...(scored.withinBudget ?? []), ...(scored.requiresApproval ?? [])];

          result = {
            candidateCount: backlog.length,
            rankedItems,
            totalEstimatedCostUsd: Number(scored.totalEstimatedCostUsd ?? 0),
            budgetOverflowUsd: Number(scored.budgetOverflowUsd ?? 0),
            withinBudget: (scored.withinBudget ?? []).length,
            requiresApproval: (scored.requiresApproval ?? []).length,
            summary: String(scored.summary ?? ''),
            warnings: Array.isArray(scored.warnings) ? scored.warnings : [],
            durationMs: Date.now() - startedAt,
            scoringCostUsd: 0,
            fallback: scored.fallback ?? null,
          };
        }
      } finally {
        telemetry.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `Preview failed: ${msg}` });
    }

    return reply.send(result);
  });
}
