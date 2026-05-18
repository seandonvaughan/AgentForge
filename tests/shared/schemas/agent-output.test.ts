import { describe, it, expect } from 'vitest';
import {
  JsonSchemaSchema,
  AgentOutputSchemaSchema,
  ValidatedJsonOutputSchema,
  validateAgainstSchema,
  type JsonSchema,
  type AgentOutputSchema,
  type ValidatedJsonOutput,
} from '../../../packages/shared/src/schemas/agent-output.js';

// ── JsonSchemaSchema ───────────────────────────────────────────────────────

describe('JsonSchemaSchema', () => {
  it('parses a valid JSON schema object', () => {
    const input = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    };
    const result = JsonSchemaSchema.parse(input);
    expect(result.type).toBe('object');
    expect(result.required).toEqual(['name']);
  });

  it('rejects non-object type', () => {
    expect(() => JsonSchemaSchema.parse({ type: 'array', properties: {} })).toThrow();
  });

  it('allows passthrough extra keys', () => {
    const result = JsonSchemaSchema.parse({
      type: 'object',
      properties: {},
      title: 'My Schema',
    });
    expect((result as Record<string, unknown>)['title']).toBe('My Schema');
  });
});

// ── AgentOutputSchemaSchema ────────────────────────────────────────────────

describe('AgentOutputSchemaSchema', () => {
  it('parses a full agent output schema', () => {
    const input = {
      name: 'my-output',
      description: 'test schema',
      schema: { type: 'object', properties: { id: { type: 'string' } } },
      strict: true,
    };
    const result = AgentOutputSchemaSchema.parse(input);
    expect(result.name).toBe('my-output');
    expect(result.strict).toBe(true);
  });

  it('defaults strict to true', () => {
    const result = AgentOutputSchemaSchema.parse({
      name: 'x',
      schema: { type: 'object', properties: {} },
    });
    expect(result.strict).toBe(true);
  });

  it('rejects empty name', () => {
    expect(() =>
      AgentOutputSchemaSchema.parse({
        name: '',
        schema: { type: 'object', properties: {} },
      }),
    ).toThrow();
  });
});

// ── ValidatedJsonOutputSchema ──────────────────────────────────────────────

describe('ValidatedJsonOutputSchema', () => {
  it('parses a valid output record', () => {
    const input: ValidatedJsonOutput = {
      agentId: 'agent-1',
      schemaName: 'result',
      raw: '{"x":1}',
      parsed: { x: 1 },
      ok: true,
      capturedAt: '2026-05-18T00:00:00.000Z',
    };
    const result = ValidatedJsonOutputSchema.parse(input);
    expect(result.ok).toBe(true);
  });

  it('allows optional validationError', () => {
    const result = ValidatedJsonOutputSchema.parse({
      agentId: 'a',
      schemaName: 's',
      raw: 'bad',
      parsed: null,
      ok: false,
      validationError: 'Invalid JSON: ...',
      capturedAt: '2026-05-18T00:00:00.000Z',
    });
    expect(result.validationError).toBe('Invalid JSON: ...');
  });
});

// ── validateAgainstSchema ──────────────────────────────────────────────────

describe('validateAgainstSchema', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
    },
    required: ['name'],
    additionalProperties: false,
  };

  it('returns ok:true for valid JSON matching the schema', () => {
    const result = validateAgainstSchema('{"name":"Alice","age":30}', schema);
    expect(result.ok).toBe(true);
    expect(result.parsed).toEqual({ name: 'Alice', age: 30 });
  });

  it('returns ok:false for invalid JSON', () => {
    const result = validateAgainstSchema('{bad json}', schema);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Invalid JSON:/);
  });

  it('returns ok:false when a required field is missing', () => {
    const result = validateAgainstSchema('{"age":25}', schema);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/name/);
    expect(result.error).toMatch(/required/);
  });

  it('returns ok:false for extra fields when additionalProperties:false', () => {
    const result = validateAgainstSchema('{"name":"Bob","extra":"not-allowed"}', schema);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/extra/);
    expect(result.error).toMatch(/additional property/);
  });

  it('returns ok:true for extra fields when additionalProperties is not false', () => {
    const openSchema: JsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const result = validateAgainstSchema('{"name":"Carol","extra":"ok"}', openSchema);
    expect(result.ok).toBe(true);
  });

  it('returns ok:false when value is not an object', () => {
    const result = validateAgainstSchema('"just-a-string"', schema);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expected an object/);
  });

  it('returns ok:false when value is an array', () => {
    const result = validateAgainstSchema('[]', schema);
    expect(result.ok).toBe(false);
  });
});
