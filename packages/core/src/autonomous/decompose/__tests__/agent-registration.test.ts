import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const ROOT = process.cwd(); // tests run from repo root

describe('epic-planner agent registration', () => {
  it('agent yaml exists, is Opus, strategic', () => {
    const y = load(readFileSync(join(ROOT, '.agentforge/agents/epic-planner.yaml'), 'utf8')) as any;
    expect(y.name).toBe('epic-planner');
    expect(y.model).toBe('opus');
    expect(y.team).toBe('strategic');
    expect(typeof y.system_prompt).toBe('string');
    expect(y.system_prompt.length).toBeGreaterThan(100);
  });

  it('claude agent md (when generated) has opus frontmatter', () => {
    // `.claude/` is gitignored; the .md is generated from the committed
    // .agentforge yaml. Assert it only when present so a fresh checkout (CI)
    // does not fail — the committed-yaml test above is the authoritative
    // opus check (project lesson #7: assert behaviour, not generated files).
    const mdPath = join(ROOT, '.claude/agents/epic-planner.md');
    if (!existsSync(mdPath)) return;
    const md = readFileSync(mdPath, 'utf8');
    expect(md).toMatch(/name:\s*epic-planner/);
    expect(md).toMatch(/model:\s*opus/);
  });

  it('team.yaml lists epic-planner under strategic + opus routing', () => {
    const t = load(readFileSync(join(ROOT, '.agentforge/team.yaml'), 'utf8')) as any;
    expect(t.agents.strategic).toContain('epic-planner');
    expect(t.model_routing.opus).toContain('epic-planner');
  });

  it('routing-index has an opus-tier epic-planner agent', () => {
    const idx = JSON.parse(readFileSync(join(ROOT, '.agentforge/routing-index.json'), 'utf8'));
    const agent = idx.agents.find((a: any) => a.id === 'epic-planner');
    expect(agent).toBeDefined();
    expect(agent.tier).toBe('opus');
  });
});
