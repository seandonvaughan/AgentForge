import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe('af-codex-workflows launch options', () => {
  let projectRoot: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
    delete (execFileMock as unknown as Record<PropertyKey, unknown>)[promisify.custom];
  });

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
  });

  it('passes readiness launch options and preserves parsed exec fields', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-mcp-cli-'));
    const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'bin.js');
    mkdirSync(join(projectRoot, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(cliPath, 'console.log("agentforge");\n', 'utf8');

    const readiness = {
      ready: true,
      codexExecProbeChecked: true,
      codexExecProbeOk: true,
      codexExecProbeStatus: 'passed',
      codexExecProbeLaunchKind: 'binary',
      codexExecProbeExitCode: 0,
      codexExecProbeDurationMs: 37,
      codexExecProbeMessage: 'codex exec preflight completed.',
    };
    const execFileAsyncMock = vi.fn(async () => ({
      stdout: JSON.stringify(readiness),
      stderr: '',
    }));
    (execFileMock as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;

    const { afCodexReadiness } = await import('../af-codex-workflows.js');
    const result = await afCodexReadiness({ projectRoot, skipLogin: true, includeDoctor: true }, projectRoot);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject(readiness);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'codex', 'readiness', '--project-root', projectRoot, '--json', '--skip-login', '--doctor'],
      expect.objectContaining({
        cwd: projectRoot,
        timeout: 30_000,
        windowsHide: true,
        env: expect.objectContaining({
          AGENTFORGE_PROJECT_ROOT: projectRoot,
        }),
      }),
    );
  });

  it('skips doctor by default and parses readiness JSON from a degraded CLI exit', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-mcp-cli-'));
    const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'bin.js');
    mkdirSync(join(projectRoot, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(cliPath, 'console.log("agentforge");\n', 'utf8');

    const readiness = {
      ready: false,
      codexExecProbeChecked: true,
      codexExecProbeOk: false,
      codexExecProbeStatus: 'failed',
      codexExecProbeLaunchKind: 'binary',
      codexExecProbeExitCode: 2,
      codexExecProbeDurationMs: 44,
      codexExecProbeMessage: 'codex exec preflight failed.',
    };
    const execFileAsyncMock = vi.fn(async () => {
      const error = new Error('Command failed') as Error & { stdout?: string; stderr?: string; code?: number };
      error.stdout = JSON.stringify(readiness);
      error.stderr = '';
      error.code = 1;
      throw error;
    });
    (execFileMock as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;

    const { afCodexReadiness } = await import('../af-codex-workflows.js');
    const result = await afCodexReadiness({ projectRoot, skipLogin: false }, projectRoot);

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject(readiness);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'codex', 'readiness', '--project-root', projectRoot, '--json', '--skip-doctor'],
      expect.objectContaining({
        cwd: projectRoot,
        timeout: 30_000,
        windowsHide: true,
      }),
    );
  });
});
