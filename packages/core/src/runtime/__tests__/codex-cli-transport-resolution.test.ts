import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted(() => ({
  existingPaths: new Set<string>(),
  files: new Map<string, string>(),
  directories: new Map<string, string[]>(),
  realpaths: new Map<string, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => fsMockState.existingPaths.has(path)),
    readFileSync: vi.fn((path: string) => {
      const value = fsMockState.files.get(path);
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return value;
    }),
    readdirSync: vi.fn((path: string) => {
      const value = fsMockState.directories.get(path);
      if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return value;
    }),
    realpathSync: vi.fn((path: string) => fsMockState.realpaths.get(path) ?? path),
  };
});

import {
  CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS,
  CODEX_VERSION_OUTPUT_PATTERN,
  CodexCliTransport,
  buildCodexSpawnCommand,
  isCodexVersionOutputValid,
  resetCodexBinaryIdentityCache,
  resolveCodexBinary,
  resolveCodexCliConfigPath,
  resolveCodexCliPathFromConfig,
  verifyCodexBinaryIdentity,
} from '../transports/codex-cli-transport.js';
import { buildCodexReadinessReport } from '../codex-readiness.js';
import { TransportInvalidRequestError } from '../transport-errors.js';
import type { ExecutionRequest, ExecutionStreamOptions } from '../types.js';

interface MockCodexInvocationResult {
  stdout: string;
  stderr: string;
  outputText: string;
  durationMs: number;
}

interface CodexCliTransportTestAccess {
  invokeCodexCli(
    request: ExecutionRequest,
    options?: ExecutionStreamOptions,
  ): Promise<MockCodexInvocationResult>;
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    agent: {
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      systemPrompt: 'You are a coder.',
      workspaceId: 'default',
    },
    task: 'do something',
    userContent: 'do something',
    modelId: 'claude-sonnet-4-6',
    providerModelProfiles: {
      'codex-cli': { modelId: 'gpt-5.3-codex', effort: 'high' },
    },
    ...overrides,
  };
}

/** Exit 0 with usage but no final message — the transient flake. */
const NO_FINAL_MESSAGE_INVOCATION: MockCodexInvocationResult = {
  stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
  stderr: '',
  outputText: '',
  durationMs: 12,
};

const GOOD_INVOCATION: MockCodexInvocationResult = {
  stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
  stderr: '',
  outputText: 'ok',
  durationMs: 12,
};

function identityRealpath(path: string): string {
  return path;
}

function resetMockFilesystem(): void {
  fsMockState.existingPaths.clear();
  fsMockState.files.clear();
  fsMockState.directories.clear();
  fsMockState.realpaths.clear();
}

