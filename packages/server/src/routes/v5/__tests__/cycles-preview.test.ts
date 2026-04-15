import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_CYCLE_CONFIG,
  WorkspaceManager,
  createAutonomousTelemetryAdapters,
} from '@agentforge/core';
import { cyclesPreviewRoutes } from '../cycles-preview.js';

describe('POST /api/v5/cycles/preview', () => {
  let projectRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-preview-'));
    app = Fastify({ logger: false });

    const manager = new WorkspaceManager({
      dataDir: join(projectRoot, '.agentforge', 'v5'),
    });

    try {
      const { adapter } = await manager.getOrCreateDefaultWorkspace();
      const failedSession = adapter.createSession({
        agentId: 'coder',
        task: 'Fix preview-backed failure',
        model: 'sonnet',
      });
      adapter.completeSession(failedSession.id, 'failed', 0, {
        model: 'sonnet',
        inputTokens: 10,
        outputTokens: 5,
      });
      adapter.recordTaskOutcome({
        sessionId: failedSession.id,
        agentId: 'coder',
        task: 'Fix preview-backed failure',
        outcome: 'failure',
        success: false,
        summary: 'Preview route should see this failed task',
      });
    } finally {
      manager.close();
    }

    await cyclesPreviewRoutes(app, {
      projectRoot,
      loadAutonomous: async () => ({
        loadCycleConfig: () => DEFAULT_CYCLE_CONFIG,
        createAutonomousTelemetryAdapters,
        ProposalToBacklog: class {
          constructor(
            private readonly adapter: {
              getRecentFailedSessions(days: number): Promise<Array<{
                id: string;
                agent: string;
                error: string;
                confidence: number;
              }>>;
            },
            private readonly cwd: string,
            private readonly config: { sourcing: { lookbackDays: number } },
          ) {}

          async build() {
            const failed = await this.adapter.getRecentFailedSessions(
              this.config.sourcing.lookbackDays,
            );
            return failed.map((entry) => ({
              id: `failed-${entry.id}`,
              title: entry.error,
              description: `${entry.agent}: ${entry.error} @ ${this.cwd}`,
              priority: 'P0' as const,
              tags: ['fix'],
              source: 'failed-session' as const,
              confidence: entry.confidence,
            }));
          }
        },
        ScoringPipeline: class {
          constructor(
            _runtime: unknown,
            _adapter: unknown,
            _config: unknown,
            _logger: unknown,
          ) {}

          async scoreWithFallback(backlog: Array<{ id: string; title: string }>) {
            return {
              withinBudget: backlog.map((item, index) => ({
                itemId: item.id,
                title: item.title,
                rank: index + 1,
                score: 0.9,
                confidence: 0.9,
                estimatedCostUsd: 10,
                estimatedDurationMinutes: 15,
                rationale: 'telemetry-backed preview',
                dependencies: [],
                suggestedAssignee: 'coder',
                suggestedTags: ['fix'],
                withinBudget: true,
              })),
              requiresApproval: [],
              totalEstimatedCostUsd: backlog.length * 10,
              budgetOverflowUsd: 0,
              summary: `${backlog.length} item(s) scored`,
              warnings: [],
            };
          }
        },
        RuntimeAdapter: class {
          constructor(_opts: { cwd: string }) {}
        },
      }),
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('uses workspace telemetry instead of empty preview adapters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/cycles/preview',
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      candidateCount: number;
      withinBudget: number;
      summary: string;
      rankedItems: Array<{ title: string }>;
    }>();

    expect(body.candidateCount).toBe(1);
    expect(body.withinBudget).toBe(1);
    expect(body.summary).toBe('1 item(s) scored');
    expect(body.rankedItems[0]?.title).toContain('Preview route should see this failed task');
  });
});
