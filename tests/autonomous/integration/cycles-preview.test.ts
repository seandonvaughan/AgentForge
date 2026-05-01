// tests/autonomous/integration/cycles-preview.test.ts
//
// v6.5.3 Agent C — integration tests for POST /api/v5/cycles/preview.
//
// The preview endpoint loads the autonomous module and runs ProposalToBacklog
// + ScoringPipeline.scoreWithFallback() — but never spawns a real cycle and
// never makes a real claude -p call. Tests inject a fake autonomous module
// via the `loadAutonomous` plugin option so we can deterministically exercise
// the success, fallback, and error paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cyclesPreviewRoutes } from '../../../packages/server/src/routes/v5/cycles-preview.js';

let tmpRoot: string;
let app: FastifyInstance;

interface FakeOpts {
  backlog?: any[];
  scoringResult?: any;
  throwAt?: 'load' | 'build' | 'score' | null;
}

function makeFakeAutonomous(opts: FakeOpts = {}) {
  const backlog = opts.backlog ?? [
    { id: 'i1', title: 'Fix crash', description: 'x', priority: 'P0', tags: ['fix'], source: 'failed-session', confidence: 0.9 },
    { id: 'i2', title: 'Add X', description: 'x', priority: 'P1', tags: ['feature'], source: 'todo-marker', confidence: 1.0 },
  ];
  const scoringResult = opts.scoringResult ?? {
    withinBudget: [
      { itemId: 'i1', title: 'Fix crash', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 4, estimatedDurationMinutes: 15, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
      { itemId: 'i2', title: 'Add X', rank: 2, score: 0.8, confidence: 0.85, estimatedCostUsd: 5, estimatedDurationMinutes: 20, rationale: 'r', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['feature'], withinBudget: true },
    ],
    requiresApproval: [],
    totalEstimatedCostUsd: 9,
    budgetOverflowUsd: 0,
    summary: 'Selected 2 items within budget',
    warnings: [],
  };

  const ProposalToBacklog = class {
    constructor(_a: any, _c: any, _config: any) {}
    async build() {
      if (opts.throwAt === 'build') throw new Error('build exploded');
      return backlog;
    }
  };

  const ScoringPipeline = class {
    constructor(_r: any, _a: any, _c: any, _l: any) {}
    async scoreWithFallback(_b: any[]) {
      if (opts.throwAt === 'score') throw new Error('score exploded');
      return scoringResult;
    }
  };

  const RuntimeAdapter = class {
    constructor(_o: any) {}
  };

  const previewCycle = async (previewOpts: { budgetUsd?: number; maxItems?: number }) => {
    const builder = new ProposalToBacklog(null, null, null);
    const candidates = await builder.build();
    const limitedCandidates = typeof previewOpts.maxItems === 'number'
      ? candidates.slice(0, previewOpts.maxItems)
      : candidates;

    if (limitedCandidates.length === 0) {
      return {
        candidateCount: 0,
        rankedItems: [],
        totalEstimatedCostUsd: 0,
        budgetOverflowUsd: 0,
        withinBudget: 0,
        requiresApproval: 0,
        summary: 'No candidate backlog items found',
        warnings: ['No candidate backlog items found'],
        durationMs: 0,
        scoringCostUsd: 0,
        fallback: null,
      };
    }

    const scorer = new ScoringPipeline(null, null, null, null);
    const scored = await scorer.scoreWithFallback(limitedCandidates);
    const rankedItems = [...(scored.withinBudget ?? []), ...(scored.requiresApproval ?? [])];

    return {
      candidateCount: candidates.length,
      rankedItems,
      totalEstimatedCostUsd: scored.totalEstimatedCostUsd ?? 0,
      budgetOverflowUsd: scored.budgetOverflowUsd ?? 0,
      withinBudget: scored.withinBudget?.length ?? 0,
      requiresApproval: scored.requiresApproval?.length ?? 0,
      summary: scored.summary ?? '',
      warnings: scored.warnings ?? [],
      durationMs: 0,
      scoringCostUsd: 0,
      fallback: scored.fallback ?? null,
    };
  };

  const loadCycleConfig = (_cwd: string) => ({
    budget: { perCycleUsd: 25, perItemUsd: 5 },
    limits: { maxItemsPerSprint: 3 },
    sourcing: { lookbackDays: 7, minProposalConfidence: 0.5, includeTodoMarkers: false, todoMarkerPattern: 'TODO' },
    scoring: { agentId: 'backlog-scorer', maxRetries: 3, fallbackToStatic: true },
  });

  const mod: any = {
    loadCycleConfig,
    ProposalToBacklog,
    ScoringPipeline,
    RuntimeAdapter,
    previewCycle,
  };

  return async () => {
    if (opts.throwAt === 'load') throw new Error('load exploded');
    return mod;
  };
}

async function makeApp(loadAutonomous: () => Promise<any>): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await cyclesPreviewRoutes(a, { projectRoot: tmpRoot, loadAutonomous });
  await a.ready();
  return a;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-preview-'));
});

