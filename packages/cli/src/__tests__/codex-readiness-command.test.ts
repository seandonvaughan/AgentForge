import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captures = vi.hoisted(() => ({
  buildCodexReadinessReport: vi.fn(),
}));

function makeReadinessReport(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: '/tmp/project',
    codexCliAvailable: true,
    codexCliLaunchKind: 'binary',
    codexExecProbeChecked: true,
    codexExecProbeOk: true,
    codexExecProbeStatus: 'passed',
    codexExecProbeLaunchKind: 'binary',
    codexExecProbeExitCode: 0,
    codexExecProbeDurationMs: 25,
    codexExecProbeMessage: 'codex exec preflight completed.',
    codexDoctorChecked: false,
    codexDoctorOk: null,
    mcpServerAvailable: true,
    mcpServerPath: '/tmp/project/packages/mcp-server/dist/index.js',
    codexLoginChecked: false,
    codexLoginOk: null,
    codexAuthStatus: 'missing',
    codexAuthReason: 'CODEX_HOME/auth.json not found.',
    agents: [],
    warnings: [],
    ready: true,
    ...overrides,
  };
}

vi.mock('@agentforge/core', () => ({
  buildCodexReadinessReport: captures.buildCodexReadinessReport,
}));

import { createCliProgram } from '../bin.js';

describe('agentforge codex readiness', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captures.buildCodexReadinessReport.mockReset();
    captures.buildCodexReadinessReport.mockReturnValue(makeReadinessReport());
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    process.exitCode = undefined;
  });

  it('prints readiness JSON and skips login and doctor checks with --json --skip-login --skip-doctor', async () => {
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['codex', 'readiness', '--json', '--skip-login', '--skip-doctor'], { from: 'user' });

    expect(captures.buildCodexReadinessReport).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      checkLogin: false,
      checkDoctor: false,
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();

    const stdout = consoleLog.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(JSON.parse(stdout)).toEqual(makeReadinessReport());
  });

  it('sets a failing exit code when JSON readiness is not ready', async () => {
    captures.buildCodexReadinessReport.mockReturnValue(makeReadinessReport({
      codexCliAvailable: false,
      ready: false,
      warnings: ['codex CLI missing'],
    }));
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['codex', 'readiness', '--project-root', '/tmp/agentforge', '--json'], { from: 'user' });

    expect(captures.buildCodexReadinessReport).toHaveBeenCalledWith({
      projectRoot: '/tmp/agentforge',
      checkLogin: true,
      checkDoctor: false,
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    const stdout = consoleLog.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(JSON.parse(stdout)).toEqual(makeReadinessReport({
      codexCliAvailable: false,
      ready: false,
      warnings: ['codex CLI missing'],
    }));
  });

  it('runs doctor diagnostics only when --doctor is passed', async () => {
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['codex', 'readiness', '--doctor'], { from: 'user' });

    expect(captures.buildCodexReadinessReport).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      checkLogin: true,
      checkDoctor: true,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('prints human exec readiness and warnings and fails when exec preflight fails', async () => {
    captures.buildCodexReadinessReport.mockReturnValue(makeReadinessReport({
      codexExecProbeOk: false,
      codexExecProbeStatus: 'failed',
      codexExecProbeExitCode: 2,
      codexExecProbeDurationMs: 44,
      codexExecProbeMessage: '[project-root] failed with [redacted-secret]',
      warnings: ['codex exec preflight failed (failed, exit 2): [project-root] failed with [redacted-secret]'],
      ready: true,
    }));
    const program = createCliProgram();
    program.exitOverride();

    await program.parseAsync(['codex', 'readiness'], { from: 'user' });

    expect(captures.buildCodexReadinessReport).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      checkLogin: true,
      checkDoctor: false,
    });
    expect(process.exitCode).toBe(1);

    const stdout = consoleLog.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(stdout).toContain('Codex exec:        failed; status failed; launch binary; exit 2; 44ms; [project-root] failed with [redacted-secret]');
    expect(stdout).toContain('Warnings:');
    expect(stdout).toContain('  - codex exec preflight failed (failed, exit 2): [project-root] failed with [redacted-secret]');
    expect(stdout).not.toContain('sk-testSECRETSECRET1234567890');
  });
});