function addReadinessProject(projectRoot: string): { projectRoot: string; mcpServerPath: string } {
  const resolvedProjectRoot = resolve(projectRoot);
  const agentsDir = join(resolvedProjectRoot, '.agentforge', 'agents');
  const agentPath = join(agentsDir, 'coder.yaml');
  const mcpServerPath = join(resolvedProjectRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  fsMockState.directories.set(agentsDir, ['coder.yaml']);
  fsMockState.files.set(
    agentPath,
    ['name: Coder', 'model: sonnet', 'system_prompt: You write code.', ''].join('\n'),
  );
  fsMockState.existingPaths.add(mcpServerPath);

  return { projectRoot: resolvedProjectRoot, mcpServerPath };
}

function expectReadinessExecArgs(projectRoot: string): string[] {
  return [
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--cd',
    projectRoot,
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
  ];
}

describe('resolveCodexBinary', () => {
  it('prefers AGENTFORGE_CODEX_BIN over the managed bin dir and PATH', () => {
    const resolution = resolveCodexBinary({
      env: { AGENTFORGE_CODEX_BIN: '/custom/abs/codex-cli' },
      homeDir: '/fake/home',
      exists: () => true, // managed bin also "exists" — the env override must still win
    });

    expect(resolution).toEqual({ command: '/custom/abs/codex-cli', source: 'env-override' });
  });

  it('uses CODEX_CLI_PATH before managed bins and PATH when the path is valid', () => {
    const codexCliPath = '/opt/openai/codex/bin/codex';
    const managedBin = '/fake/home/.agentforge/bin/codex';
    const resolution = resolveCodexBinary({
      env: { CODEX_CLI_PATH: codexCliPath },
      homeDir: '/fake/home',
      exists: (path) => path === codexCliPath || path === managedBin,
      platform: 'linux',
    });

    expect(resolution).toEqual({ command: codexCliPath, source: 'codex-cli-path-env' });
  });

  it('uses CODEX_HOME config.toml CODEX_CLI_PATH before managed bins', () => {
    const codexHome = '/fake/home/.codex';
    const configPath = '/fake/home/.codex/config.toml';
    const appManagedCodex = '/opt/openai/codex/bin/codex';
    const managedBin = '/fake/home/.agentforge/bin/codex';
    const resolution = resolveCodexBinary({
      env: { CODEX_HOME: codexHome },
      homeDir: '/fake/home',
      exists: (path) => [configPath, appManagedCodex, managedBin].includes(path),
      readFile: () => [
        '[mcp_servers.node_repl.env]',
        `CODEX_CLI_PATH = '${appManagedCodex}'`,
        '',
      ].join('\n'),
      realpath: identityRealpath,
      platform: 'linux',
    });

    expect(resolution).toEqual({ command: appManagedCodex, source: 'codex-home-config' });
  });

  it('ignores invalid CODEX_CLI_PATH sources and falls back to the managed bin', () => {
    const codexHome = '/fake/home/.codex';
    const configPath = '/fake/home/.codex/config.toml';
    const managedBin = '/fake/home/.agentforge/bin/codex';
    const resolution = resolveCodexBinary({
      env: {
        CODEX_CLI_PATH: 'relative/codex',
        CODEX_HOME: codexHome,
      },
      homeDir: '/fake/home',
      exists: (path) => path === configPath || path === managedBin,
      readFile: () => 'CODEX_CLI_PATH = "relative/from/config/codex"\n',
      realpath: identityRealpath,
      platform: 'linux',
    });

    expect(resolution).toEqual({ command: managedBin, source: 'managed-bin' });
  });

  it('falls back to ~/.agentforge/bin/codex when it exists', () => {
    const managedBin = join('/fake/home', '.agentforge', 'bin', 'codex');
    const resolution = resolveCodexBinary({
      env: {},
      homeDir: '/fake/home',
      exists: (path) => path === managedBin,
    });

    expect(resolution).toEqual({ command: managedBin, source: 'managed-bin' });
  });

  it('falls back to a plain PATH lookup when no override or managed bin is present', () => {
    const resolution = resolveCodexBinary({
      env: {},
      homeDir: '/fake/home',
      exists: () => false,
    });

    expect(resolution).toEqual({ command: 'codex', source: 'path-lookup' });
  });

  it('ignores a blank AGENTFORGE_CODEX_BIN', () => {
    const resolution = resolveCodexBinary({
      env: { AGENTFORGE_CODEX_BIN: '   ' },
      homeDir: '/fake/home',
      exists: () => false,
    });

    expect(resolution.source).toBe('path-lookup');
  });
});

describe('resolveCodexCliPathFromConfig', () => {
  it('builds the config path from CODEX_HOME when present', () => {
    const codexHome = '/custom/codex-home';

    expect(resolveCodexCliConfigPath({ CODEX_HOME: codexHome }, '/fake/home'))
      .toBe(join(codexHome, 'config.toml'));
  });

  it('builds the config path from homeDir when CODEX_HOME is unset', () => {
    expect(resolveCodexCliConfigPath({}, '/fake/home'))
      .toBe(join('/fake/home', '.codex', 'config.toml'));
  });

  it('extracts a single quoted CODEX_CLI_PATH from CODEX_HOME config', () => {
    const codexHome = '/fake/home/.codex';
    const configPath = '/fake/home/.codex/config.toml';
    const codexCliPath = '/opt/openai/codex/bin/codex';

    expect(resolveCodexCliPathFromConfig({
      env: { CODEX_HOME: codexHome },
      exists: (path) => path === configPath || path === codexCliPath,
      readFile: () => [
        '[mcp_servers.node_repl.env]',
        `CODEX_CLI_PATH = '${codexCliPath}'`,
        '',
      ].join('\n'),
      realpath: identityRealpath,
      platform: 'linux',
    })).toBe(codexCliPath);
  });

  it('ignores CODEX_CLI_PATH outside an MCP env table', () => {
    const codexHome = '/fake/home/.codex';
    const configPath = '/fake/home/.codex/config.toml';
    const codexCliPath = '/opt/openai/codex/bin/codex';

    expect(resolveCodexCliPathFromConfig({
      env: { CODEX_HOME: codexHome },
      exists: (path) => path === configPath || path === codexCliPath,
      readFile: () => [
        'CODEX_CLI_PATH = \'/top-level/codex\'',
        '[profiles.default]',
        `CODEX_CLI_PATH = '${codexCliPath}'`,
        '',
      ].join('\n'),
      realpath: identityRealpath,
      platform: 'linux',
    })).toBeUndefined();
  });

  it('ignores config.toml when the real path escapes CODEX_HOME', () => {
    const codexHome = '/fake/home/.codex';
    const configPath = '/fake/home/.codex/config.toml';
    const codexCliPath = '/opt/openai/codex/bin/codex';

    expect(resolveCodexCliPathFromConfig({
      env: { CODEX_HOME: codexHome },
      exists: (path) => path === configPath || path === codexCliPath,
      readFile: () => `CODEX_CLI_PATH = '${codexCliPath}'\n`,
      realpath: (path) => (path === configPath ? '/tmp/escaped/config.toml' : path),
      platform: 'linux',
    })).toBeUndefined();
  });

  it('accepts a local Windows codex.exe path from config', () => {
    const codexHome = 'C:\\Users\\Agent\\.codex';
    const configPath = 'C:\\Users\\Agent\\.codex\\config.toml';
    const codexCliPath = 'C:\\Users\\Agent\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe';

    expect(resolveCodexCliPathFromConfig({
      env: { CODEX_HOME: codexHome },
      exists: (path) => path === configPath || path === codexCliPath,
      readFile: () => [
        '[mcp_servers.node_repl.env]',
        `CODEX_CLI_PATH = '${codexCliPath}'`,
        '',
      ].join('\n'),
      realpath: identityRealpath,
      platform: 'win32',
    })).toBe(codexCliPath);
  });

  it('rejects Windows UNC executable targets from config', () => {
    const codexHome = 'C:\\Users\\Agent\\.codex';
    const configPath = 'C:\\Users\\Agent\\.codex\\config.toml';
    const uncCodex = '\\\\server\\share\\codex.exe';

    expect(resolveCodexCliPathFromConfig({
      env: { CODEX_HOME: codexHome },
      exists: (path) => path === configPath || path === uncCodex,
      readFile: () => [
        '[mcp_servers.node_repl.env]',
        `CODEX_CLI_PATH = '${uncCodex}'`,
        '',
      ].join('\n'),
      realpath: identityRealpath,
      platform: 'win32',
    })).toBeUndefined();
  });
});

describe('buildCodexSpawnCommand binary resolution', () => {
  it('spawns the AGENTFORGE_CODEX_BIN override on non-Windows platforms', () => {
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'linux',
      env: { AGENTFORGE_CODEX_BIN: '/custom/abs/codex-cli', PATH: '/usr/bin' },
    });

    expect(command.command).toBe('/custom/abs/codex-cli');
    expect(command.args).toEqual(['exec']);
    expect(command.launchKind).toBe('path-command');
    expect(command.env).toMatchObject({ AGENTFORGE_CODEX_BIN: '/custom/abs/codex-cli' });
  });

  it('spawns the CODEX_CLI_PATH executable and injects a default CODEX_HOME', () => {
    const codexCliPath = '/opt/openai/codex/bin/codex';
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'linux',
      env: { CODEX_CLI_PATH: codexCliPath, PATH: '/usr/bin' },
      homeDir: '/fake/home',
      exists: (path) => path === codexCliPath,
    });

    expect(command.command).toBe(codexCliPath);
    expect(command.launchKind).toBe('path-command');
    expect(command.env).toMatchObject({
      CODEX_CLI_PATH: codexCliPath,
      CODEX_HOME: '/fake/home/.codex',
    });
  });

  it('preserves an explicit CODEX_HOME in the spawn environment', () => {
    const codexCliPath = '/opt/openai/codex/bin/codex';
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'linux',
      env: {
        CODEX_CLI_PATH: codexCliPath,
        CODEX_HOME: '/custom/codex-home',
      },
      homeDir: '/fake/home',
      exists: (path) => path === codexCliPath,
    });

    expect(command.env).toMatchObject({ CODEX_HOME: '/custom/codex-home' });
  });

  it('spawns the AGENTFORGE_CODEX_BIN override on Windows without candidate scanning', () => {
    const command = buildCodexSpawnCommand(['--version'], {
      platform: 'win32',
      arch: 'x64',
      candidates: [],
      env: { AGENTFORGE_CODEX_BIN: 'D:\\tools\\codex.exe' },
    });

    expect(command.command).toBe('D:\\tools\\codex.exe');
    expect(command.launchKind).toBe('path-command');
  });

  it('uses the managed ~/.agentforge/bin/codex fallback when present', () => {
    const managedBin = '/fake/home/.agentforge/bin/codex';
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'darwin',
      env: {},
      homeDir: '/fake/home',
      exists: (path) => path === managedBin,
    });

    expect(command.command).toBe(managedBin);
    expect(command.launchKind).toBe('path-command');
  });

  it('defaults to the PATH-looked-up codex when no override exists', () => {
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'linux',
      env: {},
      homeDir: '/fake/home',
      exists: () => false,
    });

    expect(command.command).toBe('codex');
  });
});

