/**
 * tests/agents/scorer-evaluator.test.ts
 *
 * Verifies:
 *   1. scorer-evaluator.yaml loads via js-yaml without error.
 *   2. The parsed YAML validates against AgentYamlSchema (Zod).
 *   3. The af-rubric-grade skill resolves via the skills-catalog package.
 *   4. Skill body is within the 800-token budget declared in frontmatter.
 */

import { describe, it, expect } from 'vitest';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentYamlSchema } from '../../packages/core/src/team/agent-yaml/agent-yaml-schema.js';
import { loadSkill, _resetCache } from '../../packages/skills-catalog/src/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Whitespace-based token approximation (conservative upper bound). */
function approxTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// scorer-evaluator YAML
// ---------------------------------------------------------------------------

describe('scorer-evaluator agent YAML', () => {
  const yamlPath = resolve(REPO_ROOT, '.agentforge/agents/scorer-evaluator.yaml');

  it('loads without error via js-yaml', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    expect(() => load(content)).not.toThrow();
  });

  it('validates against AgentYamlSchema', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content);
    const result = AgentYamlSchema.safeParse(parsed);
    expect(result.success, result.success ? '' : JSON.stringify((result as any).error?.issues)).toBe(true);
  });

  it('model is haiku (utility tier)', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content) as Record<string, unknown>;
    expect(parsed.model).toBe('haiku');
  });

  it('skill_ids includes af-rubric-grade', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content) as Record<string, unknown>;
    expect(Array.isArray(parsed.skill_ids)).toBe(true);
    expect(parsed.skill_ids as string[]).toContain('af-rubric-grade');
  });

  it('output_schema name is step_score_batch_v1', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content) as Record<string, unknown>;
    const os = parsed.output_schema as Record<string, unknown> | undefined;
    expect(os).toBeDefined();
    expect(os?.name).toBe('step_score_batch_v1');
  });

  it('output_schema strict is true', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content) as Record<string, unknown>;
    const os = parsed.output_schema as Record<string, unknown> | undefined;
    expect(os?.strict).toBe(true);
  });

  it('output_schema has scores array property', () => {
    const content = readFileSync(yamlPath, 'utf-8');
    const parsed = load(content) as Record<string, unknown>;
    const os = parsed.output_schema as Record<string, unknown> | undefined;
    const schema = os?.schema as Record<string, unknown> | undefined;
    const props = schema?.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    expect(props?.scores).toBeDefined();
    const scores = props?.scores as Record<string, unknown> | undefined;
    expect(scores?.type).toBe('array');
  });
});

// ---------------------------------------------------------------------------
// af-rubric-grade skill
// ---------------------------------------------------------------------------

describe('af-rubric-grade skill', () => {
  it('resolves via skills-catalog loadSkill()', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect(skill).not.toBeNull();
    expect(skill?.frontmatter.id).toBe('af-rubric-grade');
  });

  it('frontmatter version is 1.0.0', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect(skill?.frontmatter.version).toBe('1.0.0');
  });

  it('frontmatter tags include evaluation and scoring', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect(skill?.frontmatter.tags).toContain('evaluation');
    expect(skill?.frontmatter.tags).toContain('scoring');
  });

  it('frontmatter applies_to includes utility', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect(skill?.frontmatter.applies_to).toContain('utility');
  });

  it('skill body is non-empty', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect((skill?.body.length ?? 0)).toBeGreaterThan(100);
  });

  it('skill body is within 800-token budget', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    expect(skill).not.toBeNull();
    const tokens = approxTokens(skill!.body);
    expect(tokens).toBeLessThanOrEqual(800);
  });

  it('skill body contains worked example', () => {
    _resetCache();
    const skill = loadSkill('af-rubric-grade');
    // Body must include a concrete example per spec
    expect(skill?.body).toContain('Worked example');
  });
});
