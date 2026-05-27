import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliProgram } from '../bin.js';

interface CompletedLedger {
  version: number;
  entries: Array<{
    itemId: string;
    completedAt: string;
    updatedAt: string;
    cycleId?: string;
    prNumber?: number;
    reason?: string;
  }>;
}

describe('agentforge backlog complete', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-backlog-complete-'));
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

  it('writes and then idempotently updates a completion entry', async () => {
    await runCli([
      'backlog',
      'complete',
      'backlog-dogfood-001',
      '--project-root',
      projectRoot,
      '--cycle',
      'cycle-1',
      '--pr',
      '101',
      '--reason',
      'Merged to main',
    ]);

    const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
    expect(existsSync(ledgerPath)).toBe(true);

    const first = readLedger(ledgerPath);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      itemId: 'backlog-dogfood-001',
      cycleId: 'cycle-1',
      prNumber: 101,
      reason: 'Merged to main',
    });
    const firstCompletedAt = first.entries[0]!.completedAt;

    await runCli([
      'backlog',
      'complete',
      'backlog-dogfood-001',
      '--project-root',
      projectRoot,
      '--cycle',
      'cycle-2',
      '--pr',
      '202',
      '--reason',
      'Re-audited after follow-up',
    ]);

    const second = readLedger(ledgerPath);
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      itemId: 'backlog-dogfood-001',
      cycleId: 'cycle-2',
      prNumber: 202,
      reason: 'Re-audited after follow-up',
      completedAt: firstCompletedAt,
    });
  });

  it.each(['0', '-1', '1.5', '123abc', ' 123', '123 ', '01'])(
    'rejects invalid --pr value %s and does not create completed.json',
    async (prValue) => {
      await runCli([
        'backlog',
        'complete',
        'backlog-dogfood-001',
        '--project-root',
        projectRoot,
        '--pr',
        prValue,
      ]);

      const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
      expect(process.exitCode).toBe(1);
      expect(existsSync(ledgerPath)).toBe(false);
    },
  );

  it('does not corrupt an existing completed.json when --pr is invalid', async () => {
    await runCli([
      'backlog',
      'complete',
      'backlog-existing',
      '--project-root',
      projectRoot,
      '--pr',
      '42',
    ]);

    const ledgerPath = join(projectRoot, '.agentforge', 'backlog', 'completed.json');
    const before = readFileSync(ledgerPath, 'utf8');

    await runCli([
      'backlog',
      'complete',
      'backlog-existing',
      '--project-root',
      projectRoot,
      '--pr',
      '42oops',
      '--reason',
      'should fail',
    ]);

    const after = readFileSync(ledgerPath, 'utf8');
    expect(process.exitCode).toBe(1);
    expect(after).toBe(before);
  });

  async function runCli(args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }

  function readLedger(path: string): CompletedLedger {
    return JSON.parse(readFileSync(path, 'utf8')) as CompletedLedger;
  }
});
