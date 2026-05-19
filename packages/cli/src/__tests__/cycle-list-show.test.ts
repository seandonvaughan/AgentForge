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

  function writeCycle(
    cycleId: string,
    cycleJson: Record<string, unknown>,
    events: Array<Record<string, unknown>> = [],
  ): void {
    const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify(cycleJson, null, 2));
    if (events.length > 0) {
      writeFileSync(join(cycleDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
    }
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
