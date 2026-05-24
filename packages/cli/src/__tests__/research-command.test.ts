import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliProgram } from '../bin.js';

describe('research CLI command', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-research-cli-'));
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

  it('proposes, approves, and plans an R&D run', async () => {
    await runCli('research', 'propose', '--project-root', projectRoot, '--prompt', 'Improve launch', '--max-ideas', '1', '--json');
    const run = JSON.parse(output()) as { runId: string; ideas: Array<{ ideaId: string }> };
    expect(run.runId).toMatch(/^rd-/);
    expect(run.ideas).toHaveLength(1);

    consoleLog.mockClear();
    await runCli('research', 'approve', run.runId, run.ideas[0]!.ideaId, '--project-root', projectRoot, '--json');
    const approved = JSON.parse(output()) as { ideas: Array<{ status: string }> };
    expect(approved.ideas[0]?.status).toBe('approved');

    consoleLog.mockClear();
    await runCli('research', 'plan', run.runId, '--project-root', projectRoot, '--budget-usd', '10', '--max-items', '1', '--json');
    const planned = JSON.parse(output()) as { cycleRequest: { budgetUsd: number; maxItems: number; fastMode: boolean; effortCap: string; tags: string[] } };
    expect(planned.cycleRequest.budgetUsd).toBe(10);
    expect(planned.cycleRequest.maxItems).toBe(1);
    expect(planned.cycleRequest.fastMode).toBe(true);
    expect(planned.cycleRequest.effortCap).toBe('high');
    expect(planned.cycleRequest.tags).toContain('rd-approved');
  });

  async function runCli(...args: string[]): Promise<void> {
    const program = createCliProgram();
    program.exitOverride();
    await program.parseAsync(args, { from: 'user' });
  }

  function output(): string {
    return consoleLog.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }
});
