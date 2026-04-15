import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkspaceManager,
  previewCycle,
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
      loadAutonomous: async () => ({ previewCycle }),
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
      rankedItems: Array<{ title: string }>;
    }>();

    expect(body.candidateCount).toBe(2);
    expect(body.withinBudget).toBeGreaterThanOrEqual(1);
    expect(body.rankedItems.some((item) => item.title.includes('Preview route should see this failed task'))).toBe(true);
  });
});
