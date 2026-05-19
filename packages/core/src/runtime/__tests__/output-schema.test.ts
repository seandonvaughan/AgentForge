import { describe, expect, it } from 'vitest';
import { normalizeStrictOutputSchema } from '../output-schema.js';

describe('normalizeStrictOutputSchema', () => {
  it('requires every property for strict OpenAI/Codex response schemas', () => {
    const normalized = normalizeStrictOutputSchema({
      name: 'implementation_report',
      strict: true,
      schema: {
        type: 'object',
        required: ['files_modified', 'tests_added', 'summary'],
        properties: {
          files_modified: { type: 'array', items: { type: 'string' } },
          tests_added: { type: 'integer' },
          lines_changed: { type: 'integer' },
          summary: { type: 'string' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
    });

    expect(normalized.schema.required).toEqual([
      'files_modified',
      'tests_added',
      'summary',
      'lines_changed',
      'blockers',
    ]);
    expect(normalized.schema.additionalProperties).toBe(false);
  });

  it('preserves explicitly non-strict schemas', () => {
    const schema = {
      name: 'loose',
      strict: false,
      schema: {
        type: 'object' as const,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
      },
    };

    expect(normalizeStrictOutputSchema(schema)).toBe(schema);
  });
});
