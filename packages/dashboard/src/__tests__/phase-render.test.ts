// packages/dashboard/src/__tests__/phase-render.test.ts
//
// Unit tests for the phase rendering utility functions used by
// the cycles/[id] detail page to format reviewer responses and
// gate verdicts as human-readable markdown.

import { describe, it, expect } from 'vitest';
import {
  resolveAgentResponseContent,
  agentRunSections,
  markdownSections,
  stripMarkdownFields,
  MARKDOWN_FIELDS,
  ALWAYS_STRIP,
} from '../lib/util/phase-render.js';

// ─── resolveAgentResponseContent ────────────────────────────────────────────

describe('resolveAgentResponseContent', () => {
  it('returns plain markdown unchanged', () => {
    const md = '## Code Review\n\nLooks good overall.\n\n- **MAJOR**: missing tests';
    expect(resolveAgentResponseContent(md)).toBe(md);
  });

  it('extracts verdict + rationale from bare JSON', () => {
    const raw = JSON.stringify({
      verdict: 'APPROVE',
      rationale: 'Sprint v9.0.0 delivers all items.',
    });
    const result = resolveAgentResponseContent(raw);
    expect(result).toBe('**APPROVE**: Sprint v9.0.0 delivers all items.');
  });

  it('extracts verdict + rationale from fenced JSON (newer gate format)', () => {
    const raw =
      '```json\n' +
      JSON.stringify({ verdict: 'APPROVE', rationale: 'All gates pass.' }, null, 2) +
      '\n```';
    const result = resolveAgentResponseContent(raw);
    expect(result).toBe('**APPROVE**: All gates pass.');
  });

  it('handles fenced JSON without a language tag', () => {
    const raw =
      '```\n' +
      JSON.stringify({ verdict: 'REJECT', rationale: 'Tests failing.' }) +
      '\n```';
    const result = resolveAgentResponseContent(raw);
    expect(result).toBe('**REJECT**: Tests failing.');
  });

  it('uppercases verdict in prefix', () => {
    const raw = JSON.stringify({ verdict: 'request_changes', rationale: 'Add tests please.' });
    const result = resolveAgentResponseContent(raw);
    expect(result).toContain('**REQUEST_CHANGES**');
    expect(result).toContain('Add tests please.');
  });

  it('handles rationale-only JSON (no verdict)', () => {
    const raw = JSON.stringify({ rationale: 'Good work overall.' });
    const result = resolveAgentResponseContent(raw);
    // No prefix when verdict is absent
    expect(result).toBe('Good work overall.');
  });

  it('falls back to reason field when rationale is absent', () => {
    const raw = JSON.stringify({ verdict: 'APPROVE', reason: 'Looks clean.' });
    const result = resolveAgentResponseContent(raw);
    expect(result).toBe('**APPROVE**: Looks clean.');
  });

  it('wraps unknown JSON object in fenced code block', () => {
    const raw = JSON.stringify({ foo: 'bar', baz: 42 });
    const result = resolveAgentResponseContent(raw);
    expect(result).toMatch(/^```json\n/);
    expect(result).toContain('"foo": "bar"');
  });

  it('does not alter JSON arrays (returns raw)', () => {
    const raw = '[1, 2, 3]';
    expect(resolveAgentResponseContent(raw)).toBe(raw);
  });

  it('does not alter empty string', () => {
    expect(resolveAgentResponseContent('')).toBe('');
  });
});

// ─── agentRunSections ────────────────────────────────────────────────────────

describe('agentRunSections', () => {
  it('returns empty array when agentRuns is absent', () => {
    expect(agentRunSections({ phase: 'gate' })).toEqual([]);
  });

  it('returns empty array for non-array agentRuns', () => {
    expect(agentRunSections({ agentRuns: 'nope' })).toEqual([]);
  });

  it('filters out runs with no/empty response', () => {
    const data = {
      agentRuns: [
        { agentId: 'a', response: '' },
        { agentId: 'b', response: '   ' },
        { agentId: 'c' },
      ],
    };
    expect(agentRunSections(data)).toHaveLength(0);
  });

  it('resolves gate fenced JSON in agentRun response', () => {
    const raw =
      '```json\n' +
      JSON.stringify({ verdict: 'APPROVE', rationale: 'Sprint ships.' }, null, 2) +
      '\n```';
    const data = { agentRuns: [{ agentId: 'ceo', response: raw }] };
    const result = agentRunSections(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.agentId).toBe('ceo');
    expect(result[0]!.response).toBe('**APPROVE**: Sprint ships.');
  });

  it('passes markdown responses through unchanged', () => {
    const md = '## Review\n\nLooks good.';
    const data = { agentRuns: [{ agentId: 'reviewer', response: md }] };
    const result = agentRunSections(data);
    expect(result[0]!.response).toBe(md);
  });

  it('defaults agentId to "agent" when absent', () => {
    const data = { agentRuns: [{ response: 'hello' }] };
    const result = agentRunSections(data);
    expect(result[0]!.agentId).toBe('agent');
  });
});

// ─── markdownSections ────────────────────────────────────────────────────────

describe('markdownSections', () => {
  it('returns empty array for phase with no markdown fields', () => {
    expect(markdownSections({ phase: 'assign', status: 'completed' })).toEqual([]);
  });

  it('picks up review field', () => {
    const data = { phase: 'review', status: 'completed', review: '## Code Review\nLooks good.' };
    const result = markdownSections(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('review');
    expect(result[0]!.content).toBe(data.review);
  });

  it('skips fields with non-string values', () => {
    const data = { rationale: { nested: 'object' }, review: '## Good' };
    const result = markdownSections(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('review');
  });

  it('skips empty/whitespace-only strings', () => {
    const data = { review: '   ', findings: '' };
    expect(markdownSections(data)).toHaveLength(0);
  });
});

// ─── stripMarkdownFields ──────────────────────────────────────────────────────

describe('stripMarkdownFields', () => {
  it('removes agentRuns unconditionally', () => {
    const data = { phase: 'gate', agentRuns: [{ agentId: 'ceo' }] };
    const result = stripMarkdownFields(data);
    expect(result).not.toHaveProperty('agentRuns');
    expect(result).toHaveProperty('phase', 'gate');
  });

  it('removes itemResults unconditionally', () => {
    const data = { phase: 'execute', itemResults: [1, 2] };
    const result = stripMarkdownFields(data);
    expect(result).not.toHaveProperty('itemResults');
  });

  it('removes markdown string fields that will be rendered', () => {
    const data = { phase: 'review', review: '## Title\nBody' };
    const result = stripMarkdownFields(data);
    expect(result).not.toHaveProperty('review');
    expect(result).toHaveProperty('phase');
  });

  it('keeps markdown fields when value is not a string (will not be rendered)', () => {
    // e.g. a "plan" field that is an object rather than a string
    const data = { phase: 'plan', plan: { sections: ['a', 'b'] } };
    const result = stripMarkdownFields(data);
    expect(result).toHaveProperty('plan');
  });

  it('keeps markdown fields when value is empty string', () => {
    const data = { phase: 'gate', rationale: '' };
    const result = stripMarkdownFields(data);
    // Empty string will not be rendered by markdownSections, so keep it
    expect(result).toHaveProperty('rationale', '');
  });
});

// ─── constants ───────────────────────────────────────────────────────────────

describe('MARKDOWN_FIELDS', () => {
  it('includes all expected phase fields', () => {
    expect(MARKDOWN_FIELDS.has('findings')).toBe(true);      // audit
    expect(MARKDOWN_FIELDS.has('plan')).toBe(true);          // plan
    expect(MARKDOWN_FIELDS.has('strategy')).toBe(true);      // test
    expect(MARKDOWN_FIELDS.has('review')).toBe(true);        // review
    expect(MARKDOWN_FIELDS.has('rationale')).toBe(true);     // gate
    expect(MARKDOWN_FIELDS.has('retrospective')).toBe(true); // learn
    expect(MARKDOWN_FIELDS.has('response')).toBe(true);      // fallback
    expect(MARKDOWN_FIELDS.has('error')).toBe(true);         // failed gate/phase retry message
    expect(MARKDOWN_FIELDS.has('summary')).toBe(true);       // top-level summary string
  });
});

describe('ALWAYS_STRIP', () => {
  it('includes agentRuns and itemResults', () => {
    expect(ALWAYS_STRIP.has('agentRuns')).toBe(true);
    expect(ALWAYS_STRIP.has('itemResults')).toBe(true);
  });
});

// ─── error / summary field handling ───────────────────────────────��──────────

describe('error field in markdownSections', () => {
  it('renders failed gate error as a prose section', () => {
    const data = {
      phase: 'gate',
      status: 'failed',
      error: 'findings for retry: The code reviewer identified a compile-blocking bug.',
    };
    const result = markdownSections(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('error');
    expect(result[0]!.content).toContain('findings for retry');
  });

  it('skips empty error string', () => {
    const data = { phase: 'gate', status: 'failed', error: '' };
    expect(markdownSections(data)).toHaveLength(0);
  });

  it('renders summary field as a prose section', () => {
    const data = { phase: 'execute', summary: '## Summary\n\nAll items completed.' };
    const result = markdownSections(data);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('summary');
  });
});

describe('error field in stripMarkdownFields', () => {
  it('strips a non-empty error string from the raw JSON view', () => {
    const data = { phase: 'gate', status: 'failed', error: 'findings for retry: ...' };
    const result = stripMarkdownFields(data);
    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('status', 'failed');
  });

  it('keeps error field when value is empty (will not be rendered)', () => {
    const data = { phase: 'gate', error: '' };
    const result = stripMarkdownFields(data);
    expect(result).toHaveProperty('error', '');
  });
});
