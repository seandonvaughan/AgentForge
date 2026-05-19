import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from '../routes/agents/[id]/+page.server.js';

let tmpRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-agents-detail-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeAgentYaml(agentId: string, yaml: string): void {
  const agentsDir = join(tmpRoot, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${agentId}.yaml`), yaml);
}

describe('agents/[id] +page.server load()', () => {
  it('parses top-level dash-list skills without dropping entries', async () => {
    writeAgentYaml('qa-engineer', [
      'name: QA Engineer',
      'model: sonnet',
      'skills:',
      '  - adversarial-testing',
      '  - regression-gates',
      '  - parser-hardening',
      'description: Agent focused on test coverage',
    ].join('\n'));

    const result = await load({
      params: { id: 'qa-engineer' },
    } as Parameters<typeof load>[0]);

    expect(result.agent.agentId).toBe('qa-engineer');
    expect(result.agent.skills).toEqual([
      'adversarial-testing',
      'regression-gates',
      'parser-hardening',
    ]);
  });

  it('parses collaboration reports_to and nested dash-list can_delegate_to', async () => {
    writeAgentYaml('release-manager', [
      'name: Release Manager',
      'model: opus',
      'skills: [release-planning, rollout-control]',
      'collaboration:',
      '  reports_to: cto',
      '  can_delegate_to:',
      '    - qa-engineer',
      '    - devops-engineer',
    ].join('\n'));

    const result = await load({
      params: { id: 'release-manager' },
    } as Parameters<typeof load>[0]);

    expect(result.agent.reportsTo).toBe('cto');
    expect(result.agent.canDelegateTo).toEqual(['qa-engineer', 'devops-engineer']);
  });

  it('keeps dash-list skills when additional top-level keys follow', async () => {
    writeAgentYaml('parser-guard', [
      'name: Parser Guard',
      'skills:',
      '  - yaml-contracts',
      '  - schema-consistency',
      'version: "1.2.3"',
      'seniority: senior',
    ].join('\n'));

    const result = await load({
      params: { id: 'parser-guard' },
    } as Parameters<typeof load>[0]);

    expect(result.agent.skills).toEqual(['yaml-contracts', 'schema-consistency']);
    expect(result.agent.version).toBe('1.2.3');
    expect(result.agent.seniority).toBe('senior');
  });
});
