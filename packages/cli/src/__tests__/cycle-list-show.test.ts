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

  it('includes runtime routing decisions in cycle show JSON when execute artifact has routing hints', async () => {
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
});
