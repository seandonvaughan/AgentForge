import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexCliTransport, buildCodexSpawnCommand } from '../transports/codex-cli-transport.js';
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

function makeFakeCodexPackage(options: { nativeBinary?: boolean } = {}): {
  root: string;
  cmdShim: string;
  entrypoint: string;
  packageRoot: string;
  nativeExe: string;
  pathDir: string;
} {
  const root = join(tmpdir(), `agentforge-codex-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(entrypoint, '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(cmdShim, '@echo off\n', 'utf8');

  if (options.nativeBinary !== false) {
    mkdirSync(join(archRoot, 'codex'), { recursive: true });
    writeFileSync(nativeExe, '', 'utf8');
  }

  return { root, cmdShim, entrypoint, packageRoot, nativeExe, pathDir };
}

describe('CodexCliTransport.buildCodexArgs', () => {
  it('uses codex exec with json output, cwd, workspace-write sandbox, model, and effort config', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(makeRequest({ cwd: '/repo/worktree' }), '/tmp/last.txt');

    expect(args.slice(0, 6)).toEqual(['--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--json']);
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe(resolve('/repo/worktree'));
    expect(args).toContain('--sandbox');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('gpt-5.3-codex');
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort=high');
    if (process.platform === 'win32') {
      expect(args).toContain('windows.sandbox=elevated');
    }
  });

  it('allows sandbox and output schema overrides', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(
      makeRequest({ codexSandbox: 'read-only' }),
      '/tmp/last.txt',
      '/tmp/schema.json',
    );

    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).not.toContain('windows.sandbox=elevated');
    expect(args).toContain('--output-schema');
    expect(args[args.indexOf('--output-schema') + 1]).toBe('/tmp/schema.json');
  });

  it('uses read-only prompt instructions when sandbox is read-only', () => {
    const transport = new CodexCliTransport();
    const prompt = (transport as unknown as { buildPrompt: (request: ExecutionRequest) => string })
      .buildPrompt(makeRequest({ codexSandbox: 'read-only' }));

    expect(prompt).toContain('sandbox "read-only"');
    expect(prompt).toContain('do not create, edit, delete, or append files');
    expect(prompt).not.toContain('You may create, edit, and delete files');
  });

  it('honors explicit workspace-write sandbox overrides', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(makeRequest({ codexSandbox: 'workspace-write' }), '/tmp/last.txt');

    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });

  it('normalizes relative cwd before passing it to codex --cd', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(makeRequest({ cwd: '.agentforge/worktrees/agent-coder-cycle' }), '/tmp/last.txt');

    expect(args[args.indexOf('--cd') + 1]).toBe(
      resolve('.agentforge/worktrees/agent-coder-cycle'),
    );
  });

  it('threads Codex-native execution options into codex exec args', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(
      makeRequest({
        cwd: '/repo/worktree',
        codexSearch: true,
        codexAddDirs: ['/repo/shared', '/tmp/cache'],
        codexEphemeral: true,
        codexProfile: 'agentforge',
        codexProfileV2: 'ci',
        codexSkipGitRepoCheck: true,
      }),
      '/tmp/last.txt',
    );

    expect(args.slice(0, 4)).toEqual(['--ask-for-approval', 'never', '--search', 'exec']);
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(args[args.indexOf('--profile') + 1]).toBe('agentforge');
    expect(args[args.indexOf('--profile-v2') + 1]).toBe('ci');
    expect(args).not.toContain('--ignore-user-config');
    expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(2);
    expect(args).toContain('/repo/shared');
    expect(args).toContain('/tmp/cache');
  });

  it('builds codex exec resume args with stdin prompt support', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(
      makeRequest({
        codexResumeSessionId: '019e-session',
        codexEphemeral: true,
        codexSkipGitRepoCheck: true,
      }),
      '/tmp/last.txt',
    );

    expect(args.slice(0, 4)).toEqual(['--ask-for-approval', 'never', 'exec', 'resume']);
    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('019e-session');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('--cd');
  });
});

describe('buildCodexSpawnCommand', () => {
  it('preserves explicit env overrides on non-Windows platforms', () => {
    const command = buildCodexSpawnCommand(['exec'], {
      platform: 'linux',
      env: {
        PATH: '/tmp/codex-bin',
        CODEX_HOME: '/tmp/codex-home',
      },
    });

    expect(command.command).toBe('codex');
    expect(command.args).toEqual(['exec']);
    expect(command.env).toMatchObject({
      PATH: '/tmp/codex-bin',
      CODEX_HOME: '/tmp/codex-home',
    });
  });

  it('prefers the native packaged codex.exe on Windows so windowsHide applies to the real process', () => {
    const tmp = makeFakeCodexPackage();
    try {
      const command = buildCodexSpawnCommand(['exec', '--json'], {
        platform: 'win32',
        arch: 'x64',
        candidates: [tmp.cmdShim],
        env: { PATH: 'C:\\Windows\\System32' },
      });

      expect(command.command).toBe(tmp.nativeExe);
      expect(command.args).toEqual(['exec', '--json']);
      expect(command.launchKind).toBe('windows-native-package');
      expect(command.env?.PATH).toContain(tmp.pathDir);
      expect(command.env?.CODEX_MANAGED_BY_NPM).toBe('1');
      expect(command.env?.CODEX_MANAGED_PACKAGE_ROOT).toBe(tmp.packageRoot);
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });

  it('falls back to the Node entrypoint when the native Codex binary is missing', () => {
    const tmp = makeFakeCodexPackage({ nativeBinary: false });
    try {
      const command = buildCodexSpawnCommand(['exec'], {
        platform: 'win32',
        arch: 'x64',
        candidates: [tmp.cmdShim],
        env: { PATH: 'C:\\Windows\\System32' },
      });

      expect(command.command).toBe(process.execPath);
      expect(command.args).toEqual([tmp.entrypoint, 'exec']);
      expect(command.launchKind).toBe('windows-node-entrypoint');
    } finally {
      rmSync(tmp.root, { recursive: true, force: true });
    }
  });

  it('refuses ambiguous WindowsApps aliases instead of falling back to plain codex', () => {
    expect(() => buildCodexSpawnCommand(['exec'], {
      platform: 'win32',
      arch: 'x64',
      candidates: ['C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe'],
      env: { PATH: 'C:\\Users\\Agent\\AppData\\Local\\Microsoft\\WindowsApps' },
    })).toThrow(/Install Codex CLI from npm or provide a resolvable codex\.exe/i);
  });

  it('refuses npm shims when neither native codex.exe nor the node entrypoint is resolvable', () => {
    const root = join(tmpdir(), `agentforge-codex-shim-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cmdShim = join(root, 'codex.cmd');
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(cmdShim, '@echo off\n', 'utf8');

      expect(() => buildCodexSpawnCommand(['exec'], {
        platform: 'win32',
        arch: 'x64',
        candidates: [cmdShim],
        env: { PATH: root },
      })).toThrow(/native packaged codex\.exe or node entrypoint/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('CodexCliTransport.execute', () => {
  it('returns the resolved Codex reasoning effort', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue({
        stdout: '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}\n',
        stderr: '',
        outputText: 'ok',
        durationMs: 12,
      } as never);

    const result = await transport.execute(makeRequest());

    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.effort).toBe('high');
  });

  it('uses model-specific OpenAI pricing for Codex runs', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue({
        stdout: '{"type":"turn.completed","usage":{"input_tokens":1000000,"output_tokens":1000000}}\n',
        stderr: '',
        outputText: 'ok',
        durationMs: 12,
      } as never);

    const result = await transport.execute(makeRequest({
      agent: {
        agentId: 'architect',
        name: 'Architect',
        model: 'opus',
        systemPrompt: 'You are an architect.',
        workspaceId: 'default',
      },
      providerModelProfiles: {
        'codex-cli': { modelId: 'gpt-5.5', effort: 'xhigh' },
      },
    }));

    expect(result.costUsd).toBeCloseTo(35);
  });

  it('adds web search call charges when Codex JSONL reports web_search_call events', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue({
        stdout: [
          '{"type":"turn.completed","usage":{"input_tokens":1000000,"output_tokens":1000000}}',
          '{"type":"item.completed","item":{"type":"web_search_call","id":"search-1"}}',
        ].join('\n'),
        stderr: '',
        outputText: 'ok',
        durationMs: 12,
      } as never);

    const result = await transport.execute(makeRequest({ codexSearch: true }));

    expect(result.costUsd).toBeCloseTo(15.76);
    expect(result.raw).toMatchObject({ webSearchCalls: 1 });
  });

  it('warns when search is enabled but Codex JSONL has no search call count', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue({
        stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
        stderr: '',
        outputText: 'ok',
        durationMs: 12,
      } as never);

    const result = await transport.execute(makeRequest({ codexSearch: true }));

    expect(result.raw).toMatchObject({
      webSearchCalls: 0,
      costWarnings: [
        'Web search tool calls may not be represented in Codex JSONL usage; cost may exclude search tool charges.',
      ],
    });
  });

  it('streams Codex JSONL events and assistant text', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockImplementation(async (_request, options) => {
        options?.onEvent?.({
          type: 'codex_json',
          data: { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
        });
        options?.onChunk?.('partial', 0);
        return {
          stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n',
          stderr: '',
          outputText: 'partial',
          durationMs: 12,
        };
      });
    const chunks: string[] = [];
    const events: string[] = [];

    const result = await transport.executeStreaming(makeRequest(), {
      onChunk: (text) => chunks.push(text),
      onEvent: (event) => events.push(event.type),
    });

    expect(result.response).toBe('partial');
    expect(chunks).toEqual(['partial']);
    expect(events).toContain('start');
    expect(events).toContain('codex_json');
    expect(events).toContain('usage_delta');
  });

  it('passes AbortSignal into the Codex CLI streaming invocation', async () => {
    const transport = new CodexCliTransport();
    const invokeSpy = vi.spyOn(transport as unknown as CodexCliTransportTestAccess, 'invokeCodexCli')
      .mockResolvedValue({
        stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n',
        stderr: '',
        outputText: 'done',
        durationMs: 12,
      } as never);
    const controller = new AbortController();

    await transport.executeStreaming(makeRequest(), { signal: controller.signal });

    expect(invokeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
