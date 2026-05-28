import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captures = vi.hoisted(() => ({
  buildCodexReadinessReport: vi.fn(),
}));

vi.mock('@agentforge/core', () => ({
  buildCodexReadinessReport: captures.buildCodexReadinessReport,
}));

import { createCliProgram } from '../bin.js';

describe('agentforge codex readiness', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captures.buildCodexReadinessReport.mockReset();
    captures.buildCodexReadinessReport.mockReturnValue({
      projectRoot: '/tmp/project',
      codexCliAvailable: true,
      mcpServerAvailable: true,
      codexLoginChecked: false,
      codexLoginOk: null,
      agents: [],
      warnings: [],
      ready: true,
    });
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    process.exitCode = undefined;
  });

  it('prints readiness JSON and skips login check with --json --skip-login', async () => {
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['codex', 'readiness', '--json', '--skip-login'], { from: 'user' });

    expect(captures.buildCodexReadinessReport).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      checkLogin: false,
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const stdout = consoleLog.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(JSON.parse(stdout)).toEqual({
      projectRoot: '/tmp/project',
      codexCliAvailable: true,
      mcpServerAvailable: true,
      codexLoginChecked: false,
      codexLoginOk: null,
      agents: [],
      warnings: [],
      ready: true,
    });
  });
});
