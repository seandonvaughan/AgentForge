import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const captures = vi.hoisted(() => ({
  generateCostReport: vi.fn(),
}));

vi.mock('@agentforge/core', () => ({
  generateCostReport: captures.generateCostReport,
}));

import { registerCostsCommand } from '../commands/costs.js';

describe('agentforge costs report --json', () => {
  let projectRoot: string;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-costs-json-'));
    captures.generateCostReport.mockReset();
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('prints empty cost reports as machine-readable JSON', async () => {
    captures.generateCostReport.mockResolvedValue({
      source: 'empty',
      sessionsRecorded: 0,
      totalSpentUsd: 0,
      totalAgentRuns: 0,
      perAgent: [],
      perModel: [],
      pricingReference: {},
    });

    await runCli('costs', 'report', '--json', '--project-root', projectRoot);

    expect(captures.generateCostReport).toHaveBeenCalledWith(projectRoot);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const parsed = JSON.parse(output()) as {
      source: string;
      totalSpentUsd: number;
      perAgent: unknown[];
      pricingReference: Record<string, unknown>;
    };
    expect(parsed.source).toBe('empty');
    expect(parsed.totalSpentUsd).toBe(0);
    expect(Array.isArray(parsed.perAgent)).toBe(true);
    expect(parsed.perAgent).toHaveLength(0);
    expect(parsed.pricingReference).toEqual({});
    expect(output()).not.toContain('AgentForge Cost Report');
    expect(output()).not.toContain('Per-agent:');
  });

  it('prints workspace cost reports as machine-readable JSON', async () => {
    captures.generateCostReport.mockResolvedValue({
      source: 'workspace-db',
      sessionsRecorded: 3,
      totalSpentUsd: 1.2345,
      totalAgentRuns: 5,
      perAgent: [{ label: 'test-agent', totalUsd: 1.2345, runs: 5 }],
      perModel: [],
      pricingReference: {},
    });

    await runCli('costs', 'report', '--json', '--project-root', projectRoot);

    expect(captures.generateCostReport).toHaveBeenCalledWith(projectRoot);
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const parsed = JSON.parse(output()) as {
      sessionsRecorded: number;
      perAgent: Array<{ label: string; totalUsd: number }>;
    };
    expect(parsed.sessionsRecorded).toBe(3);
    expect(parsed.perAgent[0]?.label).toBe('test-agent');
    expect(parsed.perAgent[0]?.totalUsd).toBe(1.2345);
    expect(output()).not.toContain('AgentForge Cost Report');
    expect(output()).not.toContain('Per-agent:');
  });

  async function runCli(...args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCostsCommand(program);
    await program.parseAsync(args, { from: 'user' });
  }

  function output(): string {
    return consoleLog.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
  }
});
