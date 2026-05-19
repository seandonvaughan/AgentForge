import { describe, expect, it, vi } from 'vitest';
import { CodexCliTransport } from '../transports/codex-cli-transport.js';
import type { ExecutionRequest } from '../types.js';

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

describe('CodexCliTransport.buildCodexArgs', () => {
  it('uses codex exec with json output, cwd, workspace-write sandbox, model, and effort config', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(makeRequest({ cwd: '/repo/worktree' }), '/tmp/last.txt');

    expect(args.slice(0, 6)).toEqual(['--ask-for-approval', 'never', 'exec', '--ignore-user-config', '--ignore-rules', '--json']);
    expect(args).toContain('--cd');
    expect(args[args.indexOf('--cd') + 1]).toBe('/repo/worktree');
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

  it('honors explicit workspace-write sandbox overrides', () => {
    const transport = new CodexCliTransport();
    const args = transport.buildCodexArgs(makeRequest({ codexSandbox: 'workspace-write' }), '/tmp/last.txt');

    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
  });
});

describe('CodexCliTransport.execute', () => {
  it('returns the resolved Codex reasoning effort', async () => {
    const transport = new CodexCliTransport();
    vi.spyOn(transport as unknown as { invokeCodexCli: CodexCliTransport['execute'] }, 'invokeCodexCli')
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
});