afterEach(async () => {
  if (app) await app.close();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('POST /api/v5/cycles/preview — happy path', () => {
  it('returns the spec shape with ranked items, totals, and counts', async () => {
    app = await makeApp(makeFakeAutonomous());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/preview',
      payload: { budgetUsd: 25, maxItems: 3 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.candidateCount).toBe(2);
    expect(body.rankedItems).toHaveLength(2);
    expect(body.rankedItems[0].itemId).toBe('i1');
    expect(body.totalEstimatedCostUsd).toBe(9);
    expect(body.budgetOverflowUsd).toBe(0);
    expect(body.withinBudget).toBe(2);
    expect(body.requiresApproval).toBe(0);
    expect(typeof body.summary).toBe('string');
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(typeof body.durationMs).toBe('number');
    expect(typeof body.scoringCostUsd).toBe('number');
    expect(body.fallback).toBeNull();
  });

  it('handles empty body (no overrides)', async () => {
    app = await makeApp(makeFakeAutonomous());
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().candidateCount).toBe(2);
  });

  it('returns empty preview when backlog is empty (no crash)', async () => {
    app = await makeApp(makeFakeAutonomous({ backlog: [] }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidateCount).toBe(0);
    expect(body.rankedItems).toEqual([]);
    expect(body.warnings.length).toBeGreaterThan(0);
  });
});

describe('POST /api/v5/cycles/preview — validation', () => {
  it('rejects bad budgetUsd with 400', async () => {
    app = await makeApp(makeFakeAutonomous());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/preview',
      payload: { budgetUsd: -5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects bad maxItems with 400', async () => {
    app = await makeApp(makeFakeAutonomous());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/preview',
      payload: { maxItems: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-number budgetUsd with 400', async () => {
    app = await makeApp(makeFakeAutonomous());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/preview',
      payload: { budgetUsd: 'lots' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/v5/cycles/preview — no side effects', () => {
  it('does NOT create any files or directories under projectRoot', async () => {
    app = await makeApp(makeFakeAutonomous());
    const before = existsSync(tmpRoot) ? readdirSync(tmpRoot) : [];
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(200);
    const after = readdirSync(tmpRoot);
    expect(after).toEqual(before);
    // Specifically: no .agentforge/cycles dir was created
    expect(existsSync(join(tmpRoot, '.agentforge', 'cycles'))).toBe(false);
  });
});

describe('POST /api/v5/cycles/preview — fallback propagation', () => {
  it('propagates fallback="static" when scoring fell back', async () => {
    app = await makeApp(makeFakeAutonomous({
      scoringResult: {
        withinBudget: [
          { itemId: 'i1', title: 'Fix', rank: 1, score: 0.9, confidence: 0.9, estimatedCostUsd: 5, estimatedDurationMinutes: 15, rationale: 'static', dependencies: [], suggestedAssignee: 'coder', suggestedTags: ['fix'], withinBudget: true },
        ],
        requiresApproval: [],
        totalEstimatedCostUsd: 5,
        budgetOverflowUsd: 0,
        summary: 'Static fallback',
        warnings: ['Scoring agent failed; used static priority ranking'],
        fallback: 'static',
      },
    }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fallback).toBe('static');
    expect(body.warnings).toContain('Scoring agent failed; used static priority ranking');
  });
});

describe('POST /api/v5/cycles/preview — error paths', () => {
  it('returns 500 with clean error when scoring throws', async () => {
    app = await makeApp(makeFakeAutonomous({ throwAt: 'score' }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toMatch(/Preview failed/);
    expect(body.error).toMatch(/score exploded/);
  });

  it('returns 500 when proposal build throws', async () => {
    app = await makeApp(makeFakeAutonomous({ throwAt: 'build' }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/build exploded/);
  });

  it('returns 500 when autonomous module fails to load', async () => {
    app = await makeApp(makeFakeAutonomous({ throwAt: 'load' }));
    const res = await app.inject({ method: 'POST', url: '/api/v5/cycles/preview', payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/load exploded/);
  });
});
