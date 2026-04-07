// packages/server/src/routes/v5/cycles-preview.ts
//
// v6.5.3 Agent C — cost preview / dry-run for the autonomous cycle launcher.
//
// POST /api/v5/cycles/preview runs ONLY the PLAN stage (proposal scan +
// scoring agent + backlog build) and returns the projected cost + ranked
// items WITHOUT spawning a full cycle. This lets dashboard users see what
// a cycle will cost before committing plan quota to running it.
//
// Lives in a separate file from cycles.ts to avoid merge conflicts with
// the parallel v6.5.3-B SSE work on cycles.ts.

import type { FastifyInstance } from 'fastify';

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
  loadCycleConfig: (cwd: string) => any;
  ProposalToBacklog: new (adapter: any, cwd: string, config: any) => {
    build(): Promise<any[]>;
  };
  ScoringPipeline: new (
    runtime: any,
    adapter: any,
    config: any,
    logger: any,
  ) => {
    scoreWithFallback(backlog: any[]): Promise<any>;
  };
  RuntimeAdapter: new (opts: { cwd: string }) => any;
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

function applyOverrides(config: any, body: PreviewBody): any {
  const next = JSON.parse(JSON.stringify(config));
  if (typeof body.budgetUsd === 'number') {
    next.budget = next.budget ?? {};
    next.budget.perCycleUsd = body.budgetUsd;
  }
  if (typeof body.maxItems === 'number') {
    next.limits = next.limits ?? {};
    next.limits.maxItemsPerSprint = body.maxItems;
  }
  return next;
}

function noopLogger(): any {
  return {
    logScoring: (_r: unknown, _g: unknown) => {},
    logScoringFallback: (_strike: number, _reason: string) => {},
    logKillSwitch: (_t: unknown) => {},
    logCycleResult: (_r: unknown) => {},
    logGitEvent: (_e: unknown) => {},
    logTestRun: (_r: unknown) => {},
    logPREvent: (_e: unknown) => {},
  };
}

function noopProposalAdapter(): any {
  return {
    getRecentFailedSessions: async (_d: number) => [],
    getCostAnomalies: async (_d: number) => [],
    getFailedTaskOutcomes: async (_d: number) => [],
    getFlakingTests: async (_d: number) => [],
  };
}

function noopScoringAdapter(): any {
  return {
    getSprintHistory: async (_l: number) => [],
    getCostMedians: async () => ({}),
    getTeamState: async () => ({ utilization: {} }),
  };
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

    let result;
    try {
      const mod = await loadAutonomous();

      const baseConfig = mod.loadCycleConfig(opts.projectRoot);
      const config = applyOverrides(baseConfig, body as PreviewBody);

      const bridge = new mod.ProposalToBacklog(
        noopProposalAdapter(),
        opts.projectRoot,
        config,
      );
      const backlog = await bridge.build();
      const candidateCount = backlog.length;

      // No backlog → return an explicit empty preview rather than crashing.
      if (candidateCount === 0) {
        return reply.send({
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
        });
      }

      const runtime = new mod.RuntimeAdapter({ cwd: opts.projectRoot });
      const pipeline = new mod.ScoringPipeline(
        runtime,
        noopScoringAdapter(),
        config,
        noopLogger(),
      );

      const scoringStartedAt = Date.now();
      const scored = await pipeline.scoreWithFallback(backlog);
      const scoringDurationMs = Date.now() - scoringStartedAt;
      void scoringDurationMs;

      const rankedItems = [
        ...(scored.withinBudget ?? []),
        ...(scored.requiresApproval ?? []),
      ];

      // Best-effort cost-of-scoring extraction. The current ScoringPipeline
      // doesn't surface its own runtime cost in the result; we approximate
      // by reading totalEstimatedCostUsd separately and exposing 0 for the
      // scoring call cost (the adapter would need to track it). Future
      // work: thread the actual claude -p cost through.
      const scoringCostUsd = typeof scored.scoringCostUsd === 'number' ? scored.scoringCostUsd : 0;

      result = {
        candidateCount,
        rankedItems,
        totalEstimatedCostUsd: Number(scored.totalEstimatedCostUsd ?? 0),
        budgetOverflowUsd: Number(scored.budgetOverflowUsd ?? 0),
        withinBudget: (scored.withinBudget ?? []).length,
        requiresApproval: (scored.requiresApproval ?? []).length,
        summary: String(scored.summary ?? ''),
        warnings: Array.isArray(scored.warnings) ? scored.warnings : [],
        durationMs: Date.now() - startedAt,
        scoringCostUsd,
        fallback: scored.fallback ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `Preview failed: ${msg}` });
    }

    return reply.send(result);
  });
}
