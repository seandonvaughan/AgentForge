// packages/core/src/runtime/__tests__/merge-queue-drain-and-merge.test.ts
//
// Unit tests for MergeQueue.drainAndMerge() — the CI-check-aware PR
// promotion and optional auto-merge extension added in v22.3.
//
// Coverage:
//   1. Empty ledger → returns all-empty result
//   2. All checks green → PRs promoted to ready (autoMerge=false default)
//   3. autoMerge=true + all green → PRs merged and ledger updated to 'merged'
//   4. Failing CI check → PR left in 'open', added to result.failing
//   5. Pending CI check → PR left in 'open', added to result.pending
//   6. Mixed status (green/failing/pending) → correct categorization
//   7. Unknown/unavailable CI blocks promotion and merge
//   8. gh pr ready fails → PR moves to failing, not ready
//   9. sequenceBy='priority' → processes by prNumber ascending
//  10. cycleId scoped → reads only the specific cycle's ledger

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MergeQueue } from '../merge-queue.js';
import type { LedgerEntry } from '../merge-queue.js';
import { MessageBusV2 } from '../../message-bus/message-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `mq-dam-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeCycleDir(projectRoot: string, cycleId: string): void {
  mkdirSync(join(projectRoot, '.agentforge', 'cycles', cycleId), { recursive: true });
}

function writeLedger(projectRoot: string, cycleId: string, entries: LedgerEntry[]): void {
  const dir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'agent-prs.json');
  writeFileSync(p, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

function readLedger(projectRoot: string, cycleId: string): LedgerEntry[] {
  const p = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf-8')) as LedgerEntry[];
}

function makeOpenEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    branch: 'auto/coder-1',
    agentId: 'coder-1',
    cycleId: 'cycle-abc',
    itemIds: ['T-001'],
    status: 'open',
    openedAt: '2026-05-17T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock execFile at the node:child_process level.
// We intercept the promisified execFile via vi.mock to control gh responses.
// ---------------------------------------------------------------------------

// We mock the entire child_process module
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: vi.fn(original.execFile),
  };
});

import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