describe('buildCodexReadinessReport exec probe transport resolution', () => {
  beforeEach(() => {
    resetMockFilesystem();
  });

  afterEach(() => {
    resetMockFilesystem();
  });

  it('runs the exec probe through the explicit Codex binary with the exact preflight args', () => {
    const { projectRoot, mcpServerPath } = addReadinessProject(join('C:\\', 'repo', 'agentforge'));
    const runCodexExecProbe = vi.fn(() => ({ status: 0, stdout: 'agentforge-codex-readiness-ok\n', stderr: '' }));

    const report = buildCodexReadinessReport({
      projectRoot,
      checkDoctor: false,
      checkLogin: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: {
        AGENTFORGE_CODEX_BIN: 'C:\\tools\\codex.exe',
        PATH: 'C:\\Windows\\System32',
      },
      codexSpawnOptions: {
        platform: 'win32',
        arch: 'x64',
        candidates: ['C:\\ignored\\codex.cmd'],
      },
      runCodexExecProbe,
    });

    expect(report.codexCliLaunchKind).toBe('path-command');
    expect(report.codexExecProbeStatus).toBe('passed');
    expect(report.codexExecProbeLaunchKind).toBe('path-command');
    expect(runCodexExecProbe).toHaveBeenCalledTimes(1);
    expect(runCodexExecProbe).toHaveBeenCalledWith(
      'C:\\tools\\codex.exe',
      expectReadinessExecArgs(projectRoot),
      expect.objectContaining({
        encoding: 'utf8',
        input: 'Reply with exactly: agentforge-codex-readiness-ok',
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: expect.objectContaining({
          AGENTFORGE_CODEX_BIN: 'C:\\tools\\codex.exe',
        }),
      }),
    );
  });

  it('runs the exec probe through the Windows native package instead of the npm shim', () => {
    const { projectRoot, mcpServerPath } = addReadinessProject(join('C:\\', 'repo', 'agentforge'));
    const npmRoot = join('C:\\', 'tools', 'npm');
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
    const packageRealpath = join('C:\\', 'real', 'npm', 'node_modules', '@openai', 'codex');
    const runCodexExecProbe = vi.fn(() => ({ status: 0, stdout: 'agentforge-codex-readiness-ok\n', stderr: '' }));

    fsMockState.existingPaths.add(entrypoint);
    fsMockState.existingPaths.add(nativeExe);
    fsMockState.existingPaths.add(pathDir);
    fsMockState.realpaths.set(packageRoot, packageRealpath);

    const report = buildCodexReadinessReport({
      projectRoot,
      checkDoctor: false,
      checkLogin: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: { PATH: 'C:\\Windows\\System32' },
      codexSpawnOptions: {
        platform: 'win32',
        arch: 'x64',
        candidates: [cmdShim],
      },
      runCodexExecProbe,
    });

    expect(report.codexCliLaunchKind).toBe('windows-native-package');
    expect(report.codexExecProbeStatus).toBe('passed');
    expect(report.codexExecProbeLaunchKind).toBe('windows-native-package');
    expect(runCodexExecProbe).toHaveBeenCalledTimes(1);
    expect(runCodexExecProbe).toHaveBeenCalledWith(
      nativeExe,
      expectReadinessExecArgs(projectRoot),
      expect.objectContaining({
        encoding: 'utf8',
        input: 'Reply with exactly: agentforge-codex-readiness-ok',
        timeout: 60_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: expect.objectContaining({
          CODEX_MANAGED_BY_NPM: '1',
          CODEX_MANAGED_PACKAGE_ROOT: packageRealpath,
          PATH: expect.stringContaining(pathDir),
        }),
      }),
    );
  });

  it('marks the exec probe unresolved and never runs an ambiguous WindowsApps shim fallback', () => {
    const { projectRoot, mcpServerPath } = addReadinessProject(join('C:\\', 'repo', 'agentforge'));
    const runCodexExecProbe = vi.fn(() => ({ status: 0, stdout: 'agentforge-codex-readiness-ok\n', stderr: '' }));

    const report = buildCodexReadinessReport({
      projectRoot,
      checkDoctor: false,
      checkLogin: false,
      codexCliAvailable: true,
      mcpServerPath,
      env: { PATH: 'C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps' },
      codexSpawnOptions: {
        platform: 'win32',
        arch: 'x64',
        candidates: ['C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe'],
      },
      runCodexExecProbe,
    });

    expect(report.codexCliLaunchKind).toBeUndefined();
    expect(report.codexExecProbeChecked).toBe(true);
    expect(report.codexExecProbeOk).toBe(false);
    expect(report.codexExecProbeStatus).toBe('resolution-error');
    expect(report.codexExecProbeMessage).toMatch(/refuses ambiguous WindowsApps\/npm-shim fallback/i);
    expect(runCodexExecProbe).not.toHaveBeenCalled();
  });
});

