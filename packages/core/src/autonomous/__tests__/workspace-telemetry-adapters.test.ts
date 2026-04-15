import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceManager } from '../../workspace/index.js';
import { createAutonomousTelemetryAdapters } from '../workspace-telemetry-adapters.js';

describe('createAutonomousTelemetryAdapters', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-autonomous-telemetry-'));
    mkdirSync(join(projectRoot, '.agentforge', 'sprints'), { recursive: true });

    const manager = new WorkspaceManager({
      dataDir: join(projectRoot, '.agentforge', 'v5'),
    });

    try {
      const { adapter } = await manager.getOrCreateDefaultWorkspace();

      const failedSession = adapter.createSession({
        agentId: 'coder',
        task: 'Fix compiler crash',
        model: 'sonnet',
      });
      adapter.completeSession(failedSession.id, 'failed', 0, {
        model: 'sonnet',
        inputTokens: 10,
        outputTokens: 20,
      });
      adapter.recordTaskOutcome({
        sessionId: failedSession.id,
        agentId: 'coder',
        task: 'Fix compiler crash',
        outcome: 'failure',
        success: false,
        summary: 'Compiler exploded on build pipeline',
      });

      adapter.recordCost({
        sessionId: failedSession.id,
        agentId: 'coder',
        model: 'sonnet',
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 5,
      });
      adapter.recordCost({
        agentId: 'coder',
        model: 'sonnet',
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 6,
      });
      adapter.recordCost({
        agentId: 'coder',
        model: 'sonnet',
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 20,
      });

      adapter.recordTestObservation({
        sessionId: failedSession.id,
        agentId: 'backend-qa',
        suite: 'auth',
        testName: 'retries when token expired',
        filePath: 'tests/auth.spec.ts',
        status: 'failed',
      });
      adapter.recordTestObservation({
        sessionId: failedSession.id,
        agentId: 'backend-qa',
        suite: 'auth',
        testName: 'retries when token expired',
        filePath: 'tests/auth.spec.ts',
        status: 'passed',
      });

      writeFileSync(
        join(projectRoot, '.agentforge', 'sprints', 'v1.0.json'),
        JSON.stringify({
          version: '1.0',
          title: 'Stabilize auth',
          phase: 'completed',
          createdAt: '2026-04-15T10:00:00.000Z',
          items: [
            { id: 'one', status: 'completed' },
            { id: 'two', status: 'planned' },
          ],
        }),
      );
    } finally {
      manager.close();
    }
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('surfaces real proposal signals from workspace telemetry', async () => {
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);

    try {
      const failedSessions = await telemetry.proposalAdapter.getRecentFailedSessions(7);
      const failedOutcomes = await telemetry.proposalAdapter.getFailedTaskOutcomes(7);
      const costAnomalies = await telemetry.proposalAdapter.getCostAnomalies(7);
      const flakingTests = await telemetry.proposalAdapter.getFlakingTests(7);

      expect(failedSessions).toHaveLength(1);
      expect(failedSessions[0]).toMatchObject({
        agent: 'coder',
        error: 'Compiler exploded on build pipeline',
      });

      expect(failedOutcomes).toHaveLength(1);
      expect(failedOutcomes[0]?.description).toContain('Compiler exploded');

      expect(costAnomalies).toHaveLength(1);
      expect(costAnomalies[0]?.agent).toBe('coder');
      expect(costAnomalies[0]?.anomaly).toContain('median');

      expect(flakingTests).toHaveLength(1);
      expect(flakingTests[0]).toMatchObject({
        file: 'tests/auth.spec.ts',
        name: 'retries when token expired',
      });
      expect(flakingTests[0]?.failRate).toBe(0.5);
    } finally {
      telemetry.close();
    }
  });

  it('builds scoring grounding from sprint history, medians, and recent utilization', async () => {
    const telemetry = createAutonomousTelemetryAdapters(projectRoot);

    try {
      const history = await telemetry.scoringAdapter.getSprintHistory(5);
      const medians = await telemetry.scoringAdapter.getCostMedians();
      const teamState = await telemetry.scoringAdapter.getTeamState();

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        version: '1.0',
        title: 'Stabilize auth',
        itemCount: 2,
        completedCount: 1,
      });

      expect(medians['coder']).toBe(6);
      expect(teamState.utilization['coder']).toBe(1);
    } finally {
      telemetry.close();
    }
  });
});
