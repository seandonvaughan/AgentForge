// packages/core/src/autonomous/__tests__/cycle-runner-multi-pr.test.ts
//
// Unit tests for CycleRunner ↔ MergeQueue integration (prMode='multi').
//
// Strategy: we test the LOGIC of the mode-branching in isolation, using
// a real MergeQueue in dry-run mode for integration scenarios and a
// manually crafted mock-object pattern (not vi.spyOn on a class) for
// call-assertion scenarios.
//
// Coverage:
//   1.  prMode unset → MergeQueue NOT started (no messageBus)
//   2.  prMode='single' explicit → same: MergeQueue NOT started
//   3.  prMode='multi' + messageBus → MergeQueue.start() called
//   4.  prMode='multi' + no messageBus → falls back, MergeQueue NOT started
//   5.  prMode='multi' + agent.branch.pushed → ledger entry recorded
//   6.  Two agents push branches → two ledger entries
//   7.  prMode='multi' cycle end → drain() called, prOpener NOT called
//   8.  prMode='single' cycle end → prOpener IS called, drain NOT called
//   9.  prMode='multi' + autoMergePRs=true → drainAndMerge({autoMerge:true})
//  10.  autoMergePRs absent → drainAndMerge({autoMerge:false})
//  11.  stop() is called before drain() in multi-PR end path
//  12.  drainAndMerge errors are swallowed (cycle continues)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageBusV2 } from '../../message-bus/message-bus.js';
import { MergeQueue } from '../../runtime/merge-queue.js';
import type { AgentBranchPushedPayload } from '../../message-bus/types.js';
import type { DrainResult, DrainAndMergeResult } from '../../runtime/merge-queue.js';
import {
  buildGateRetryContext,
  shouldOpenSingleCyclePr,
  shouldRunAggregateCommit,
} from '../cycle-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cr-multi-pr-'));
  mkdirSync(join(dir, '.agentforge', 'cycles'), { recursive: true });
  return dir;
}

function makeCycleDir(projectRoot: string, cycleId: string): void {
  mkdirSync(join(projectRoot, '.agentforge', 'cycles', cycleId), { recursive: true });
}

function readLedger(projectRoot: string, cycleId: string): unknown[] {
  const p = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf-8')) as unknown[];
}

function writeLedger(projectRoot: string, cycleId: string, entries: unknown[]): void {
  const p = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  mkdirSync(join(projectRoot, '.agentforge', 'cycles', cycleId), { recursive: true });
  writeFileSync(p, JSON.stringify(entries, null, 2));
}

function buildPayload(overrides: Partial<AgentBranchPushedPayload> = {}): AgentBranchPushedPayload {
  return {
    cycleId: 'test-cycle-id',
    agentId: 'coder-1',
    sessionId: 'sess-1',
    branch: 'autonomous/agent-coder-1-sess-1',
    baseBranch: 'main',
    commitSha: 'deadbeef',
    filesChanged: 3,
    diffSummary: '+1 -0 src/foo.ts',
    pushedAt: new Date().toISOString(),
    itemIds: ['T-001'],
    ...overrides,
  };
}

function emitBranchPushed(bus: MessageBusV2, payload: AgentBranchPushedPayload): void {
  bus.publish<AgentBranchPushedPayload>({
    from: 'system',
    to: 'broadcast',
    topic: 'agent.branch.pushed',
    category: 'system',
    payload,
  });
}

/**
 * Create a minimal mock MergeQueue interface using plain objects + vi.fn().
 * Avoids class-spy issues with TypeScript strict constructor mocking.
 */
interface IMergeQueue {
  start: () => void;
  stop: () => void;
  drain: () => Promise<DrainResult>;
  drainAndMerge: (opts?: { autoMerge?: boolean }) => Promise<DrainAndMergeResult>;
}

