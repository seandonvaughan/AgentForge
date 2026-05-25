import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ReforgeEngine } from '../reforge-engine.js';
import type { ReforgePlan } from '../types/reforge.js';
import type { AgentTemplate } from '../../team/engine/types/agent.js';

const TEST_AGENT = 'coder';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-reforge-canary-'));
  tempDirs.push(dir);
  return dir;
}

function baseTemplate(): AgentTemplate {
  return {
    name: TEST_AGENT,
    model: 'sonnet',
    effort: 'medium',
    version: '1.0.0',
    description: 'test agent',
    system_prompt: 'Base prompt',
    skills: [],
    triggers: { file_patterns: [], keywords: [] },
    collaboration: {
      reports_to: null,
      reviews_from: [],
      can_delegate_to: [],
      parallel: false,
    },
    context: {
      max_files: 10,
      auto_include: [],
      project_specific: [],
    },
  };
}

function localCanaryPlan(): ReforgePlan {
  return {
    id: 'plan-1',
    timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    reforgeClass: 'local',
    triggeredBy: 'test',
    rationale: 'test',
    estimatedImpact: 'test',
    mutations: [
      {
        type: 'model-tier-override',
        agentName: TEST_AGENT,
        field: 'model',
        oldValue: 'sonnet',
        newValue: 'haiku',
        rationale: 'test',
      },
    ],
  };
}

async function deployTestCanary(projectRoot: string): Promise<ReforgeEngine> {
  const engine = new ReforgeEngine(projectRoot);
  await engine.deployCanary(localCanaryPlan(), {
    trafficPercent: 100,
    strategy: 'hash',
    rollbackThreshold: 0.25,
  });
  return engine;
}

function readCanaryDeployment(projectRoot: string) {
  const file = join(projectRoot, '.agentforge', 'agent-overrides', 'canary', `${TEST_AGENT}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as {
    metrics?: { canaryRequests: number; canaryErrors: number; errorRate: number };
  };
}

describe('ReforgeEngine canary outcome safety', () => {
  it('ignores quality outcomes without explicit correlation ids', async () => {
    const projectRoot = makeProjectRoot();
    const engine = await deployTestCanary(projectRoot);

    const result = await engine.recordCanaryOutcome(TEST_AGENT, true);

    expect(result?.ignored).toBe('missing-correlation');
    expect(readCanaryDeployment(projectRoot).metrics?.canaryRequests ?? 0).toBe(0);
  });

  it('does not consume a pending correlation on non-quality outcomes', async () => {
    const projectRoot = makeProjectRoot();
    const engine = await deployTestCanary(projectRoot);
    await engine.applyOverride(baseTemplate(), { requestId: 'req-1', outcomeToken: 'tok-1' });

    const ignored = await engine.recordCanaryOutcome(TEST_AGENT, true, {
      source: 'runtime',
      requestId: 'req-1',
      outcomeToken: 'tok-1',
    });
    const quality = await engine.recordCanaryOutcome(TEST_AGENT, true, {
      source: 'quality',
      requestId: 'req-1',
      outcomeToken: 'tok-1',
    });

    expect(ignored?.ignored).toContain('only quality outcomes affect rollback');
    expect(quality?.ignored).toBeUndefined();
    expect(quality?.deployment.metrics?.canaryRequests).toBe(1);
  });

  it('requires full correlation when pending outcomes were tracked with request and token', async () => {
    const projectRoot = makeProjectRoot();
    const engine = await deployTestCanary(projectRoot);
    await engine.applyOverride(baseTemplate(), { requestId: 'req-1', outcomeToken: 'tok-1' });

    const partial = await engine.recordCanaryOutcome(TEST_AGENT, false, {
      requestId: 'req-1',
    });
    const full = await engine.recordCanaryOutcome(TEST_AGENT, false, {
      requestId: 'req-1',
      outcomeToken: 'tok-1',
    });

    expect(partial?.ignored).toBe('no-pending-canary-outcome');
    expect(full?.ignored).toBeUndefined();
    expect(full?.deployment.metrics?.canaryRequests).toBe(1);
  });

  it('rejects conflicting alias merges so later requests are not poisoned', async () => {
    const projectRoot = makeProjectRoot();
    const engine = await deployTestCanary(projectRoot);

    await engine.applyOverride(baseTemplate(), { requestId: 'req-1', outcomeToken: 'tok-1' });
    await engine.applyOverride(baseTemplate(), { requestId: 'req-2', outcomeToken: 'tok-1' });
    await engine.applyOverride(baseTemplate(), { requestId: 'req-2', outcomeToken: 'tok-2' });

    const result = await engine.recordCanaryOutcome(TEST_AGENT, false, {
      requestId: 'req-2',
      outcomeToken: 'tok-2',
    });

    expect(result?.ignored).toBeUndefined();
    expect(result?.deployment.metrics?.canaryRequests).toBe(1);
  });
});
