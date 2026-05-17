/**
 * Tests for pr-merge-manager-runner.ts
 *
 * All tests mock `node:child_process` so no real `gh` binary is invoked.
 * The AgentRuntime is mocked via a hand-crafted stub that satisfies the
 * RunOptions → RunResult contract.
 *
 * Test matrix:
 *  1.  Ledger missing          → returns {decisions:[], executed:[], dryRun}
 *  2.  Ledger empty array      → returns {decisions:[], executed:[], dryRun}
 *  3.  All entries non-open    → returns {decisions:[], executed:[], dryRun}
 *  4.  dryRun=true             → decisions returned, gh NOT called
 *  5.  dryRun=false, merge     → gh pr merge called for that PR
 *  6.  dryRun=false, comment   → gh pr comment called with body
 *  7.  dryRun=false, wait      → gh NOT called for wait decision
 *  8.  3 PRs (merge/wait/comment) dryRun=false → all three executed correctly
 *  9.  Malformed JSON response → throws PrMergeManagerParseError
 * 10.  Valid JSON wrong shape  → throws PrMergeManagerParseError
 * 11.  CI fetch error          → falls back to UNKNOWN CI, still runs
 * 12.  gh merge fails          → ExecutedDecision has error field, does not throw
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock node:child_process before importing the module under test.
// vi.mock is hoisted to the top of the file, so mockExecFile must be
// initialised via vi.hoisted() to avoid a "Cannot access before initialization"
// ReferenceError.
// ---------------------------------------------------------------------------

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

// ---------------------------------------------------------------------------
// Now import the module under test (after the mock is in place)
// ---------------------------------------------------------------------------

import {
  runPrMergeManager,
  PrMergeManagerParseError,
  _resetPromptCache,
} from '../pr-merge-manager-runner.js';
import type { AgentRuntime } from '../../agent-runtime/agent-runtime.js';
import type { RunResult } from '../../agent-runtime/types.js';
import type { LedgerEntry } from '../merge-queue.js';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `pmm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLedger(projectRoot: string, cycleId: string, entries: LedgerEntry[]): void {
  const dir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent-prs.json'), JSON.stringify(entries, null, 2));
}

function makeEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    prNumber: 1234,
    prUrl: 'https://github.com/org/repo/pull/1234',
    branch: 'autonomous/agent-coder-abc123',
    agentId: 'fastify-v5-engineer',
    cycleId: 'cycle-v22',
    itemIds: ['P0-add-cancel-endpoint'],
    status: 'open',
    openedAt: '2026-05-17T10:00:00.000Z',
    ...overrides,
  };
}

function makeRunResult(response: string): RunResult {
  return {
    sessionId: 'sess-test',
    response,
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: 'completed',
  };
}

function makeRuntime(response: string): AgentRuntime {
  return {
    run: vi.fn().mockResolvedValue(makeRunResult(response)),
    runStreaming: vi.fn(),
    estimateCost: vi.fn().mockReturnValue(0),
  } as unknown as AgentRuntime;
}

const THREE_PR_RESPONSE = JSON.stringify({
  decisions: [
    { prNumber: 1234, action: 'merge', reason: 'all CI green, no conflicts' },
    { prNumber: 1235, action: 'wait', reason: 'depends on #1234 — check after it lands' },
    {
      prNumber: 1236,
      action: 'comment',
      reason: 'non-trivial conflict, request human review',
      comment:
        '## pr-merge-manager: action required\n\n**Blocking reason:** Conflict in src/api.ts\n**Recommended owner:** human\n**Next step:** Resolve conflict in src/api.ts manually.',
    },
  ],
});

/**
 * Build a promisify-compatible execFile stub.
 * `promisify(execFile)` is used inside the runner, so mockExecFile needs to
 * accept (cmd, args, opts, callback) and call the callback.
 */
