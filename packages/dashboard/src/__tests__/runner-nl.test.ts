import { describe, expect, it } from 'vitest';
import {
  deriveTaskFromCommand,
  normalizeNlParseResponse,
  resolveAgentId,
  type RunnerAgentLike,
} from '../lib/util/runner-nl.js';

describe('runner-nl utilities', () => {
  it('normalizes parse envelopes from the /api/v5/nl/parse response', () => {
    const parsed = normalizeNlParseResponse({
      data: {
        parsed: {
          intent: 'run_agent',
          confidence: 0.88,
          rawInput: 'run coder agent: fix tests',
          entities: [{ type: 'agent_name', value: 'coder' }],
        },
        action: {
          method: 'POST',
          path: '/api/v5/agents/run',
          description: 'Run agent: coder',
          params: { agentId: 'coder' },
        },
      },
    });

    expect(parsed).toMatchObject({
      intent: 'run_agent',
      confidence: 0.88,
      rawInput: 'run coder agent: fix tests',
      agentCandidate: 'coder',
      action: { method: 'POST', path: '/api/v5/agents/run', agentId: 'coder' },
    });
    expect(parsed?.entities).toEqual([{ type: 'agent_name', value: 'coder' }]);
  });

  it('returns null when payload is malformed', () => {
    expect(normalizeNlParseResponse({ data: { nope: true } })).toBeNull();
    expect(normalizeNlParseResponse('bad')).toBeNull();
  });

  it('resolves agent ids using exact and normalized matching', () => {
    const agents: RunnerAgentLike[] = [
      { agentId: 'coder' },
      { agentId: 'frontend-dev' },
      { agentId: 'backend_qa' },
    ];

    expect(resolveAgentId('coder', agents)).toBe('coder');
    expect(resolveAgentId('Frontend Dev agent', agents)).toBe('frontend-dev');
    expect(resolveAgentId('backend qa', agents)).toBe('backend_qa');
    expect(resolveAgentId('unknown', agents)).toBeNull();
  });

  it('extracts explicit task content from natural-language run commands', () => {
    expect(deriveTaskFromCommand('run coder agent: fix the flaky auth tests')).toBe(
      'fix the flaky auth tests',
    );
    expect(deriveTaskFromCommand('execute coder to add api tracing')).toBe('add api tracing');
    expect(deriveTaskFromCommand('show me all agents')).toBe('show me all agents');
  });
});
