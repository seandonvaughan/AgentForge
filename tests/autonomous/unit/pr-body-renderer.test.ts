import { describe, it, expect } from 'vitest';
import { renderPrBody } from '../../../packages/core/src/autonomous/pr-body-renderer.js';
import { CycleStage } from '../../../packages/core/src/autonomous/types.js';

describe('renderPrBody', () => {
  const baseInput = {
    sprint: {
      version: '6.4.0',
      items: [
        { id: 'i1', priority: 'P0', title: 'Add X', assignee: 'coder' },
        { id: 'i2', priority: 'P1', title: 'Fix Y', assignee: 'debugger' },
      ],
    } as any,
    result: {
      cycleId: 'abc-123',
      sprintVersion: '6.4.0',
      stage: CycleStage.COMPLETED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:30:00Z',
      durationMs: 1800000,
      cost: {
        totalUsd: 42.5,
        budgetUsd: 50,
        byAgent: { coder: 20, debugger: 15, 'backlog-scorer': 1.5, reviewer: 6 },
        byPhase: {},
      },
      tests: { passed: 4020, failed: 0, skipped: 0, total: 4020, passRate: 1.0, newFailures: [] },
      git: {
        branch: 'autonomous/v6.4.0',
        commitSha: 'abc123def456',
        filesChanged: ['src/foo.ts', 'src/bar.ts'],
      },
      pr: { url: null, number: null, draft: false },
    } as any,
    testResult: {
      passed: 4020,
      failed: 0,
      skipped: 0,
      total: 4020,
      passRate: 1.0,
      durationMs: 180000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: '/tmp/raw.log',
      exitCode: 0,
    },
    scoringResult: {
      rankings: [],
      totalEstimatedCostUsd: 45,
      budgetOverflowUsd: 0,
      summary: 'Selected 2 high-impact items within $50 budget.',
      warnings: [],
    },
  };

  it('renders a markdown PR body with version in title', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('## Autonomous Cycle: v6.4.0');
    expect(body).toContain('abc-123');
  });

  it('includes cost summary', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('$42.50');
    expect(body).toContain('/ $50.00');
  });

  it('includes test results', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('4020 passed');
    expect(body).toContain('100.0%');
  });

  it('lists sprint items with priority and assignee', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('**P0** Add X');
    expect(body).toContain('`coder`');
    expect(body).toContain('**P1** Fix Y');
    expect(body).toContain('`debugger`');
  });

  it('lists files changed', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('`src/foo.ts`');
    expect(body).toContain('`src/bar.ts`');
  });

  it('includes scoring rationale', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('Selected 2 high-impact items');
  });

  it('cost breakdown sorted by amount descending', () => {
    const body = renderPrBody(baseInput);
    const coderIdx = body.indexOf('`coder`');
    const debuggerIdx = body.indexOf('`debugger`');
    const reviewerIdx = body.indexOf('`reviewer`');
    const scorerIdx = body.indexOf('`backlog-scorer`');
    expect(coderIdx).toBeLessThan(debuggerIdx);
    expect(debuggerIdx).toBeLessThan(reviewerIdx);
    expect(reviewerIdx).toBeLessThan(scorerIdx);
  });

  it('ends with Co-Authored-By footer', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('Co-Authored-By: Claude Opus 4.6');
  });

  it('includes cycle log directory reference', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('.agentforge/cycles/abc-123/');
  });
});
