/**
 * T4 — Agent-factory output-schema enforcement tests.
 *
 * Covers:
 *   - SchemaValidationError thrown when strict:true + validation failed
 *   - No throw when strict:false + validation failed
 *   - No throw when schemaValidation.ok === true
 *   - Pass-through when no schemaValidation present
 *   - loadAgentConfig carries output_schema → outputSchema on returned config
 */

import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SchemaValidationError,
  assertSchemaValidation,
  loadAgentConfig,
  type AgentOutputSchema,
} from '../../packages/core/src/agent-runtime/agent-factory.js';

// ---------------------------------------------------------------------------
// assertSchemaValidation
// ---------------------------------------------------------------------------

describe('assertSchemaValidation', () => {
  const schema: AgentOutputSchema = { name: 'TaskOutput', strict: true };
  const schemaLoose: AgentOutputSchema = { name: 'TaskOutputLoose', strict: false };
  const schemaNoStrict: AgentOutputSchema = { name: 'TaskOutputDefault' };

  it('throws SchemaValidationError when strict:true and schemaValidation.ok === false', () => {
    expect(() =>
      assertSchemaValidation('my-agent', schema, {
        response: 'not valid json',
        schemaValidation: { ok: false, error: 'expected object' },
      }),
    ).toThrow(SchemaValidationError);
  });

  it('SchemaValidationError carries agentId, schemaName, validationError, rawOutput', () => {
    let caught: SchemaValidationError | undefined;
    try {
      assertSchemaValidation('agent-x', schema, {
        response: 'bad output',
        schemaValidation: { ok: false, error: 'missing required field' },
      });
    } catch (e) {
      caught = e as SchemaValidationError;
    }
    expect(caught).toBeInstanceOf(SchemaValidationError);
    expect(caught?.agentId).toBe('agent-x');
    expect(caught?.schemaName).toBe('TaskOutput');
    expect(caught?.validationError).toBe('missing required field');
    expect(caught?.rawOutput).toBe('bad output');
    expect(caught?.name).toBe('SchemaValidationError');
  });

  it('does NOT throw when strict:false and schemaValidation.ok === false', () => {
    const result = assertSchemaValidation('agent-y', schemaLoose, {
      response: 'bad output',
      schemaValidation: { ok: false, error: 'invalid' },
    });
    expect(result).toBe('bad output');
  });

  it('does NOT throw when strict is omitted (falsy) and validation failed', () => {
    const result = assertSchemaValidation('agent-z', schemaNoStrict, {
      response: 'bad output',
      schemaValidation: { ok: false, error: 'invalid' },
    });
    expect(result).toBe('bad output');
  });

  it('returns raw response when schemaValidation.ok === true', () => {
    const result = assertSchemaValidation('agent-ok', schema, {
      response: '{"status":"done"}',
      schemaValidation: { ok: true },
    });
    expect(result).toBe('{"status":"done"}');
  });

  it('returns raw response (pass-through) when no schemaValidation property', () => {
    const result = assertSchemaValidation('agent-pass', schema, {
      response: 'anything',
    });
    expect(result).toBe('anything');
  });

  it('uses "unknown validation error" fallback when error field is absent', () => {
    let caught: SchemaValidationError | undefined;
    try {
      assertSchemaValidation('agent-no-err', schema, {
        response: '',
        schemaValidation: { ok: false },
      });
    } catch (e) {
      caught = e as SchemaValidationError;
    }
    expect(caught?.validationError).toBe('unknown validation error');
  });
});

// ---------------------------------------------------------------------------
// loadAgentConfig — output_schema forwarded to returned config
// ---------------------------------------------------------------------------

describe('loadAgentConfig — output_schema forwarding', () => {
  let tmpDir: string;

  async function createAgent(
    agentsDir: string,
    id: string,
    yaml: string,
  ): Promise<void> {
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, `${id}.yaml`), yaml, 'utf-8');
  }

  it('carries output_schema → outputSchema on the returned config', async () => {
    tmpDir = await (async () => {
      const d = join(tmpdir(), `af-t4-schema-test-${Date.now()}`);
      await mkdir(d, { recursive: true });
      return d;
    })();
    try {
      const agentsDir = join(tmpDir, 'agents');
      await createAgent(
        agentsDir,
        'schema-agent',
        `name: schema-agent
model: haiku
system_prompt: You are a schema agent.
output_schema:
  name: ScoreOutput
  strict: true
`,
      );

      const config = await loadAgentConfig('schema-agent', tmpDir, {
        injectFreshContext: false,
      });

      expect(config).not.toBeNull();
      expect((config as any).outputSchema).toEqual({
        name: 'ScoreOutput',
        strict: true,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns config without outputSchema when YAML has no output_schema', async () => {
    tmpDir = await (async () => {
      const d = join(tmpdir(), `af-t4-no-schema-test-${Date.now()}`);
      await mkdir(d, { recursive: true });
      return d;
    })();
    try {
      const agentsDir = join(tmpDir, 'agents');
      await createAgent(
        agentsDir,
        'plain-agent',
        `name: plain-agent
model: sonnet
system_prompt: Plain agent without schema.
`,
      );

      const config = await loadAgentConfig('plain-agent', tmpDir, {
        injectFreshContext: false,
      });

      expect(config).not.toBeNull();
      expect((config as any).outputSchema).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
