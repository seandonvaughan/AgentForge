import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRequest, ExecutionStreamOptions } from '../types.js';

const spawnMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
    spawnSync: spawnSyncMock,
  };
});

import { CodexCliTransport } from '../transports/codex-cli-transport.js';

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

function makeFakeCodexPackage(): {
  root: string;
  cmdShim: string;
  nativeExe: string;
} {
  const root = join(tmpdir(), `agentforge-codex-spawn-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const npmRoot = join(root, 'npm');
  const packageRoot = join(npmRoot, 'node_modules', '@openai', 'codex');
  const archRoot = join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
  );
  const nativeExe = join(archRoot, 'codex', 'codex.exe');
  const cmdShim = join(npmRoot, 'codex.cmd');

  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(archRoot, 'codex'), { recursive: true });
  mkdirSync(join(archRoot, 'path'), { recursive: true });
  writeFileSync(join(packageRoot, 'bin', 'codex.js'), '#!/usr/bin/env node\n', 'utf8');
  writeFileSync(cmdShim, '@echo off\n', 'utf8');
  writeFileSync(nativeExe, '', 'utf8');

  return { root, cmdShim, nativeExe };
}

describe.skipIf(process.platform !== 'win32')('CodexCliTransport Windows spawn invocation', () => {
  let codexPackage: ReturnType<typeof makeFakeCodexPackage> | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    if (codexPackage) {
      rmSync(codexPackage.root, { recursive: true, force: true });
      codexPackage = undefined;
    }
  });

  it('spawns the resolved native codex.exe with windowsHide and piped stdio', async () => {
    codexPackage = makeFakeCodexPackage();
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: `${codexPackage.cmdShim}\r\n`,
      stderr: '',
    });
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        stdin: EventEmitter & {
          write: (text: string, encoding: string, cb: (err?: Error) => void) => void;
          end: () => void;
        };
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter() as typeof child.stdin;
      child.kill = vi.fn();
      child.stdin.write = vi.fn((_text: string, _encoding: string, cb: (err?: Error) => void) => cb());
      child.stdin.end = vi.fn(() => {
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        if (!outputPath) {
          child.emit('error', new Error('missing --output-last-message'));
          return;
        }
        writeFileSync(outputPath, 'ok', 'utf8');
        child.stdout.emit('data', Buffer.from('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'));
        child.emit('close', 0);
      });
      return child;
    });

    const transport = new CodexCliTransport() as unknown as CodexCliTransportTestAccess;
    const result = await transport.invokeCodexCli(makeRequest({ cwd: '.' }));

    expect(result.outputText).toBe('ok');
    expect(spawnMock).toHaveBeenCalledWith(
      codexPackage.nativeExe,
      expect.arrayContaining(['exec', '--json']),
      expect.objectContaining({
        cwd: resolve('.'),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
    );
  });
});