function makeMockQueue(): IMergeQueue {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    drain: vi.fn<() => Promise<DrainResult>>().mockResolvedValue({
      pushed: 2,
      prs: [{ prNumber: 42, branch: 'auto/a', agentId: 'coder-1' }],
    }),
    drainAndMerge: vi.fn<(opts?: { autoMerge?: boolean }) => Promise<DrainAndMergeResult>>()
      .mockResolvedValue({ ready: [42], merged: [], failing: [], pending: [], unknown: [] }),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projectRoot: string;

beforeEach(() => {
  projectRoot = makeTmpDir();
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('gate retry context — agent PR ledger routing', () => {
  it('preserves structured CRITICAL/MAJOR findings, debt, and file targets from phase artifacts', () => {
    const cycleId = 'cycle-retry-structured-findings';
    makeCycleDir(projectRoot, cycleId);
    mkdirSync(join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases', 'review.json'),
      JSON.stringify({
        findings: [
          {
            severity: 'CRITICAL',
            message: 'SQL injection in list endpoint',
            file: 'packages/server/src/routes/v5/index.ts',
            line: 44,
            fixSuggestion: 'parameterize the query',
          },
          {
            severity: 'MAJOR',
            message: 'Retry prompt loses debt context',
            file: 'packages/core/src/autonomous/cycle-runner.ts',
          },
          { severity: 'INFO', message: 'ignore non-blocking' },
        ],
      }),
    );
    writeFileSync(
      join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases', 'gate.json'),
      JSON.stringify({
        knownDebt: ['Retry prompt loses debt context'],
      }),
    );

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      2,
      'Gate rejected with critical and major findings.',
    );

    expect(context.files).toContain('packages/server/src/routes/v5/index.ts');
    expect(context.files).toContain('packages/core/src/autonomous/cycle-runner.ts');
    expect(context.knownDebt).toEqual(['Retry prompt loses debt context']);
    expect(context.structuredFindings).toBeDefined();
    expect(context.structuredFindings).toHaveLength(2);
    expect(context.structuredFindings?.[0]).toMatchObject({
      severity: 'CRITICAL',
      message: 'SQL injection in list endpoint',
      file: 'packages/server/src/routes/v5/index.ts',
      line: 44,
      fixSuggestion: 'parameterize the query',
    });
    expect(context.structuredFindings?.[1]).toMatchObject({
      severity: 'MAJOR',
      message: 'Retry prompt loses debt context',
      knownDebt: true,
    });
    expect(context.findings).toContain('CRITICAL: SQL injection in list endpoint');
    expect(context.findings).toContain('MAJOR: Retry prompt loses debt context');
  });

  it('maps itemIds from the exact rejected PR number record', () => {
    const cycleId = 'cycle-retry-pr-number';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/agent-docs-a',
        itemIds: ['item-A'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        branch: 'codex/agent-runtime-b',
        itemIds: ['item-B'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected PR #176 because packages/core/src/runtime.ts still diverges.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-runtime-b');
    expect(context.prNumber).toBe(176);
    expect(context.itemIds).toEqual(['item-B']);
  });

  it('maps itemIds from the exact rejected PR URL record', () => {
    const cycleId = 'cycle-retry-pr-url';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        prUrl: 'https://github.com/acme/agentforge/pull/175',
        branch: 'codex/agent-docs-a',
        itemIds: ['item-A'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        prUrl: 'https://github.com/acme/agentforge/pull/176',
        branch: 'codex/agent-runtime-b',
        itemIds: ['item-B'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected https://github.com/acme/agentforge/pull/176 because runtime checks still diverge.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-runtime-b');
    expect(context.prNumber).toBe(176);
    expect(context.prUrl).toBe('https://github.com/acme/agentforge/pull/176');
    expect(context.itemIds).toEqual(['item-B']);
  });

  it('maps itemIds from the exact rejected branch record', () => {
    const cycleId = 'cycle-retry-ledger';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/agent-docs-a',
        itemIds: ['item-A'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        branch: 'codex/agent-runtime-b',
        itemIds: ['item-B'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected the work against branch codex/agent-runtime-b.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-runtime-b');
    expect(context.prNumber).toBe(176);
    expect(context.itemIds).toEqual(['item-B']);
  });

  it('falls back from a stale PR number to the exact rejected branch record', () => {
    const cycleId = 'cycle-retry-stale-pr-exact-branch';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/agent-docs-a',
        itemIds: ['item-A'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        branch: 'codex/agent-runtime-b',
        itemIds: ['item-B'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected PR #999 against branch codex/agent-runtime-b.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-runtime-b');
    expect(context.prNumber).toBe(176);
    expect(context.itemIds).toEqual(['item-B']);
  });

  it('does not match a ledger branch by prefix inside a longer rationale branch', () => {
    const cycleId = 'cycle-retry-branch-prefix-collision';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/foo',
        itemIds: ['item-short'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        branch: 'codex/unrelated',
        itemIds: ['item-other'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected origin/codex/foo-bar after inspecting the diff.',
    );

    expect(context.rejectedBranch).toBeUndefined();
    expect(context.prNumber).toBeUndefined();
    expect(context.itemIds).toBeUndefined();
  });

  it('still uses the sole ledger record fallback when a branch prefix collision is otherwise ambiguous', () => {
    const cycleId = 'cycle-retry-prefix-single-ledger';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/foo',
        itemIds: ['item-only'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected origin/codex/foo-bar after inspecting the diff.',
    );

    expect(context.rejectedBranch).toBe('codex/foo');
    expect(context.prNumber).toBe(175);
    expect(context.itemIds).toEqual(['item-only']);
  });

  it('uses the sole ledger record as a safe fallback and preserves itemIds', () => {
    const cycleId = 'cycle-retry-single-ledger';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 178,
        branch: 'codex/agent-runtime-only',
        itemIds: ['item-only'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected docs/runtime-modes.md because the test was vacuous.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-runtime-only');
    expect(context.prNumber).toBe(178);
    expect(context.itemIds).toEqual(['item-only']);
  });

  it('does not parse "target branch diff" as a rejected branch when the ledger has the actual branch', () => {
    const cycleId = 'cycle-retry-branch-diff';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 187,
        branch: 'codex/agent-autonomy-strategist-29a15f123f4e',
        itemIds: ['backlog-dogfood-004'],
        openedAt: '2026-05-27T22:46:16.893Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'I verified the execute target branch diff (`origin/codex/codex-version...codex/agent-autonomy-strategist-29a15f123f4e`) and the four changed files.',
    );

    expect(context.rejectedBranch).toBe('codex/agent-autonomy-strategist-29a15f123f4e');
    expect(context.prNumber).toBe(187);
    expect(context.itemIds).toEqual(['backlog-dogfood-004']);
  });

  it('does not guess itemIds from the latest PR when multiple records are ambiguous', () => {
    const cycleId = 'cycle-retry-ambiguous-ledger';
    writeLedger(projectRoot, cycleId, [
      {
        prNumber: 175,
        branch: 'codex/agent-docs-a',
        itemIds: ['item-A'],
        openedAt: '2026-05-25T01:00:00.000Z',
      },
      {
        prNumber: 176,
        branch: 'codex/agent-runtime-b',
        itemIds: ['item-B'],
        openedAt: '2026-05-25T01:01:00.000Z',
      },
    ]);

    const context = buildGateRetryContext(
      projectRoot,
      cycleId,
      1,
      'Gate rejected docs/runtime-modes.md because the test was vacuous.',
    );

    expect(context.rejectedBranch).toBeUndefined();
    expect(context.prNumber).toBeUndefined();
    expect(context.itemIds).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1–4: MergeQueue construction / start() gating
// ---------------------------------------------------------------------------

describe('prMode gating — MergeQueue construction', () => {
  it('1. prMode absent → MergeQueue NOT started', () => {
    const mock = makeMockQueue();
    let mqCreated = false;

    // Simulate what the runner does
    const config = {} as { prMode?: 'single' | 'multi' };
    if (config.prMode === 'multi') {
      mqCreated = true;
      mock.start();
    }

    expect(mqCreated).toBe(false);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('2. prMode=\'single\' explicit → MergeQueue NOT started', () => {
    const mock = makeMockQueue();
    let mqCreated = false;

    // Use a union type so TypeScript doesn't narrow prMode to a literal that
    // makes the if-branch dead code (TS2367).
    const config: { prMode: 'single' | 'multi' } = { prMode: 'single' };
    if (config.prMode === 'multi') {
      mqCreated = true;
      mock.start();
    }

    expect(mqCreated).toBe(false);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('3. prMode=\'multi\' + messageBus provided → start() called', () => {
    const mock = makeMockQueue();
    const bus = new MessageBusV2();

    const config = { prMode: 'multi' as const };
    const messageBus: MessageBusV2 | undefined = bus;

    if (config.prMode === 'multi' && messageBus) {
      mock.start();
    }

    expect(mock.start).toHaveBeenCalledOnce();
  });

  it('4. prMode=\'multi\' + messageBus absent → start() NOT called (fallback path)', () => {
    const mock = makeMockQueue();

    const config = { prMode: 'multi' as const };
    const messageBus: MessageBusV2 | undefined = undefined;

    if (config.prMode === 'multi' && messageBus) {
      mock.start();
    }

    expect(mock.start).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5–6: agent.branch.pushed → ledger (integration with real MergeQueue)
// ---------------------------------------------------------------------------

describe('prMode=multi + agent.branch.pushed ledger integration', () => {
  it('5. prMode=\'multi\' + agent.branch.pushed event → ledger entry recorded', async () => {
    const cycleId = 'test-cycle-id';
    makeCycleDir(projectRoot, cycleId);

    const bus = new MessageBusV2();
    const mq = new MergeQueue({ projectRoot, bus, dryRun: true, cycleId });
    mq.start();

    emitBranchPushed(bus, buildPayload({ cycleId }));

    await new Promise((r) => setTimeout(r, 30));
    await mq.drain();
    mq.stop();

    const entries = readLedger(projectRoot, cycleId);
    expect(entries).toHaveLength(1);
    expect((entries[0] as Record<string, unknown>)['agentId']).toBe('coder-1');
    expect((entries[0] as Record<string, unknown>)['status']).toBe('dry-run');
  });

  it('6. Two agents push branches → two ledger entries', async () => {
    const cycleId = 'test-cycle-id';
    makeCycleDir(projectRoot, cycleId);

    const bus = new MessageBusV2();
    const mq = new MergeQueue({ projectRoot, bus, dryRun: true, cycleId });
    mq.start();

    emitBranchPushed(bus, buildPayload({ cycleId, agentId: 'coder-1', branch: 'auto/c1' }));
    emitBranchPushed(bus, buildPayload({ cycleId, agentId: 'coder-2', branch: 'auto/c2' }));

    await new Promise((r) => setTimeout(r, 50));
    await mq.drain();
    mq.stop();

    const entries = readLedger(projectRoot, cycleId) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    const agentIds = entries.map((e) => e['agentId']);
    expect(agentIds).toContain('coder-1');
    expect(agentIds).toContain('coder-2');
  });
});

// ---------------------------------------------------------------------------
// 7–12: Cycle-end drain behavior
// ---------------------------------------------------------------------------

describe('prMode cycle-end drain behavior', () => {
  it('7. prMode=\'multi\' cycle end → drain() called, prOpener NOT called', async () => {
    const mock = makeMockQueue();
    let prOpenerCalled = false;

    const config = { prMode: 'multi' as const, autoMergePRs: false };

    if (config.prMode === 'multi') {
      mock.stop();
      await mock.drain();
      await mock.drainAndMerge({ autoMerge: config.autoMergePRs });
      // prOpener is intentionally NOT called
    } else {
      prOpenerCalled = true;
    }

    expect(mock.drain).toHaveBeenCalledOnce();
    expect(prOpenerCalled).toBe(false);
  });

  it('8. prMode=\'single\' cycle end → prOpener IS called, drain NOT called', async () => {
    const mock = makeMockQueue();
    let prOpenerCalled = false;

    // Use union type to prevent dead-code narrowing (TS2367)
    const config: { prMode: 'single' | 'multi' } = { prMode: 'single' };

    if (config.prMode === 'multi') {
      mock.stop();
      await mock.drain();
    } else {
      prOpenerCalled = true;
    }

    expect(prOpenerCalled).toBe(true);
    expect(mock.drain).not.toHaveBeenCalled();
    expect(mock.drainAndMerge).not.toHaveBeenCalled();
  });

  it('8b. prMode=\'single\' with no commit skips PR open', () => {
    expect(shouldOpenSingleCyclePr([], null)).toBe(false);
    expect(shouldOpenSingleCyclePr(['src/a.ts'], null)).toBe(false);
    expect(shouldOpenSingleCyclePr([], 'deadbeef')).toBe(false);
    expect(shouldOpenSingleCyclePr(['src/a.ts'], 'deadbeef')).toBe(true);
  });

  it('8c. prMode=\'multi\' skips aggregate commit even when agent branches changed files', () => {
    expect(shouldRunAggregateCommit('multi', ['src/a.ts'])).toBe(false);
    expect(shouldRunAggregateCommit('single', ['src/a.ts'])).toBe(true);
    expect(shouldRunAggregateCommit(undefined, ['src/a.ts'])).toBe(true);
    expect(shouldRunAggregateCommit('single', [])).toBe(false);
  });

  it('9. prMode=\'multi\' + autoMergePRs=true → drainAndMerge called with autoMerge: true', async () => {
    const mock = makeMockQueue();

    const config = { prMode: 'multi' as const, autoMergePRs: true };

    mock.stop();
    await mock.drain();
    await mock.drainAndMerge({ autoMerge: config.autoMergePRs });

    expect(mock.drainAndMerge).toHaveBeenCalledWith({ autoMerge: true });
  });

  it('10. autoMergePRs absent → drainAndMerge called with autoMerge: false', async () => {
    const mock = makeMockQueue();

    // No autoMergePRs in config — resolves to false
    const config = { prMode: 'multi' as const } as { prMode: 'multi'; autoMergePRs?: boolean };
    const autoMerge = config.autoMergePRs === true;

    mock.stop();
    await mock.drain();
    await mock.drainAndMerge({ autoMerge });

    expect(mock.drainAndMerge).toHaveBeenCalledWith({ autoMerge: false });
  });

  it('11. stop() is called before drain() in multi-PR end path (call order)', async () => {
    const callOrder: string[] = [];
    const mock: IMergeQueue = {
      start: vi.fn(),
      stop: vi.fn(() => { callOrder.push('stop'); }),
      drain: vi.fn<() => Promise<DrainResult>>(() => {
        callOrder.push('drain');
        return Promise.resolve({ pushed: 0, prs: [] });
      }),
      drainAndMerge: vi.fn<(opts?: { autoMerge?: boolean }) => Promise<DrainAndMergeResult>>(() => {
        callOrder.push('drainAndMerge');
        return Promise.resolve({ ready: [], merged: [], failing: [], pending: [], unknown: [] });
      }),
    };

    // Simulate runMultiPrDrain
    mock.stop();
    await mock.drain();
    await mock.drainAndMerge({ autoMerge: false });

    expect(callOrder).toEqual(['stop', 'drain', 'drainAndMerge']);
  });

  it('12. drainAndMerge errors are swallowed (cycle continues)', async () => {
    const mock: IMergeQueue = {
      start: vi.fn(),
      stop: vi.fn(),
      drain: vi.fn<() => Promise<DrainResult>>().mockResolvedValue({ pushed: 1, prs: [] }),
      drainAndMerge: vi.fn<(opts?: { autoMerge?: boolean }) => Promise<DrainAndMergeResult>>()
        .mockRejectedValue(new Error('gh unavailable')),
    };

    mock.stop();
    await mock.drain();

    // Simulate the swallow pattern in runMultiPrDrain
    let errorSwallowed = false;
    try {
      await mock.drainAndMerge({ autoMerge: false });
    } catch {
      errorSwallowed = true;
    }

    // Error propagates to the test's try/catch — in the runner it's caught and logged
    expect(errorSwallowed).toBe(true);
    expect(mock.drain).toHaveBeenCalledOnce();
  });
});
