import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

import { buildCodexReadinessReport } from '../codex-readiness.js';

function makeFakeCodexPackage(): {
  root: string;
  cmdShim: string;
  entrypoint: string;
  packageRoot: string;
  nativeExe: string;
  pathDir: string;
} {
  const root = join(tmpdir(), `agentforge-codex-readiness-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const npmRoot = join(root, 'npm');
  const packageRoot = join(npmRoot, 'node_modules', '@openai', 'codex');
  const entrypoint = join(packageRoot, 'bin', 'codex.js');
  const archRoot = join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
  );
  const nativeExe = join(archRoot, 'codex', 'codex.exe');
  const pathDir = join(archRoot, 'path');
  const cmdShim = join(npmRoot, 'codex.cmd');

  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(archRoot, 'codex'), { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(entrypoint, '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(cmdShim, '@echo off\n', 'utf8');
  writeFileSync(nativeExe, '', 'utf8');

  return { root, cmdShim, entrypoint, packageRoot, nativeExe, pathDir };
}

describe('buildCodexReadinessReport launch options', () => {
  let projectRoot: string | undefined;
  let codexPackage: ReturnType<typeof makeFakeCodexPackage> | undefined;

  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = undefined;
    }
    if (codexPackage) {
      rmSync(codexPackage.root, { recursive: true, force: true });
      codexPackage = undefined;
    }
  });

  it('checks Codex CLI availability through the native Windows executable instead of the npm shim', () => {
    projectRoot = join(tmpdir(), `agentforge-codex-ready-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      ['name: Coder', 'model: sonnet', 'system_prompt: You write code.', ''].join('\n'),
      'utf8',
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n', 'utf8');
    codexPackage = makeFakeCodexPackage();

    spawnSyncMock.mockImplementation((command: string, args: string[]) => {
      if (command === codexPackage?.nativeExe && args[0] === '--version') {
        return { status: 0, stdout: 'codex 0.131.0\n', stderr: '' };
      }
      if (command === codexPackage?.nativeExe && args.includes('exec')) {
        return { status: 0, stdout: '{"type":"message"}\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected command: ${command} ${args.join(' ')}` };
    });

    const report = buildCodexReadinessReport({
      projectRoot,
      checkDoctor: false,
      checkLogin: false,
      mcpServerPath,
      env: { PATH: 'C:\\Windows\\System32' },
      codexSpawnOptions: {
        platform: 'win32',
        arch: 'x64',
        candidates: [codexPackage.cmdShim],
        exists: () => false, // hermetic: ignore any real ~/.agentforge/bin/codex
      },
    } as Parameters<typeof buildCodexReadinessReport>[0] & Record<string, unknown>);

    expect(report.codexCliAvailable).toBe(true);
    expect(report.codexCliLaunchKind).toBe('windows-native-package');
    expect(report.codexExecProbeChecked).toBe(true);
    expect(report.codexExecProbeOk).toBe(true);
    expect(report.codexExecProbeLaunchKind).toBe('windows-native-package');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      codexPackage.nativeExe,
      ['--version'],
      expect.objectContaining({
        stdio: 'ignore',
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_MANAGED_BY_NPM: '1',
          // realpathSync: macOS tmpdir() lives under the /var -> /private/var symlink.
          CODEX_MANAGED_PACKAGE_ROOT: realpathSync(codexPackage.packageRoot),
        }),
      }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      codexPackage.nativeExe,
      expect.arrayContaining(['exec', '--sandbox', 'read-only']),
      expect.objectContaining({
        input: 'Reply with exactly: agentforge-codex-readiness-ok',
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_MANAGED_BY_NPM: '1',
          CODEX_MANAGED_PACKAGE_ROOT: realpathSync(codexPackage.packageRoot),
        }),
      }),
    );
  });

  it('warns but stays ready when codex doctor times out', () => {
    projectRoot = join(tmpdir(), `agentforge-codex-doctor-timeout-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.agentforge', 'agents', 'coder.yaml'),
      ['name: Coder', 'model: sonnet', 'system_prompt: You write code.', ''].join('\n'),
      'utf8',
    );
    const mcpServerPath = join(projectRoot, 'mcp-server.js');
    writeFileSync(mcpServerPath, 'console.log("ok");\n', 'utf8');

    spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
      if (args[0] === '--version') {
        return { status: 0, stdout: 'codex-cli 0.140.0\n', stderr: '' };
      }
      if (args.includes('exec')) {
        return { status: 0, stdout: '{"type":"message"}\n', stderr: '' };
      }
      if (args[0] === 'doctor') {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('spawnSync codex ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        };
      }
      return { status: 1, stdout: '', stderr: `unexpected args: ${args.join(' ')}` };
    });

    const report = buildCodexReadinessReport({
      projectRoot,
      checkLogin: false,
      mcpServerPath,
      env: { AGENTFORGE_CODEX_BIN: '/opt/openai/codex/bin/codex' },
      codexSpawnOptions: { platform: 'linux' },
    });

    expect(report.ready).toBe(true);
    expect(report.codexDoctorChecked).toBe(true);
    expect(report.codexDoctorOk).toBeNull();
    expect(report.warnings.some((warning) => warning.includes('codex doctor timed out'))).toBe(true);
  });
});
