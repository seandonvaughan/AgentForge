import { describe, expect, it } from 'vitest';
import { buildRunDraftFromNl, normalizeNlParseResponse } from '../routes/runner/nl-command';

describe('normalizeNlParseResponse', () => {
  it('normalizes envelope.data payloads', () => {
    const normalized = normalizeNlParseResponse({
      data: {
        parsed: {
          intent: 'run_agent',
          confidence: 0.93,
          rawInput: 'run coder agent to fix tests',
          entities: [{ type: 'agent_name', value: 'coder' }],
        },
        action: {
          method: 'POST',
          path: '/api/v5/agents/run',
          description: 'Run agent',
          params: { agentId: 'coder' },
        },
      },
    });

    expect(normalized?.parsed?.intent).toBe('run_agent');
    expect(normalized?.parsed?.entities?.[0]?.value).toBe('coder');
    expect(normalized?.action?.path).toBe('/api/v5/agents/run');
  });

  it('returns null for malformed payloads', () => {
    expect(normalizeNlParseResponse({ data: { nope: true } })).toBeNull();
    expect(normalizeNlParseResponse(null)).toBeNull();
  });
});

describe('buildRunDraftFromNl', () => {
  it('extracts run task and agent from run_agent intents', () => {
    const draft = buildRunDraftFromNl({
      parsed: {
        intent: 'run_agent',
        rawInput: 'Run the coder agent to investigate stream reconnection flake',
        entities: [{ type: 'agent_name', value: 'coder' }],
      },
    }, '');

    expect(draft).not.toBeNull();
    expect(draft?.agentId).toBe('coder');
    expect(draft?.task).toBe('investigate stream reconnection flake');
    expect(draft?.warnings).toEqual([]);
  });

  it('falls back to full input when no prefix pattern is found', () => {
    const draft = buildRunDraftFromNl({
      parsed: {
        intent: 'run_agent',
        rawInput: 'investigate stream reconnection flake',
        entities: [{ type: 'agent_name', value: 'coder' }],
      },
    }, '');

    expect(draft).not.toBeNull();
    expect(draft?.task).toBe('investigate stream reconnection flake');
    expect(draft?.warnings).toContain('Used the full command as task because no run prefix was detected.');
  });

  it('returns null for non-run intents', () => {
    const draft = buildRunDraftFromNl({
      parsed: {
        intent: 'list_agents',
        rawInput: 'list all agents',
        entities: [],
      },
    }, 'list all agents');

    expect(draft).toBeNull();
  });
});