function makeExecFileCallback(
  handler: (cmd: string, args: string[]) => { stdout: string; stderr: string } | Error,
): Mock {
  return vi.fn().mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const result = handler(cmd, args);
      if (result instanceof Error) {
        callback(result);
      } else {
        callback(null, result);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPrMergeManager', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
    _resetPromptCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // 1. Ledger file does not exist → empty result
  it('returns empty result when ledger file is missing', async () => {
    const runtime = makeRuntime('{}');
    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: true,
    });
    expect(result.decisions).toHaveLength(0);
    expect(result.executed).toHaveLength(0);
    expect(result.dryRun).toBe(true);
    expect((runtime.run as Mock)).not.toHaveBeenCalled();
  });

  // 2. Ledger exists but is empty array → empty result
  it('returns empty result when ledger is an empty array', async () => {
    writeLedger(projectRoot, 'cycle-v22', []);
    const runtime = makeRuntime('{}');
    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: true,
    });
    expect(result.decisions).toHaveLength(0);
    expect((runtime.run as Mock)).not.toHaveBeenCalled();
  });

  // 3. All entries are non-open (dry-run / skipped) → empty result
  it('returns empty result when all entries are non-open', async () => {
    writeLedger(projectRoot, 'cycle-v22', [
      makeEntry({ status: 'dry-run', prNumber: null }),
      makeEntry({ status: 'skipped-no-gh', prNumber: null, agentId: 'other-engineer' }),
    ]);
    const runtime = makeRuntime('{}');
    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: true,
    });
    expect(result.decisions).toHaveLength(0);
    expect((runtime.run as Mock)).not.toHaveBeenCalled();
  });

  // 4. dryRun=true → decisions returned, gh NOT called
  it('dryRun=true returns decisions without calling gh', async () => {
    // CI fetch will attempt gh — configure execFile to return empty array
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        cb(null, { stdout: '[]' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'merge', reason: 'CI green' }],
    });
    const runtime = makeRuntime(response);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe('merge');
    expect(result.executed).toHaveLength(0);

    // The only gh call allowed is the CI check fetch (not a merge)
    const mergeCalls = (mockExecFile as Mock).mock.calls.filter(
      (c: unknown[]) =>
        Array.isArray(c) &&
        c[0] === 'gh' &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).includes('merge'),
    );
    expect(mergeCalls).toHaveLength(0);
  });

  // 5. dryRun=false, merge action → gh pr merge called
  it('dryRun=false executes merge via gh pr merge', async () => {
    const ghCalls: Array<{ cmd: string; args: string[] }> = [];
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        ghCalls.push({ cmd, args });
        cb(null, { stdout: 'merged' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'merge', reason: 'CI green' }],
    });
    const runtime = makeRuntime(response);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    const mergeCalls = ghCalls.filter(
      (c) => c.args.includes('merge') && c.args.includes('1234'),
    );
    expect(mergeCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.executed[0]!.action).toBe('merge');
    expect(result.executed[0]!.error).toBeUndefined();
  });

  // 6. dryRun=false, comment action → gh pr comment called
  it('dryRun=false executes comment via gh pr comment', async () => {
    const ghCalls: Array<{ cmd: string; args: string[] }> = [];
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        ghCalls.push({ cmd, args });
        cb(null, { stdout: 'commented' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [
        {
          prNumber: 1234,
          action: 'comment',
          reason: 'non-trivial conflict',
          comment: 'Please resolve the conflict in src/api.ts.',
        },
      ],
    });
    const runtime = makeRuntime(response);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    const commentCalls = ghCalls.filter(
      (c) => c.args.includes('comment') && c.args.includes('1234'),
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.executed[0]!.action).toBe('comment');
  });

  // 7. wait action → gh NOT called for that decision
  it('dryRun=false does not call gh for wait decisions', async () => {
    const ghCalls: Array<{ cmd: string; args: string[] }> = [];
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        ghCalls.push({ cmd, args });
        cb(null, { stdout: '[]' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'wait', reason: 'CI still pending' }],
    });
    const runtime = makeRuntime(response);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    const actionCalls = ghCalls.filter(
      (c) => c.args.includes('merge') || c.args.includes('comment'),
    );
    expect(actionCalls).toHaveLength(0);
    expect(result.executed[0]!.action).toBe('wait');
    expect(result.executed[0]!.error).toBeUndefined();
  });

  // 8. Three PRs: merge / wait / comment — all executed correctly
  it('handles three PRs with merge/wait/comment decisions', async () => {
    const ghCalls: Array<{ cmd: string; args: string[] }> = [];
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        ghCalls.push({ cmd, args });
        cb(null, { stdout: 'ok' });
      },
    );

    const entries: LedgerEntry[] = [
      makeEntry({ prNumber: 1234, agentId: 'fastify-v5-engineer' }),
      makeEntry({
        prNumber: 1235,
        agentId: 'db-workspace-engineer',
        branch: 'autonomous/agent-db-workspace-engineer-def456',
        itemIds: ['P1-add-rerun'],
      }),
      makeEntry({
        prNumber: 1236,
        agentId: 'auth-engineer',
        branch: 'autonomous/agent-auth-engineer-ghi789',
        itemIds: ['P2-auth-tokens'],
      }),
    ];
    writeLedger(projectRoot, 'cycle-v22', entries);

    const runtime = makeRuntime(THREE_PR_RESPONSE);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    expect(result.decisions).toHaveLength(3);
    expect(result.executed).toHaveLength(3);

    const mergeExec = result.executed.find((e) => e.prNumber === 1234);
    const waitExec = result.executed.find((e) => e.prNumber === 1235);
    const commentExec = result.executed.find((e) => e.prNumber === 1236);

    expect(mergeExec?.action).toBe('merge');
    expect(waitExec?.action).toBe('wait');
    expect(commentExec?.action).toBe('comment');

    // merge must have triggered gh pr merge 1234
    const mergeCalls = ghCalls.filter(
      (c) => c.args.includes('merge') && c.args.includes('1234'),
    );
    expect(mergeCalls.length).toBeGreaterThanOrEqual(1);

    // comment must have triggered gh pr comment 1236
    const commentCalls = ghCalls.filter(
      (c) => c.args.includes('comment') && c.args.includes('1236'),
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);

    // no merge or comment call for 1235 (wait)
    const waitActionCalls = ghCalls.filter(
      (c) =>
        (c.args.includes('merge') || c.args.includes('comment')) &&
        c.args.includes('1235'),
    );
    expect(waitActionCalls).toHaveLength(0);
  });

  // 9. Malformed JSON → throws PrMergeManagerParseError
  it('throws PrMergeManagerParseError when runtime returns malformed JSON', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        cb(null, { stdout: '[]' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const runtime = makeRuntime('this is not json at all !!!');

    await expect(
      runPrMergeManager({
        projectRoot,
        cycleId: 'cycle-v22',
        runtime,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(PrMergeManagerParseError);
  });

  // 10. Valid JSON but wrong schema → throws PrMergeManagerParseError
  it('throws PrMergeManagerParseError when JSON does not match schema', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        cb(null, { stdout: '[]' });
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    // valid JSON but wrong shape: action is 'approve' (not in enum)
    const badResponse = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'approve', reason: 'looks fine' }],
    });
    const runtime = makeRuntime(badResponse);

    await expect(
      runPrMergeManager({
        projectRoot,
        cycleId: 'cycle-v22',
        runtime,
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(PrMergeManagerParseError);
  });

  // 11. CI fetch errors (gh not authed) → falls back to UNKNOWN CI, still runs
  it('falls back to unknown CI and still processes decisions when gh checks fails', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        if (Array.isArray(args) && args.includes('checks')) {
          // Simulate auth failure
          cb(new Error('gh auth token not found'));
        } else {
          cb(null, { stdout: 'ok' });
        }
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'wait', reason: 'CI unknown, being conservative' }],
    });
    const runtime = makeRuntime(response);

    // Should not throw
    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.action).toBe('wait');

    // The user message passed to the runtime should contain "UNKNOWN"
    const runtimeCall = (runtime.run as Mock).mock.calls[0] as [{ task: string }];
    expect(runtimeCall[0].task).toContain('UNKNOWN');
  });

  // 12. gh merge fails → error field set, does not throw
  it('captures gh merge failure in ExecutedDecision.error without throwing', async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, r?: { stdout: string }) => void) => {
        if (Array.isArray(args) && args.includes('merge')) {
          cb(new Error('gh: PR already merged'));
        } else {
          cb(null, { stdout: '[]' });
        }
      },
    );

    writeLedger(projectRoot, 'cycle-v22', [makeEntry()]);
    const response = JSON.stringify({
      decisions: [{ prNumber: 1234, action: 'merge', reason: 'CI green' }],
    });
    const runtime = makeRuntime(response);

    const result = await runPrMergeManager({
      projectRoot,
      cycleId: 'cycle-v22',
      runtime,
      dryRun: false,
    });

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]!.error).toMatch(/already merged/);
    expect(result.decisions[0]!.action).toBe('merge');
  });
});

// Keep promisify in scope to avoid unused-import lint (it is re-exported by
// the mock infrastructure via the spread of the original module).
void promisify;
