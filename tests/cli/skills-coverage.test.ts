import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCliProgram } from '../../packages/cli/src/bin.js';

let testDir: string;
let capturedOutput: string;
let originalLog: any;

beforeEach(() => {
  testDir = join(tmpdir(), `agentforge-skill-test-${Date.now()}`);
  mkdirSync(join(testDir, '.agentforge'), { recursive: true });
  mkdirSync(join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic'), { recursive: true });
  mkdirSync(join(testDir, 'packages', 'skills-catalog', 'skills', 'superpowers'), { recursive: true });
  capturedOutput = '';

  originalLog = console.log;
  console.log = (...args: any[]) => {
    capturedOutput += args.map(a => String(a)).join(' ') + '\n';
  };
});

afterEach(() => {
  console.log = originalLog;
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('skills coverage command', () => {
  it('should exit 0 with missing routing-index gracefully', async () => {
    const program = createCliProgram();
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--project-root', testDir]);

    expect(capturedOutput).toContain('No routing-index.json found');
  });

  it('should read routing-index and count agents per capability tag', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-a',
          capability_tags: ['tag-1', 'tag-2'],
          owns_subsystems: ['sub-a'],
          tier: 'opus',
          priority: 1,
        },
        {
          id: 'agent-b',
          capability_tags: ['tag-1'],
          owns_subsystems: ['sub-b'],
          tier: 'sonnet',
          priority: 2,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));

    const program = createCliProgram();
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--project-root', testDir]);

    expect(capturedOutput).toContain('Skill Coverage Report');
    expect(capturedOutput).toContain('tag-1');
    expect(capturedOutput).toContain('tag-2');
  });

  it('should count skills from catalog files', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-test',
          capability_tags: ['tdd', 'tdd-advanced'],
          owns_subsystems: ['sub-test'],
          tier: 'sonnet',
          priority: 1,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));

    // Create skill files
    writeFileSync(join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic', 'af-tdd.md'), '# TDD Skill');
    writeFileSync(join(testDir, 'packages', 'skills-catalog', 'skills', 'superpowers', 'af-tdd-advanced.md'), '# Advanced TDD');

    const program = createCliProgram();
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--project-root', testDir]);

    expect(capturedOutput).toContain('Skill Coverage Report');
    expect(capturedOutput).toContain('tdd');
    expect(capturedOutput).toContain('tdd-advanced');
  });

  it('should identify bare capabilities with <2 skills and no agents', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-a',
          capability_tags: ['tag-routed'],
          owns_subsystems: ['sub-a'],
          tier: 'sonnet',
          priority: 1,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));

    // Create one skill file for a bare tag
    writeFileSync(
      join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic', 'af-bare-tag.md'),
      '# Bare Tag Skill'
    );

    const program = createCliProgram();
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--project-root', testDir]);

    expect(capturedOutput).toContain('bare-tag');
    expect(capturedOutput).toContain('BARE');
  });

  it('should output JSON with --json flag', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-test',
          capability_tags: ['test-tag'],
          owns_subsystems: ['sub-test'],
          tier: 'sonnet',
          priority: 1,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));
    writeFileSync(
      join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic', 'af-test-tag.md'),
      '# Test Skill'
    );

    const program = createCliProgram();
    const outputBefore = capturedOutput.length;
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--json', '--project-root', testDir]);

    const output = capturedOutput.slice(outputBefore);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    expect(jsonMatch).toBeTruthy();

    const parsed = JSON.parse(jsonMatch![0]);
    expect(parsed.results).toBeDefined();
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('capability_tag');
    expect(parsed.results[0]).toHaveProperty('num_skills');
    expect(parsed.results[0]).toHaveProperty('agents_routed');
    expect(parsed.results[0]).toHaveProperty('is_bare');
  });

  it('should include all tags from both routing-index and skills catalog', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-a',
          capability_tags: ['routed-only'],
          owns_subsystems: ['sub-a'],
          tier: 'sonnet',
          priority: 1,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));
    writeFileSync(
      join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic', 'af-skill-only.md'),
      '# Skill Only'
    );

    const program = createCliProgram();
    const outputBefore = capturedOutput.length;
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--json', '--project-root', testDir]);

    const output = capturedOutput.slice(outputBefore);
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch![0]);

    const tags = parsed.results.map((r: any) => r.capability_tag);
    expect(tags).toContain('routed-only');
    expect(tags).toContain('skill-only');
  });

  it('should list bare capabilities in output', async () => {
    const routingIndexPath = join(testDir, '.agentforge', 'routing-index.json');
    const routingIndex = {
      agents: [
        {
          id: 'agent-a',
          capability_tags: ['tag-a'],
          owns_subsystems: ['sub-a'],
          tier: 'sonnet',
          priority: 1,
        },
      ],
    };

    writeFileSync(routingIndexPath, JSON.stringify(routingIndex, null, 2));

    // Create just one skill file for a bare tag (less than 2)
    writeFileSync(
      join(testDir, 'packages', 'skills-catalog', 'skills', 'anthropic', 'af-bare-1.md'),
      '# Bare Skill 1'
    );

    const program = createCliProgram();
    await program.parseAsync(['node', 'test', 'skills', 'coverage', '--project-root', testDir]);

    expect(capturedOutput).toContain('Bare capabilities');
    expect(capturedOutput).toContain('bare-1');
  });
});
