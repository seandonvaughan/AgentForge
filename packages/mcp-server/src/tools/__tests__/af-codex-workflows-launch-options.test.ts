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

  it('hides Windows subprocess windows when running the AgentForge CLI for readiness', async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-mcp-cli-'));
    const cliPath = join(projectRoot, 'packages', 'cli', 'dist', 'bin.js');
    mkdirSync(join(projectRoot, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(cliPath, 'console.log("agentforge");\n', 'utf8');

    const execFileAsyncMock = vi.fn(async () => ({
      stdout: JSON.stringify({ ready: true }),
      stderr: '',
    }));
    (execFileMock as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;

    const { afCodexReadiness } = await import('../af-codex-workflows.js');
    const result = await afCodexReadiness({ projectRoot, skipLogin: true }, projectRoot);

    expect(result.ok).toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      process.execPath,
      [cliPath, 'codex', 'readiness', '--project-root', projectRoot, '--json', '--skip-login'],
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
});
