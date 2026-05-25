/**
 * skills-injection.test.ts — integration tests verifying that loadAgentConfig
 * splices skill bodies into the system prompt in the correct order.
 *
 * Splice order (verified here):
 *   [base system_prompt from YAML]
 *   ## Skills
 *   <skill 1 body>
 *   ---
 *   <skill 2 body>
 *   ## Fresh Context (this cycle)   ← only when memory entries exist
 *   ## Direct Messages              ← only when adapter provided
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';

import { loadAgentConfig } from '../../packages/core/src/agent-runtime/agent-factory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentYamlShape {
  name: string;
  model: string;
  system_prompt: string;
  skill_ids?: unknown;
  skills?: unknown;
  learnings?: unknown;
}

async function writeAgentYaml(
  agentforgeDir: string,
  agentId: string,
  shape: AgentYamlShape,
): Promise<void> {
  const agentsDir = join(agentforgeDir, 'agents');
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, `${agentId}.yaml`), yaml.dump(shape), 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('loadAgentConfig — skills injection', () => {
  let tempRoot: string;
  let agentforgeDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'skills-inject-test-'));
    agentforgeDir = join(tempRoot, '.agentforge');
    await mkdir(agentforgeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('loads an agent with no skill_ids — prompt unchanged', async () => {
    const basePrompt = 'You are a test agent.';
    await writeAgentYaml(agentforgeDir, 'plain-agent', {
      name: 'plain-agent',
      model: 'sonnet',
      system_prompt: basePrompt,
    });

    const config = await loadAgentConfig('plain-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.systemPrompt).toBe(basePrompt);
    expect(config!.systemPrompt).not.toContain('## Skills');
  });

  it('splices ## Skills section for known skill_ids', async () => {
    const basePrompt = 'You are a skilled test agent.';
    await writeAgentYaml(agentforgeDir, 'skilled-agent', {
      name: 'skilled-agent',
      model: 'sonnet',
      system_prompt: basePrompt,
      skill_ids: ['af-verify-before-done'],
    });

    const config = await loadAgentConfig('skilled-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    const prompt = config!.systemPrompt;

    // Skills section must appear after base prompt
    const skillsIdx = prompt.indexOf('## Skills');
    const baseIdx = prompt.indexOf(basePrompt);
    expect(skillsIdx).toBeGreaterThan(baseIdx);

    // Skill body should contain content from af-verify-before-done
    expect(prompt).toContain('Verify Before Declaring Done');
  });

  it('splices multiple skills separated by ---', async () => {
    await writeAgentYaml(agentforgeDir, 'multi-skill-agent', {
      name: 'multi-skill-agent',
      model: 'sonnet',
      system_prompt: 'Base prompt.',
      skill_ids: ['af-tdd', 'af-verify-before-done'],
    });

    const config = await loadAgentConfig('multi-skill-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    const prompt = config!.systemPrompt;

    expect(prompt).toContain('## Skills');
    // Both skills present
    expect(prompt).toContain('Test-Driven Development');
    expect(prompt).toContain('Verify Before Declaring Done');
    // Separator between skills
    expect(prompt).toContain('---');
  });

  it('splices learnings after skills and before Fresh Context', async () => {
    const memDir = join(agentforgeDir, 'memory');
    await mkdir(memDir, { recursive: true });
    await writeFile(
      join(memDir, 'gate-verdict.jsonl'),
      JSON.stringify({
        id: 'memory-1',
        type: 'gate-verdict',
        value: '[CRITICAL] gate failed last cycle',
        createdAt: new Date().toISOString(),
        tags: ['gate', 'verdict', 'critical'],
      }) + '\n',
      'utf-8',
    );

    await writeAgentYaml(agentforgeDir, 'learning-agent', {
      name: 'learning-agent',
      model: 'sonnet',
      system_prompt: 'Base prompt.',
      skill_ids: ['af-verify-before-done'],
      learnings: ['Always preserve agent learnings.', 'Prefer durable lessons over transient notes.'],
    });

    const config = await loadAgentConfig('learning-agent', agentforgeDir, {
      injectFreshContext: true,
    });

    expect(config).not.toBeNull();
    const prompt = config!.systemPrompt;
    expect(prompt).toContain('## Learnings');
    expect(prompt).toContain('Always preserve agent learnings.');
    expect(prompt).toContain('Prefer durable lessons over transient notes.');

    const skillsIdx = prompt.indexOf('## Skills');
    const learningsIdx = prompt.indexOf('## Learnings');
    const freshIdx = prompt.indexOf('## Fresh Context');
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(learningsIdx).toBeGreaterThan(-1);
    expect(freshIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeLessThan(learningsIdx);
    expect(learningsIdx).toBeLessThan(freshIdx);
  });

  it('ignores malformed learnings without dropping the agent config', async () => {
    await writeAgentYaml(agentforgeDir, 'bad-learning-agent', {
      name: 'bad-learning-agent',
      model: 'sonnet',
      system_prompt: 'Base prompt.',
      learnings: { lesson: 'not an array' },
    });

    const config = await loadAgentConfig('bad-learning-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.systemPrompt).toBe('Base prompt.');
    expect(config!.systemPrompt).not.toContain('## Learnings');
  });

  it('normalizes multiline learnings into single prompt bullets', async () => {
    await writeAgentYaml(agentforgeDir, 'multiline-learning-agent', {
      name: 'multiline-learning-agent',
      model: 'sonnet',
      system_prompt: 'Base prompt.',
      learnings: ['Preserve context\nDo not drop memory\tentries'],
    });

    const config = await loadAgentConfig('multiline-learning-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.systemPrompt).toContain('## Learnings');
    expect(config!.systemPrompt).toContain('- Preserve context Do not drop memory entries');
    expect(config!.systemPrompt).not.toContain('Preserve context\nDo not drop');
  });

  it('skills section appears BEFORE ## Fresh Context', async () => {
    const memDir = join(agentforgeDir, 'memory');
    await mkdir(memDir, { recursive: true });
    const entry = JSON.stringify({
      id: 'test-entry',
      type: 'gate-verdict',
      value: '[CRITICAL] gate failed last cycle',
      createdAt: new Date().toISOString(),
      tags: ['gate', 'verdict', 'critical'],
    });
    await writeFile(join(memDir, 'gate-verdict.jsonl'), entry + '\n', 'utf-8');

    await writeAgentYaml(agentforgeDir, 'gate-agent', {
      name: 'gate-agent',
      model: 'sonnet',
      system_prompt: 'Gate agent base.',
      skill_ids: ['af-verify-before-done'],
    });

    const config = await loadAgentConfig('gate-agent', agentforgeDir, {
      injectFreshContext: true,
    });

    expect(config).not.toBeNull();
    const prompt = config!.systemPrompt;

    const skillsIdx = prompt.indexOf('## Skills');
    const freshIdx = prompt.indexOf('## Fresh Context');

    // Both sections must be present
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(freshIdx).toBeGreaterThan(-1);
    // Skills before Fresh Context
    expect(skillsIdx).toBeLessThan(freshIdx);
  });

  it('silently skips unknown skill_ids — no throw, no failure', async () => {
    await writeAgentYaml(agentforgeDir, 'unknown-skill-agent', {
      name: 'unknown-skill-agent',
      model: 'sonnet',
      system_prompt: 'Unknown skill agent.',
      skill_ids: ['skill-that-does-not-exist-xyz'],
    });

    // Must not throw
    const config = await loadAgentConfig('unknown-skill-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    // No skills section since the only skill was unknown
    expect(config!.systemPrompt).not.toContain('## Skills');
    // Base prompt preserved
    expect(config!.systemPrompt).toContain('Unknown skill agent.');
  });

  it('uses skill_ids as canonical and ignores legacy skills when both are present', async () => {
    await writeAgentYaml(agentforgeDir, 'canonical-agent', {
      name: 'canonical-agent',
      model: 'sonnet',
      system_prompt: 'Canonical skill agent.',
      skill_ids: ['af-verify-before-done'],
      skills: ['test_generation'],
    });

    const config = await loadAgentConfig('canonical-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.skillIds).toEqual(['af-verify-before-done']);
    expect(config!.resolvedSkills!.map((skill) => skill.id)).toEqual(['af-verify-before-done']);
    expect(config!.missingSkillIds).toEqual([]);
    expect(config!.systemPrompt).toContain('Verify Before Declaring Done');
    expect(config!.systemPrompt).not.toContain('Test-Driven Development');
  });

  it('maps legacy skills only when skill_ids are absent', async () => {
    await writeAgentYaml(agentforgeDir, 'legacy-agent', {
      name: 'legacy-agent',
      model: 'sonnet',
      system_prompt: 'Legacy skill agent.',
      skills: ['test_generation', 'code_review'],
    });

    const config = await loadAgentConfig('legacy-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.skillIds).toEqual(['af-tdd', 'af-verify-before-done']);
    expect(config!.resolvedSkills!.map((skill) => skill.id)).toEqual([
      'af-tdd',
      'af-verify-before-done',
    ]);
    expect(config!.systemPrompt).toContain('Test-Driven Development');
    expect(config!.systemPrompt).toContain('Verify Before Declaring Done');
  });

  it('exposes missing skill_ids while injecting the skills that resolve', async () => {
    await writeAgentYaml(agentforgeDir, 'partial-agent', {
      name: 'partial-agent',
      model: 'sonnet',
      system_prompt: 'Partial skill agent.',
      skill_ids: ['af-verify-before-done', 'missing-skill-id'],
    });

    const config = await loadAgentConfig('partial-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.skillIds).toEqual(['af-verify-before-done', 'missing-skill-id']);
    expect(config!.resolvedSkills!.map((skill) => skill.id)).toEqual(['af-verify-before-done']);
    expect(config!.missingSkillIds).toEqual(['missing-skill-id']);
    expect(config!.systemPrompt).toContain('Verify Before Declaring Done');
    expect(config!.systemPrompt).not.toContain('missing-skill-id');
  });

  it('exposes the union of required tools from resolved skill metadata', async () => {
    await writeAgentYaml(agentforgeDir, 'tools-agent', {
      name: 'tools-agent',
      model: 'sonnet',
      system_prompt: 'Tool widening agent.',
      skill_ids: ['af-tdd', 'af-rubric-grade'],
    });

    const config = await loadAgentConfig('tools-agent', agentforgeDir, {
      injectFreshContext: false,
    });

    expect(config).not.toBeNull();
    expect(config!.requiredTools).toEqual(['Bash', 'Edit', 'Read', 'Write']);
    expect(config!.resolvedSkills).toEqual([
      expect.objectContaining({
        id: 'af-tdd',
        requiredTools: ['Bash', 'Write', 'Edit'],
      }),
      expect.objectContaining({
        id: 'af-rubric-grade',
        requiredTools: ['Read'],
      }),
    ]);
  });

  it('returns null for a non-existent agent — no crash', async () => {
    const config = await loadAgentConfig('no-such-agent', agentforgeDir, {
      injectFreshContext: false,
    });
    expect(config).toBeNull();
  });
});
