import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliProgram } from '../bin.js';

describe('cycle list/show summaries', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-cli-'));
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('lists heartbeat-only cycles as active instead of completed', async () => {
    const cycleId = '11111111-1111-4111-8111-111111111111';
    writeCycle(cycleId, { cycleId, lastHeartbeatAt: '2026-05-19T19:15:26.731Z' }, [
      { type: 'phase.start', phase: 'audit', at: '2026-05-19T19:16:34.319Z' },
    ]);

    await runCli('cycle', 'list', '--project-root', projectRoot, '--limit', '1');

    expect(output()).toContain(`${cycleId}  audit`);
    expect(output()).not.toContain(`${cycleId}  completed`);
  });

  it('shows heartbeat-only cycles with inferred active stage', async () => {
    const cycleId = '22222222-2222-4222-8222-222222222222';
    writeCycle(cycleId, { cycleId, lastHeartbeatAt: '2026-05-19T19:15:26.731Z' }, [
      { type: 'phase.start', phase: 'execute', at: '2026-05-19T19:22:14.813Z' },
    ]);

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot);

    expect(output()).toContain(`Cycle:        ${cycleId}`);
    expect(output()).toContain('Stage:        execute');
    expect(output()).not.toContain('Stage:        completed');
  });

  it('defaults heartbeat-only cycles without events to plan', async () => {
    const cycleId = '33333333-3333-4333-8333-333333333333';
    writeCycle(cycleId, { cycleId, lastHeartbeatAt: '2026-05-19T19:15:26.731Z' });

    await runCli('cycle', 'list', '--project-root', projectRoot, '--limit', '1');

    expect(output()).toContain(`${cycleId}  plan`);
  });

  it('prints machine-readable JSON for cycle list with --json', async () => {
    const cycleId = '66666666-6666-4666-8666-666666666666';
    writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      sprintVersion: '10.8.0',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
      cost: { totalUsd: 1.25, budgetUsd: 10 },
      tests: { passed: 12, total: 12 },
      pr: { url: 'https://github.com/seandonvaughan/AgentForge/pull/666' },
    });

    await runCli('cycle', 'list', '--project-root', projectRoot, '--limit', '1', '--json');

    const parsed = JSON.parse(output()) as {
      projectRoot: string;
      limit: number;
      cycles: Array<{
        cycleId: string;
        stage: string;
        sprintVersion: string | null;
        testsPassed: number;
        testsTotal: number;
      }>;
    };

    expect(parsed.projectRoot).toBe(projectRoot);
    expect(parsed.limit).toBe(1);
    expect(parsed.cycles).toHaveLength(1);
    expect(parsed.cycles[0]?.cycleId).toBe(cycleId);
    expect(parsed.cycles[0]?.stage).toBe('completed');
    expect(parsed.cycles[0]?.sprintVersion).toBe('10.8.0');
    expect(parsed.cycles[0]?.testsPassed).toBe(12);
    expect(parsed.cycles[0]?.testsTotal).toBe(12);
  });

  it('filters cycle list output by stage', async () => {
    const completedCycleId = '12121212-1212-4212-8212-121212121212';
    const failedCycleId = '34343434-3434-4343-8343-343434343434';
    writeCycle(completedCycleId, {
      cycleId: completedCycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
    });
    writeCycle(failedCycleId, {
      cycleId: failedCycleId,
      stage: 'failed',
      startedAt: '2026-05-20T00:01:00.000Z',
    });

    await runCli('cycle', 'list', '--project-root', projectRoot, '--stage', 'failed');

    expect(output()).toContain(`${failedCycleId}  failed`);
    expect(output()).not.toContain(`${completedCycleId}  completed`);
  });

  it('filters cycle list JSON output by stage and includes the stage filter', async () => {
    const completedCycleId = '56565656-5656-4565-8565-565656565656';
    const failedCycleId = '78787878-7878-4787-8787-787878787878';
    writeCycle(completedCycleId, {
      cycleId: completedCycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
    });
    writeCycle(failedCycleId, {
      cycleId: failedCycleId,
      stage: 'failed',
      startedAt: '2026-05-20T00:01:00.000Z',
    });

    await runCli('cycle', 'list', '--project-root', projectRoot, '--stage', 'completed', '--json');

    const parsed = JSON.parse(output()) as {
      stage: string;
      cycles: Array<{ cycleId: string; stage: string }>;
    };
    expect(parsed.stage).toBe('completed');
    expect(parsed.cycles).toHaveLength(1);
    expect(parsed.cycles[0]?.cycleId).toBe(completedCycleId);
    expect(parsed.cycles[0]?.stage).toBe('completed');
  });

  it('filters by canonical and artifact cycle stages not known to the CLI filter', async () => {
    const stages = ['stage', 'verify', 'commit', 'aborted'];
    for (const stage of stages) {
      writeCycle(`${stage.padEnd(8, '0')}-1111-4111-8111-111111111111`, {
        cycleId: `${stage.padEnd(8, '0')}-1111-4111-8111-111111111111`,
        stage,
        startedAt: '2026-05-20T00:00:00.000Z',
      });
    }

    for (const stage of stages) {
      consoleLog.mockClear();
      await runCli('cycle', 'list', '--project-root', projectRoot, '--stage', stage, '--json');

      const parsed = JSON.parse(output()) as {
        stage: string;
        cycles: Array<{ stage: string }>;
      };
      expect(parsed.stage).toBe(stage);
      expect(parsed.cycles).toHaveLength(1);
      expect(parsed.cycles[0]?.stage).toBe(stage);
    }
  });

  it('reports an accurate text empty state when a valid stage filter matches no cycles', async () => {
    writeCycle('99999999-1111-4111-8111-111111111111', {
      cycleId: '99999999-1111-4111-8111-111111111111',
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
    });

    await runCli('cycle', 'list', '--project-root', projectRoot, '--stage', 'verify');

    expect(output()).toBe('(no cycles matched --stage verify)');
  });

  it('fails cycle list when stage filter syntax is invalid', async () => {
    await runCli('cycle', 'list', '--project-root', projectRoot, '--stage', 'bad stage');

    expect(process.exitCode).toBe(1);
    expect(errorOutput()).toContain('Invalid value for --stage: bad stage.');
    expect(output()).toBe('');
  });

  it('shows PRs from agent-prs ledger when cycle.json has no cycle-level PR', async () => {
    const cycleId = '44444444-4444-4444-8444-444444444444';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-19T18:40:03.005Z',
      completedAt: '2026-05-19T19:06:46.966Z',
      pr: { url: null, number: null, draft: false },
    });
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 99,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/99',
        branch: 'codex/agent-test',
        status: 'open',
        openedAt: '2026-05-19T18:56:08.691Z',
      },
    ], null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot);

    expect(output()).toContain('PR:           https://github.com/seandonvaughan/AgentForge/pull/99');
  });

  it('shows the latest retry PR from agent-prs ledger', async () => {
    const cycleId = '55555555-5555-4555-8555-555555555555';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:49:19.642Z',
      completedAt: '2026-05-20T01:09:07.298Z',
      pr: { url: null, number: null, draft: false },
    });
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 102,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/102',
        branch: 'codex/agent-test',
        status: 'open',
        openedAt: '2026-05-20T00:54:02.427Z',
      },
      {
        prNumber: 103,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/103',
        branch: 'codex/agent-test-retry-1',
        status: 'open',
        openedAt: '2026-05-20T01:01:07.957Z',
      },
    ], null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot);

    expect(output()).toContain('PR:           https://github.com/seandonvaughan/AgentForge/pull/103');
    expect(output()).not.toContain('PR:           https://github.com/seandonvaughan/AgentForge/pull/102');
  });

  it('prints machine-readable JSON for cycle show with --json', async () => {
    const cycleId = '77777777-7777-4777-8777-777777777777';
    writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      sprintVersion: '10.8.1',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
      cost: { totalUsd: 2.5, budgetUsd: 10 },
      tests: { passed: 8, total: 10 },
      pr: { url: 'https://github.com/seandonvaughan/AgentForge/pull/777' },
    }, [
      { type: 'phase.start', phase: 'plan', at: '2026-05-20T00:00:01.000Z' },
      { type: 'phase.complete', phase: 'plan', at: '2026-05-20T00:01:01.000Z' },
    ]);

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      projectRoot: string;
      cycleId: string;
      summary: {
        stage: string;
        testsPassed: number;
        testsTotal: number;
      };
      eventsCount: number;
      error: string | null;
    };

    expect(parsed.projectRoot).toBe(projectRoot);
    expect(parsed.cycleId).toBe(cycleId);
    expect(parsed.summary.stage).toBe('completed');
    expect(parsed.summary.testsPassed).toBe(8);
    expect(parsed.summary.testsTotal).toBe(10);
    expect(parsed.eventsCount).toBe(2);
    expect(parsed.error).toBeNull();
    expect(output()).not.toContain('Cycle:');
  });

  it('includes latest agent PR fallback metadata in cycle show JSON', async () => {
    const cycleId = '88888888-8888-4888-8888-888888888888';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
      pr: { url: null, number: null, draft: false },
    });
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 201,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/201',
        branch: 'codex/agent-test-old',
        status: 'open',
        openedAt: '2026-05-20T00:01:00.000Z',
      },
      {
        prNumber: 202,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/202',
        branch: 'codex/agent-test-retry',
        status: 'open',
        openedAt: '2026-05-20T00:02:00.000Z',
      },
    ], null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      summary: { prUrl: string | null };
      pr: {
        url: string | null;
        agentPr: {
          prNumber: number | null;
          prUrl: string | null;
          branch: string | null;
          status: string | null;
        } | null;
      };
    };

    expect(parsed.summary.prUrl).toBe('https://github.com/seandonvaughan/AgentForge/pull/202');
    expect(parsed.pr.url).toBe('https://github.com/seandonvaughan/AgentForge/pull/202');
    expect(parsed.pr.agentPr).toMatchObject({
      prNumber: 202,
      prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/202',
      branch: 'codex/agent-test-retry',
      status: 'open',
    });
  });

  it('deduplicates runtime routing decisions by itemId from itemResults in cycle show JSON', async () => {
    const cycleId = '99999999-9999-4999-8999-999999999999';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
    });
    mkdirSync(join(cycleDir, 'phases'), { recursive: true });
    writeFileSync(join(cycleDir, 'phases', 'execute.json'), JSON.stringify({
      itemResults: [
        {
          itemId: 'item-routed',
          status: 'completed',
          runtimeMode: 'codex-cli',
          preferredProvider: 'codex-cli',
        },
        {
          itemId: 'item-routed',
          status: 'completed',
          runtimeMode: 'codex-cli',
          preferredProvider: 'codex-cli',
        },
        {
          itemId: 'item-default',
          status: 'completed',
        },
        {
          itemId: 'item-default',
          status: 'completed',
        },
      ],
    }, null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      runtimeRouting: {
        totalItems: number;
        routedItems: number;
        defaultItems: number;
        decisions: Array<{
          itemId: string;
          decision: string;
          runtimeMode: string | null;
          preferredProvider: string | null;
        }>;
      } | null;
    };

    expect(parsed.runtimeRouting).toBeTruthy();
    expect(parsed.runtimeRouting).toMatchObject({
      totalItems: 2,
      routedItems: 1,
      defaultItems: 1,
    });
    expect(parsed.runtimeRouting?.decisions).toEqual([
      {
        itemId: 'item-routed',
        decision: 'routed',
        runtimeMode: 'codex-cli',
        preferredProvider: 'codex-cli',
      },
      {
        itemId: 'item-default',
        decision: 'default',
        runtimeMode: null,
        preferredProvider: null,
      },
    ]);
  });

  it('deduplicates runtime routing decisions from agentRuns when itemResults is absent', async () => {
    const cycleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
    });
    mkdirSync(join(cycleDir, 'phases'), { recursive: true });
    writeFileSync(join(cycleDir, 'phases', 'execute.json'), JSON.stringify({
      agentRuns: [
        {
          itemId: 'fallback-routed',
          status: 'completed',
          preferredProvider: 'codex-cli',
        },
        {
          itemId: 'fallback-routed',
          status: 'completed',
          preferredProvider: 'codex-cli',
        },
        {
          itemId: 'fallback-default',
          status: 'completed',
        },
      ],
    }, null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      runtimeRouting: {
        totalItems: number;
        routedItems: number;
        defaultItems: number;
        decisions: Array<{ itemId: string; decision: string }>;
      } | null;
    };

    expect(parsed.runtimeRouting).toMatchObject({
      totalItems: 2,
      routedItems: 1,
      defaultItems: 1,
    });
    expect(parsed.runtimeRouting?.decisions.map((decision) => decision.itemId)).toEqual([
      'fallback-routed',
      'fallback-default',
    ]);
  });

  it('falls back to agentRuns when itemResults is empty and ignores invalid itemIds', async () => {
    const cycleId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
    });
    mkdirSync(join(cycleDir, 'phases'), { recursive: true });
    writeFileSync(join(cycleDir, 'phases', 'execute.json'), JSON.stringify({
      itemResults: [],
      agentRuns: [
        {
          itemId: '',
          preferredProvider: 'codex-cli',
        },
        {
          itemId: null,
          preferredProvider: 'codex-cli',
        },
        {
          itemId: 'fallback-valid',
          preferredProvider: 'codex-cli',
        },
      ],
    }, null, 2));

    await runCli('cycle', 'show', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      runtimeRouting: {
        totalItems: number;
        routedItems: number;
        defaultItems: number;
        decisions: Array<{ itemId: string }>;
      } | null;
    };

    expect(parsed.runtimeRouting).toMatchObject({
      totalItems: 1,
      routedItems: 1,
      defaultItems: 0,
    });
    expect(parsed.runtimeRouting?.decisions).toEqual([
      expect.objectContaining({ itemId: 'fallback-valid' }),
    ]);
  });

  it('prints deterministic streak status when the streak ledger is missing', async () => {
    await runCli('cycle', 'streak', 'status', '--project-root', projectRoot);

    expect(output()).toContain('[cycle streak] status');
    expect(output()).toContain('Entries:      0');
    expect(output()).toContain('Consecutive:  0');
    expect(output()).toContain('Latest:       (none)');
  });

  it('records streak entries idempotently by cycleId and emits json when requested', async () => {
    const cycleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      pr: {
        number: 321,
        url: 'https://github.com/seandonvaughan/AgentForge/pull/321',
        status: 'merged',
        mergedAt: '2026-05-20T00:10:00.000Z',
      },
    });

    await runCli(
      'cycle',
      'streak',
      'record',
      cycleId,
      '--project-root',
      projectRoot,
      '--pr',
      '321',
      '--result',
      'success',
      '--reason',
      'Initial success',
      '--json',
    );

    const first = JSON.parse(output()) as {
      action: string;
      entry: {
        cycleId: string;
        prNumber: number;
        result: string;
        reason: string;
        mergeEvidence?: {
          prUrl?: string;
          status?: string;
          mergedAt?: string;
        };
      };
    };
    expect(first.action).toBe('recorded');
    expect(first.entry.cycleId).toBe(cycleId);
    expect(first.entry.result).toBe('success');
    expect(first.entry.mergeEvidence).toMatchObject({
      prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/321',
      status: 'merged',
      mergedAt: '2026-05-20T00:10:00.000Z',
    });

    consoleLog.mockClear();
    await runCli(
      'cycle',
      'streak',
      'record',
      cycleId,
      '--project-root',
      projectRoot,
      '--pr',
      '321',
      '--result',
      'failure',
      '--reason',
      'Regression found',
      '--json',
    );
    const second = JSON.parse(output()) as {
      action: string;
      entry: {
        result: string;
        reason: string;
      };
      consecutiveSuccesses: number;
    };
    expect(second.action).toBe('updated');
    expect(second.entry.result).toBe('failure');
    expect(second.entry.reason).toBe('Regression found');
    expect(second.consecutiveSuccesses).toBe(0);

    consoleLog.mockClear();
    await runCli('cycle', 'streak', 'status', '--project-root', projectRoot, '--json');
    const status = JSON.parse(output()) as {
      totalEntries: number;
      consecutiveSuccesses: number;
      latestEntry: {
        cycleId: string;
        result: string;
      } | null;
    };
    expect(status.totalEntries).toBe(1);
    expect(status.consecutiveSuccesses).toBe(0);
    expect(status.latestEntry).toMatchObject({
      cycleId,
      result: 'failure',
    });
  });

  it('omits stale open status from agent-prs fallback streak merge evidence', async () => {
    const cycleId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
    });
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify([
      {
        prNumber: 451,
        prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/451',
        status: 'open',
        openedAt: '2026-05-20T00:00:00.000Z',
      },
    ], null, 2));

    await runCli(
      'cycle',
      'streak',
      'record',
      cycleId,
      '--project-root',
      projectRoot,
      '--pr',
      '451',
      '--result',
      'success',
      '--reason',
      'Fallback evidence test',
      '--json',
    );

    const parsed = JSON.parse(output()) as {
      entry: {
        mergeEvidence?: {
          prUrl?: string;
          status?: string;
          openedAt?: string;
        };
      };
    };
    expect(parsed.entry.mergeEvidence).toMatchObject({
      prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/451',
      openedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(parsed.entry.mergeEvidence?.status).toBeUndefined();
  });

  it('omits stale open status from cycle.json streak merge evidence', async () => {
    const cycleId = 'cececece-cece-4cec-8cec-cececececece';
    writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      pr: {
        number: 452,
        url: 'https://github.com/seandonvaughan/AgentForge/pull/452',
        status: 'open',
        openedAt: '2026-05-20T00:01:00.000Z',
      },
    });

    await runCli(
      'cycle',
      'streak',
      'record',
      cycleId,
      '--project-root',
      projectRoot,
      '--pr',
      '452',
      '--result',
      'success',
      '--reason',
      'Cycle merge evidence fallback test',
      '--json',
    );

    const parsed = JSON.parse(output()) as {
      entry: {
        mergeEvidence?: {
          prUrl?: string;
          status?: string;
          openedAt?: string;
        };
      };
    };
    expect(parsed.entry.mergeEvidence).toMatchObject({
      prUrl: 'https://github.com/seandonvaughan/AgentForge/pull/452',
      openedAt: '2026-05-20T00:01:00.000Z',
    });
    expect(parsed.entry.mergeEvidence?.status).toBeUndefined();
  });

  it('resets consecutive streak count when the newest entry is a failure', async () => {
    await runCli(
      'cycle',
      'streak',
      'record',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '--project-root',
      projectRoot,
      '--pr',
      '401',
      '--result',
      'success',
      '--reason',
      'Cycle one passed',
    );
    consoleLog.mockClear();

    await runCli(
      'cycle',
      'streak',
      'record',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '--project-root',
      projectRoot,
      '--pr',
      '402',
      '--result',
      'success',
      '--reason',
      'Cycle two passed',
    );
    consoleLog.mockClear();

    await runCli(
      'cycle',
      'streak',
      'record',
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '--project-root',
      projectRoot,
      '--pr',
      '403',
      '--result',
      'failure',
      '--reason',
      'Gate rejected',
    );
    expect(output()).toContain('[cycle streak] recorded: ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(output()).toContain('Consecutive:  0');
  });

  it('rejects malformed streak PR numbers without partial parsing', async () => {
    const invalidValues = ['321abc', 'abc321', '1.5', '0'];

    for (const value of invalidValues) {
      consoleLog.mockClear();
      consoleError.mockClear();
      process.exitCode = undefined;

      await runCli(
        'cycle',
        'streak',
        'record',
        '99999999-9999-4999-8999-999999999999',
        '--project-root',
        projectRoot,
        '--pr',
        value,
        '--result',
        'success',
        '--reason',
        'Invalid PR value should fail',
      );

      expect(process.exitCode).toBe(1);
      expect(consoleError.mock.calls.map((call: unknown[]) => String(call[0]))).toContain(`Invalid --pr value: ${value}`);
      expect(output()).toBe('');
    }

    consoleLog.mockClear();
    consoleError.mockClear();
    process.exitCode = undefined;

    await runCli(
      'cycle',
      'streak',
      'record',
      '99999999-9999-4999-8999-999999999999',
      '--project-root',
      projectRoot,
      '--result',
      'success',
      '--reason',
      'Missing PR should fail',
    );

    expect(process.exitCode).toBe(1);
    expect(consoleError.mock.calls.map((call: unknown[]) => String(call[0]))).toContain('Missing --pr value.');
  });

  it('normalizes malformed streak timestamps before sorting status', async () => {
    const ledgerDir = join(projectRoot, '.agentforge', 'cycles');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'streak-ledger.json'), JSON.stringify({
      version: 1,
      entries: [
        {
          cycleId: 'success-with-bad-time',
          prNumber: 501,
          result: 'success',
          reason: 'Malformed timestamp should not win sorting',
          recordedAt: 'zzzz',
        },
        {
          cycleId: 'latest-valid-failure',
          prNumber: 502,
          result: 'failure',
          reason: 'Newest valid record is a failure',
          recordedAt: '2026-05-20T00:00:00.000Z',
        },
      ],
    }, null, 2));

    await runCli('cycle', 'streak', 'status', '--project-root', projectRoot, '--json');

    const status = JSON.parse(output()) as {
      consecutiveSuccesses: number;
      latestEntry: { cycleId: string; result: string } | null;
      entries: Array<{ cycleId: string; recordedAt: string }>;
    };

    expect(status.consecutiveSuccesses).toBe(0);
    expect(status.latestEntry).toMatchObject({
      cycleId: 'latest-valid-failure',
      result: 'failure',
    });
    expect(status.entries.find((entry) => entry.cycleId === 'success-with-bad-time')?.recordedAt)
      .toBe('1970-01-01T00:00:00.000Z');
  });

  it('reports merge-ready assessment for a completed cycle with passing checks', async () => {
    const cycleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'completed',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: '2026-05-20T00:05:00.000Z',
      gateVerdict: 'APPROVE',
      cost: { totalUsd: 1.2, budgetUsd: 10 },
      tests: { passed: 4, failed: 0, total: 4, passRate: 1, newFailures: [] },
      pr: { url: 'https://github.com/seandonvaughan/AgentForge/pull/301' },
    });
    mkdirSync(join(cycleDir, 'phases'), { recursive: true });
    writeFileSync(join(cycleDir, 'phases', 'review.json'), JSON.stringify({
      phase: 'review',
      status: 'completed',
      findings: [],
    }, null, 2));
    writeFileSync(join(cycleDir, 'phases', 'execute.json'), JSON.stringify({
      phase: 'execute',
      status: 'completed',
      itemResults: [
        { itemId: 'item-1', status: 'completed' },
      ],
    }, null, 2));

    await runCli('cycle', 'assess-pr', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      assessment: {
        mergeReady: boolean;
        verdict: string;
        blockingReasons: string[];
        checks: Array<{ id: string; status: string }>;
      };
    };

    expect(parsed.assessment.mergeReady).toBe(true);
    expect(parsed.assessment.verdict).toBe('ready');
    expect(parsed.assessment.blockingReasons).toEqual([]);
    expect(parsed.assessment.checks).toContainEqual({
      id: 'gate-approved',
      status: 'pass',
      detail: 'gate verdict is APPROVE',
    });
  });

  it('reports blocked merge assessment with deterministic blocking reasons and deduped failed items', async () => {
    const cycleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const cycleDir = writeCycle(cycleId, {
      cycleId,
      stage: 'run',
      startedAt: '2026-05-20T00:00:00.000Z',
      completedAt: null,
      error: 'gate rejected due to critical defects',
      cost: { totalUsd: 2.5, budgetUsd: 10 },
      tests: { passed: 2, failed: 1, total: 3, passRate: 0.6667, newFailures: ['new-fail-a'] },
      pr: { url: null },
    });
    mkdirSync(join(cycleDir, 'phases'), { recursive: true });
    writeFileSync(join(cycleDir, 'phases', 'gate.json'), JSON.stringify({
      phase: 'gate',
      verdict: 'REJECT',
      rationale: 'Blocking issues remain',
    }, null, 2));
    writeFileSync(join(cycleDir, 'phases', 'review.json'), JSON.stringify({
      phase: 'review',
      status: 'completed',
      findings: [
        { severity: 'CRITICAL', message: 'Critical issue' },
        { severity: 'MAJOR', message: 'Major issue' },
      ],
    }, null, 2));
    writeFileSync(join(cycleDir, 'phases', 'execute.json'), JSON.stringify({
      phase: 'execute',
      status: 'completed',
      itemResults: [
        { itemId: 'item-failed', status: 'failed' },
        { itemId: 'item-failed', status: 'failed' },
      ],
    }, null, 2));
    writeFileSync(join(cycleDir, 'approval-decision.json'), JSON.stringify({
      cycleId,
      decision: 'rejected',
    }, null, 2));

    await runCli('cycle', 'assess-pr', cycleId, '--project-root', projectRoot, '--json');

    const parsed = JSON.parse(output()) as {
      assessment: {
        mergeReady: boolean;
        verdict: string;
        blockingReasons: string[];
        metrics: {
          gateVerdict: string | null;
          criticalFindings: number;
          majorFindings: number;
          failedItems: number;
          newFailures: number;
        };
      };
    };

    expect(parsed.assessment.mergeReady).toBe(false);
    expect(parsed.assessment.verdict).toBe('blocked');
    expect(parsed.assessment.metrics.gateVerdict).toBe('REJECT');
    expect(parsed.assessment.metrics.criticalFindings).toBe(1);
    expect(parsed.assessment.metrics.majorFindings).toBe(1);
    expect(parsed.assessment.metrics.failedItems).toBe(1);
    expect(parsed.assessment.metrics.newFailures).toBe(1);
    expect(parsed.assessment.blockingReasons).toContain('cycle-completed: cycle stage is run');
    expect(parsed.assessment.blockingReasons).toContain('gate-approved: gate verdict is REJECT');
    expect(parsed.assessment.blockingReasons).toContain('tests: tests passed=2/3 newFailures=1');
  });

  function writeCycle(
    cycleId: string,
    cycleJson: Record<string, unknown>,
    events: Array<Record<string, unknown>> = [],
  ): string {
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify(cycleJson, null, 2));
    if (events.length > 0) {
      writeFileSync(join(cycleDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    }
    return cycleDir;
  }

  async function runCli(...args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }

  function output(): string {
    return consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }

  function errorOutput(): string {
    return consoleError.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }
});
