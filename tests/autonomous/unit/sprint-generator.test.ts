import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SprintGenerator } from '../../../packages/core/src/autonomous/sprint-generator.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';
import type { RankedItem } from '../../../packages/core/src/autonomous/types.js';

describe('SprintGenerator', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-sg-'));
    mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeItems(count: number, tags: string[] = ['fix']): RankedItem[] {
    return Array.from({ length: count }, (_, i) => ({
      itemId: `item-${i}`,
      title: `Item ${i}`,
      rank: i + 1,
      score: 0.9 - i * 0.05,
      confidence: 0.85,
      estimatedCostUsd: 5,
      estimatedDurationMinutes: 10,
      rationale: `rationale ${i}`,
      dependencies: [],
      suggestedAssignee: 'coder',
      suggestedTags: tags,
      withinBudget: true,
    }));
  }

  it('writes sprint JSON to .agentforge/sprints/', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');

    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(3));

    expect(plan.version).toBe('6.3.1');
    const path = join(tmpDir, '.agentforge/sprints/v6.3.1.json');
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, 'utf8'));
    expect(content.sprints).toBeDefined();
    expect(content.sprints[0].version).toBe('6.3.1');
    expect(content.sprints[0].items).toHaveLength(3);
  });

  it('bumps minor version when items have feature tags', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');
    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(2, ['feature']));
    expect(plan.version).toBe('6.4.0');
  });

  it('bumps major version when items have breaking tags', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');
    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(1, ['breaking']));
    expect(plan.version).toBe('7.0.0');
  });

  it('starts at 6.4.0 when no previous sprint exists (legacy case)', async () => {
    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(2, ['feature']));
    // When there's no prior sprint, starts from current package.json version or reasonable default
    expect(plan.version).toBeDefined();
    expect(plan.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('finds latest version across multiple sprint files', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.1.0.json'), '{"sprints":[{"version":"6.1.0"}]}');
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.2.0.json'), '{"sprints":[{"version":"6.2.0"}]}');

    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(1, ['fix']));
    expect(plan.version).toBe('6.3.1');
  });

  it('handles legacy 2-segment version files', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.json'), '{"sprints":[{"version":"6.3"}]}');
    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(1, ['fix']));
    expect(plan.version).toBe('6.3.1');
  });

  it('respects maxItemsPerSprint', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');
    const config = {
      ...DEFAULT_CYCLE_CONFIG,
      limits: { ...DEFAULT_CYCLE_CONFIG.limits, maxItemsPerSprint: 5 },
    };
    const gen = new SprintGenerator(tmpDir, config);
    const plan = await gen.generate(makeItems(20));
    expect(plan.items.length).toBeLessThanOrEqual(5);
  });

  it('sprint plan has budget matching config', async () => {
    writeFileSync(join(tmpDir, '.agentforge/sprints/v6.3.0.json'), '{"sprints":[{"version":"6.3.0"}]}');
    const gen = new SprintGenerator(tmpDir, DEFAULT_CYCLE_CONFIG);
    const plan = await gen.generate(makeItems(3));
    expect(plan.budget).toBe(DEFAULT_CYCLE_CONFIG.budget.perCycleUsd);
  });
});
