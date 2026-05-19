import { describe, expect, it, vi } from 'vitest';
import { CodexCliTransport } from '../transports/codex-cli-transport.js';
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
});
