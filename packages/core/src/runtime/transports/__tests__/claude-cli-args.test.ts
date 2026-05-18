import { describe, expect, it } from 'vitest';
import { ClaudeCodeCompatTransport } from '../claude-code-compat-transport.js';
import type { ExecutionRequest } from '../../types.js';

const baseRequest: ExecutionRequest = {
  agent: {
    agentId: 'gate-tester',
    name: 'Gate Tester',
    model: 'sonnet',
    systemPrompt: 'You are a gate reviewer.',
    workspaceId: 'ws-1',
  },
  task: 'gate',
  userContent: '...',
  modelId: 'claude-sonnet-4-6',
};

function buildArgs(req: ExecutionRequest, format: 'json' | 'stream-json' = 'json'): string[] {
  const t = new ClaudeCodeCompatTransport();
  return (t as unknown as { buildClaudeArgs: (r: ExecutionRequest, f: string) => string[] }).buildClaudeArgs(req, format);
}

describe('ClaudeCodeCompatTransport.buildClaudeArgs', () => {
  it('passes --setting-sources project,local so user-level output-style plugins do not inject prose preambles', () => {
    const args = buildArgs(baseRequest);
    const idx = args.indexOf('--setting-sources');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('project,local');
  });

  it('still passes --system-prompt with the agent prompt', () => {
    const args = buildArgs(baseRequest);
    const idx = args.indexOf('--system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('You are a gate reviewer.');
  });

  it('includes --no-session-persistence to keep spawned sessions ephemeral', () => {
    expect(buildArgs(baseRequest)).toContain('--no-session-persistence');
  });

  it('adds streaming flags when format is stream-json', () => {
    const args = buildArgs(baseRequest, 'stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--exclude-dynamic-system-prompt-sections');
  });
});