// We need to intercept the promisified version. Since merge-queue.ts uses
// promisify(execFileCb) at module level, we mock childProcess.execFile and
// the promisified version will delegate to our mock.
function mockExecFile(impl: (
  file: string,
  args: string[],
  opts: object,
  cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => void): void {
  vi.mocked(childProcess.execFile).mockImplementation(impl as typeof childProcess.execFile);
}

function makeGhChecksResponse(buckets: string[]): string {
  return buckets.map((b) => b).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let projectRoot: string;
let bus: MessageBusV2;

beforeEach(() => {
  projectRoot = makeTmpDir();
  bus = new MessageBusV2({ workspaceId: 'test' });
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('MergeQueue.drainAndMerge', () => {
  it('1. Empty ledger → returns all-empty result', async () => {
    // No ledger file at all
    const queue = new MergeQueue({ projectRoot, bus, cycleId: 'cycle-abc' });

    const result = await queue.drainAndMerge();

    expect(result.ready).toHaveLength(0);
    expect(result.merged).toHaveLength(0);
    expect(result.failing).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('2. All CI checks green + autoMerge=false → PRs promoted to ready, NOT merged', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 42, cycleId })]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        cb(null, { stdout: makeGhChecksResponse(['pass', 'pass']), stderr: '' });
      } else if (args.includes('ready')) {
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: false });

    expect(result.ready).toContain(42);
    expect(result.merged).toHaveLength(0);
    expect(result.failing).toHaveLength(0);
    expect(result.pending).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });

  it('3. All green + autoMerge=true → PRs merged and ledger updated to \'merged\'', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 42, cycleId })]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        cb(null, { stdout: makeGhChecksResponse(['pass']), stderr: '' });
      } else if (args.includes('ready') || args.includes('merge')) {
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: true });

    expect(result.merged).toContain(42);
    expect(result.ready).toHaveLength(0);

    // Ledger entry should be updated to 'merged'
    const entries = readLedger(projectRoot, cycleId);
    const entry = entries.find((e) => e.prNumber === 42);
    expect(entry?.status).toBe('merged');
  });

  it('4. Failing CI check → PR left open, added to result.failing', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 99, cycleId })]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        cb(null, { stdout: makeGhChecksResponse(['pass', 'fail']), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge();

    expect(result.failing).toContain(99);
    expect(result.ready).toHaveLength(0);
    expect(result.merged).toHaveLength(0);

    // Ledger entry remains 'open'
    const entries = readLedger(projectRoot, cycleId);
    expect(entries.find((e) => e.prNumber === 99)?.status).toBe('open');
  });

  it('5. Pending CI check → PR left open, added to result.pending', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 77, cycleId })]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        cb(null, { stdout: makeGhChecksResponse(['pass', 'pending']), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge();

    expect(result.pending).toContain(77);
    expect(result.ready).toHaveLength(0);
    expect(result.merged).toHaveLength(0);
  });

  it('6. Mixed status (green PR 10, failing PR 11, pending PR 12) → correct categorization', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [
      makeOpenEntry({ prNumber: 10, cycleId, openedAt: '2026-05-17T10:00:00.000Z' }),
      makeOpenEntry({ prNumber: 11, cycleId, openedAt: '2026-05-17T10:01:00.000Z' }),
      makeOpenEntry({ prNumber: 12, cycleId, openedAt: '2026-05-17T10:02:00.000Z' }),
    ]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        const prNumIdx = args.indexOf('checks') + 1;
        const prNum = parseInt(args[prNumIdx] ?? '0', 10);
        if (prNum === 10) {
          cb(null, { stdout: makeGhChecksResponse(['pass', 'pass']), stderr: '' });
        } else if (prNum === 11) {
          cb(null, { stdout: makeGhChecksResponse(['fail']), stderr: '' });
        } else if (prNum === 12) {
          cb(null, { stdout: makeGhChecksResponse(['pending']), stderr: '' });
        } else {
          cb(null, { stdout: '', stderr: '' });
        }
      } else if (args.includes('ready')) {
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: false });

    expect(result.ready).toContain(10);
    expect(result.failing).toContain(11);
    expect(result.pending).toContain(12);
    expect(result.merged).toHaveLength(0);
  });

  it('7. gh pr checks unavailable (execFile throws) → unknown CI blocks promotion', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 55, cycleId })]);

    const calls: string[] = [];
    mockExecFile((file, args, _opts, cb) => {
      calls.push(args.join(' '));
      if (args.includes('checks')) {
        cb(new Error('gh: command not found'), { stdout: '', stderr: '' });
      } else if (args.includes('ready')) {
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: true });

    expect(result.unknown).toContain(55);
    expect(result.ready).toHaveLength(0);
    expect(result.merged).toHaveLength(0);
    expect(result.failing).toHaveLength(0);
    expect(calls.some((call) => call.includes(' ready '))).toBe(false);
    expect(calls.some((call) => call.includes(' merge '))).toBe(false);
  });

  it('7b. empty or unrecognized check buckets → unknown CI blocks promotion', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [
      makeOpenEntry({ prNumber: 56, cycleId }),
      makeOpenEntry({ prNumber: 57, cycleId }),
    ]);

    const calls: string[] = [];
    mockExecFile((file, args, _opts, cb) => {
      calls.push(args.join(' '));
      if (args.includes('checks')) {
        const prNumIdx = args.indexOf('checks') + 1;
        const prNum = parseInt(args[prNumIdx] ?? '0', 10);
        if (prNum === 56) {
          cb(null, { stdout: '', stderr: '' });
        } else {
          cb(null, { stdout: makeGhChecksResponse(['mystery']), stderr: '' });
        }
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: true });

    expect(result.unknown).toEqual([56, 57]);
    expect(result.ready).toHaveLength(0);
    expect(result.merged).toHaveLength(0);
    expect(calls.some((call) => call.includes(' ready '))).toBe(false);
    expect(calls.some((call) => call.includes(' merge '))).toBe(false);
  });

  it('8. gh pr ready fails → PR moved to failing, not in ready', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);
    writeLedger(projectRoot, cycleId, [makeOpenEntry({ prNumber: 33, cycleId })]);

    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        cb(null, { stdout: makeGhChecksResponse(['pass']), stderr: '' });
      } else if (args.includes('ready')) {
        cb(new Error('gh: not authed'), { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    const result = await queue.drainAndMerge({ autoMerge: false });

    expect(result.failing).toContain(33);
    expect(result.ready).toHaveLength(0);
  });

  it('9. sequenceBy=\'priority\' → processes by prNumber ascending (lower first)', async () => {
    const cycleId = 'cycle-abc';
    makeCycleDir(projectRoot, cycleId);

    // PR #5 opened later (would sort last by time), PR #3 opened earlier
    writeLedger(projectRoot, cycleId, [
      makeOpenEntry({ prNumber: 5, cycleId, openedAt: '2026-05-17T10:00:00.000Z' }),
      makeOpenEntry({ prNumber: 3, cycleId, openedAt: '2026-05-17T09:00:00.000Z' }),
    ]);

    const processOrder: number[] = [];
    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        const prNumIdx = args.indexOf('checks') + 1;
        const prNum = parseInt(args[prNumIdx] ?? '0', 10);
        processOrder.push(prNum);
        cb(null, { stdout: makeGhChecksResponse(['pass']), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    const queue = new MergeQueue({ projectRoot, bus, cycleId });
    await queue.drainAndMerge({ sequenceBy: 'priority' });

    // priority = by prNumber ascending → PR #3 before PR #5
    expect(processOrder[0]).toBe(3);
    expect(processOrder[1]).toBe(5);
  });

  it('10. cycleId scoped → reads only the specific cycle\'s ledger, not all cycles', async () => {
    const cycleIdA = 'cycle-aaa';
    const cycleIdB = 'cycle-bbb';
    makeCycleDir(projectRoot, cycleIdA);
    makeCycleDir(projectRoot, cycleIdB);

    writeLedger(projectRoot, cycleIdA, [makeOpenEntry({ prNumber: 100, cycleId: cycleIdA })]);
    writeLedger(projectRoot, cycleIdB, [makeOpenEntry({ prNumber: 200, cycleId: cycleIdB })]);

    const processedPrs: number[] = [];
    mockExecFile((file, args, _opts, cb) => {
      if (args.includes('checks')) {
        const prNumIdx = args.indexOf('checks') + 1;
        const prNum = parseInt(args[prNumIdx] ?? '0', 10);
        processedPrs.push(prNum);
        cb(null, { stdout: makeGhChecksResponse(['pass']), stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    });

    // Scoped to cycleIdA only
    const queue = new MergeQueue({ projectRoot, bus, cycleId: cycleIdA });
    const result = await queue.drainAndMerge({ autoMerge: false });

    // Only cycle-aaa's PR should be processed
    expect(result.ready).toContain(100);
    expect(processedPrs).toContain(100);
    expect(processedPrs).not.toContain(200);
  });
});
