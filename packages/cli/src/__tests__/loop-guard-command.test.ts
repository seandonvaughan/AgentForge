import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliProgram } from '../bin.js';

describe('cycle loop-guard commands', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-loop-guard-cli-'));
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

  it('shows missing state file deterministically', async () => {
    await runCli('cycle', 'loop-guard', 'status', '--project-root', projectRoot);

    const output = stdout();
    expect(output).toContain('[loop-guard] status');
    expect(output).toContain('State file:   missing');
    expect(output).toContain('Halted:       no');
    expect(output).toContain('Failures:     0');
  });

  it('shows corrupt state file deterministically', async () => {
    const statePath = join(projectRoot, '.agentforge', 'loop-state.json');
    mkdirSync(join(projectRoot, '.agentforge'), { recursive: true });
    writeFileSync(statePath, '{ not json');

    await runCli('cycle', 'loop-guard', 'status', '--project-root', projectRoot);

    const output = stdout();
    expect(output).toContain('State file:   corrupt');
    expect(output).toContain('Halted:       no');
    expect(output).toContain('Failures:     0');
  });

  it('shows halted state reason from guard file', async () => {
    const statePath = join(projectRoot, '.agentforge', 'loop-state.json');
    mkdirSync(join(projectRoot, '.agentforge'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      v: 1,
      consecutiveFailedCycles: 3,
      lastCycleId: '12345678-1234-1234-1234-123456789012',
      lastOutcome: 'failed',
      lastUpdatedAt: '2026-05-27T00:00:00.000Z',
      haltedReason: '3 consecutive cycles failed to complete (limit 3).',
    }, null, 2));

    await runCli('cycle', 'loop-guard', 'status', '--project-root', projectRoot);

    const output = stdout();
    expect(output).toContain('State file:   valid');
    expect(output).toContain('Halted:       yes');
    expect(output).toContain('Reason:       3 consecutive cycles failed to complete (limit 3).');
    expect(output).toContain('Failures:     3');
  });

  it('resets loop guard state file to defaults', async () => {
    const statePath = join(projectRoot, '.agentforge', 'loop-state.json');
    mkdirSync(join(projectRoot, '.agentforge'), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      v: 1,
      consecutiveFailedCycles: 99,
      lastCycleId: 'bad',
      lastOutcome: 'failed',
      lastUpdatedAt: '2026-05-27T00:00:00.000Z',
      haltedReason: 'halted',
    }, null, 2));

    await runCli('cycle', 'loop-guard', 'reset', '--project-root', projectRoot);

    const output = stdout();
    expect(output).toContain('[loop-guard] reset');
    expect(output).toContain('State:        reset to defaults');

    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      consecutiveFailedCycles: number;
      lastCycleId: string | null;
      lastOutcome: string | null;
      lastUpdatedAt: string;
      haltedReason?: string;
    };
    expect(saved.consecutiveFailedCycles).toBe(0);
    expect(saved.lastCycleId).toBeNull();
    expect(saved.lastOutcome).toBeNull();
    expect(saved.lastUpdatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(saved.haltedReason).toBeUndefined();
  });

  async function runCli(...args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }

  function stdout(): string {
    return consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }
});
