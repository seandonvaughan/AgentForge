import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_NO_FINAL_MESSAGE_RETRY_DELAYS_MS,
  CODEX_VERSION_OUTPUT_PATTERN,
  CodexCliTransport,
  buildCodexSpawnCommand,
  isCodexVersionOutputValid,
  resetCodexBinaryIdentityCache,
  resolveCodexBinary,
  verifyCodexBinaryIdentity,
} from '../transports/codex-cli-transport.js';
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

describe('resolveCodexBinary', () => {
  it('prefers AGENTFORGE_CODEX_BIN over the managed bin dir and PATH', () => {
    const resolution = resolveCodexBinary({
      env: { AGENTFORGE_CODEX_BIN: '/custom/abs/codex-cli' },
      homeDir: '/fake/home',
      exists: () => true, // managed bin also "exists" — the env override must still win
    });

    expect(resolution).toEqual({ command: '/custom/abs/codex-cli', source: 'env-override' });
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
    const managedBin = join('/fake/home', '.agentforge', 'bin', 'codex');
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