describe('isCodexVersionOutputValid', () => {
  it('accepts real Codex CLI version output', () => {
    expect(isCodexVersionOutputValid('codex-cli 0.135.0')).toBe(true);
    expect(isCodexVersionOutputValid('codex-cli 0.135.0\n')).toBe(true);
    expect(isCodexVersionOutputValid('codex-cli 1.2 (research preview)')).toBe(true);
  });

  it('rejects output from unrelated binaries that happen to be named codex', () => {
    expect(isCodexVersionOutputValid('0.1.2505172129')).toBe(false);
    expect(isCodexVersionOutputValid('')).toBe(false);
    expect(isCodexVersionOutputValid('OpenAI Codex v1')).toBe(false);
  });
});

describe('verifyCodexBinaryIdentity', () => {
  beforeEach(() => {
    resetCodexBinaryIdentityCache();
  });

  afterEach(() => {
    resetCodexBinaryIdentityCache();
    vi.restoreAllMocks();
  });

  it('accepts a binary whose --version output is "codex-cli 0.135.0"', () => {
    const runVersion = vi.fn(() => ({ status: 0, stdout: 'codex-cli 0.135.0\n' }));

    const identity = verifyCodexBinaryIdentity({
      platform: 'linux',
      env: { AGENTFORGE_CODEX_BIN: '/fake/bin/codex' },
      runVersion,
    });

    expect(identity.ok).toBe(true);
    expect(identity.command).toBe('/fake/bin/codex');
    expect(identity.versionOutput).toBe('codex-cli 0.135.0');
    expect(runVersion).toHaveBeenCalledTimes(1);
  });

  it('rejects an impostor binary and warns with the resolved path and expected pattern', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runVersion = vi.fn(() => ({ status: 0, stdout: '0.1.2505172129\n' }));

    const identity = verifyCodexBinaryIdentity({
      platform: 'linux',
      env: { AGENTFORGE_CODEX_BIN: '/opt/homebrew/bin/codex' },
      runVersion,
    });

    expect(identity.ok).toBe(false);
    expect(identity.reason).toContain('/opt/homebrew/bin/codex');
    expect(identity.reason).toContain('identity validation');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warned = String(warnSpy.mock.calls[0]?.[0]);
    expect(warned).toContain('/opt/homebrew/bin/codex');
    expect(warned).toContain('0.1.2505172129');
    expect(warned).toContain(String(CODEX_VERSION_OUTPUT_PATTERN));
  });

  it('names the PATH-resolved binary in the warning for bare-codex lookups', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const identity = verifyCodexBinaryIdentity({
      platform: 'linux',
      env: { PATH: '/opt/homebrew/bin' },
      exists: () => false, // no managed bin
      runVersion: vi.fn(() => ({ status: 0, stdout: '0.1.2505172129\n' })),
      locateOnPath: () => '/opt/homebrew/bin/codex',
    });

    expect(identity.ok).toBe(false);
    expect(identity.command).toBe('/opt/homebrew/bin/codex');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('/opt/homebrew/bin/codex');
  });

  it('treats a non-zero --version exit as unavailable', () => {
    const identity = verifyCodexBinaryIdentity({
      platform: 'linux',
      env: { AGENTFORGE_CODEX_BIN: '/fake/bin/codex' },
      runVersion: vi.fn(() => ({ status: 1, stdout: '' })),
    });

    expect(identity.ok).toBe(false);
    expect(identity.reason).toContain('exited with status 1');
  });

  it('treats a spawn failure (e.g. ENOENT) as unavailable without throwing', () => {
    const identity = verifyCodexBinaryIdentity({
      platform: 'linux',
      env: { AGENTFORGE_CODEX_BIN: '/missing/codex' },
      runVersion: vi.fn(() => ({
        status: null,
        stdout: '',
        error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      })),
    });

    expect(identity.ok).toBe(false);
    expect(identity.reason).toContain('could not be spawned');
  });

  it('reports unavailable instead of throwing when Windows resolution fails', () => {
    const identity = verifyCodexBinaryIdentity({
      platform: 'win32',
      arch: 'x64',
      candidates: ['C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe'],
      env: { PATH: 'C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps' },
      exists: () => false,
      runVersion: vi.fn(() => ({ status: 0, stdout: 'codex-cli 0.135.0' })),
    });

    expect(identity.ok).toBe(false);
    expect(identity.reason).toMatch(/could not be resolved/i);
  });

  it('caches the verdict per resolved binary so --version is not re-spawned per call', () => {
    const runVersion = vi.fn(() => ({ status: 0, stdout: 'codex-cli 0.140.0' }));
    const options = {
      platform: 'linux' as const,
      env: { AGENTFORGE_CODEX_BIN: '/fake/bin/codex' },
      runVersion,
    };

    expect(verifyCodexBinaryIdentity(options).ok).toBe(true);
    expect(verifyCodexBinaryIdentity(options).ok).toBe(true);
    expect(runVersion).toHaveBeenCalledTimes(1);

    resetCodexBinaryIdentityCache();
    expect(verifyCodexBinaryIdentity(options).ok).toBe(true);
    expect(runVersion).toHaveBeenCalledTimes(2);
  });

  it('also caches negative identity verdicts (one warn per process per binary)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runVersion = vi.fn(() => ({ status: 0, stdout: '0.1.2505172129' }));
    const options = {
      platform: 'linux' as const,
      env: { AGENTFORGE_CODEX_BIN: '/opt/homebrew/bin/codex' },
      runVersion,
    };

    expect(verifyCodexBinaryIdentity(options).ok).toBe(false);
    expect(verifyCodexBinaryIdentity(options).ok).toBe(false);
    expect(runVersion).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('CodexCliTransport no-final-message retry', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the no-final-message flake twice with ~2s/~5s backoff then surfaces the error', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = new CodexCliTransport({ sleep });
    const invokeSpy = vi
      .spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue(NO_FINAL_MESSAGE_INVOCATION as never);

    const err: unknown = await transport.execute(makeRequest()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TransportInvalidRequestError);
    expect((err as Error).message).toBe('codex CLI completed without a final message');
    expect(invokeSpy).toHaveBeenCalledTimes(1 + CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS.length);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2_000, 5_000]);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('retrying in 2000ms');
    expect(String(warnSpy.mock.calls[1]?.[0])).toContain('retrying in 5000ms');
  });

  it('succeeds when a retry produces the final message', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = new CodexCliTransport({ sleep });
    const invokeSpy = vi
      .spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValueOnce(NO_FINAL_MESSAGE_INVOCATION as never)
      .mockResolvedValueOnce(GOOD_INVOCATION as never);

    const result = await transport.execute(makeRequest());

    expect(result.response).toBe('ok');
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('does NOT retry real codex failures (non-zero exit)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = new CodexCliTransport({ sleep });
    const invokeSpy = vi
      .spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockRejectedValue(new Error('codex CLI exited with code 1\nstderr: boom\nstdout: '));

    await expect(transport.execute(makeRequest())).rejects.toThrow(/exited with code 1/);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does NOT retry other invalid-request transport errors', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = new CodexCliTransport({ sleep });
    const invokeSpy = vi
      .spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockRejectedValue(
        new TransportInvalidRequestError('codex exec resume does not support outputSchema.'),
      );

    await expect(transport.execute(makeRequest())).rejects.toThrow(/does not support outputSchema/);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('applies the same retry to the streaming path', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const transport = new CodexCliTransport({ sleep });
    const invokeSpy = vi
      .spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValueOnce(NO_FINAL_MESSAGE_INVOCATION as never)
      .mockResolvedValueOnce(GOOD_INVOCATION as never);

    const result = await transport.executeStreaming(makeRequest());

    expect(result.response).toBe('ok');
    expect(invokeSpy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });
});
