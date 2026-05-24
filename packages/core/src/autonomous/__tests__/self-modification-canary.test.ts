import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { SelfModificationCanaryManager } from '../self-modification-canary.js';
import type { MutatorReport } from '../auto-reforge.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-selfmod-canary-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeReport(agentId = 'coder', lessons = ['Always verify canary changes.']): MutatorReport {
  return {
    perAgent: {
      [agentId]: {
        applied: lessons.length,
        skipped: 0,
        capped: false,
        lessons,
      },
    },
    totalApplied: lessons.length,
    totalSkipped: 0,
    dryRun: true,
  };
}

function canaryPath(agentId: string): string {
  return join(tmpDir, '.agentforge', 'forge', 'self-modification-canaries', `${agentId}.json`);
}

describe('SelfModificationCanaryManager', () => {
  it('stages learnings and resolves canary traffic only when routing context is provided', async () => {
    const manager = new SelfModificationCanaryManager(tmpDir);
    const deployments = await manager.stage({
      cycleId: 'cycle-1',
      report: makeReport(),
      policy: { trafficPercent: 100, promoteAfterHealthyRequests: 0 },
    });

    expect(deployments).toHaveLength(1);
    expect(existsSync(canaryPath('coder'))).toBe(true);

    const noContext = await manager.resolve('coder');
    expect(noContext?.route.variant).toBe('control');
    expect(noContext?.lessons).toEqual([]);

    const canary = await manager.resolve('coder', { requestId: 'req-1' });
    expect(canary?.route.variant).toBe('canary');
    expect(canary?.lessons).toEqual(['Always verify canary changes.']);
  });

  it('rolls back and removes the active deployment when canary errors exceed threshold', async () => {
    const manager = new SelfModificationCanaryManager(tmpDir);
    const [deployment] = await manager.stage({
      cycleId: 'cycle-2',
      report: makeReport(),
      policy: {
        trafficPercent: 100,
        rollbackThreshold: 0.1,
        minCanaryRequests: 5,
        promoteAfterHealthyRequests: 0,
      },
    });

    for (let i = 0; i < 5; i++) {
      await manager.recordOutcome('coder', deployment!.flagId, true);
    }

    expect(existsSync(canaryPath('coder'))).toBe(false);
    const rollbackPath = join(tmpDir, '.agentforge', 'forge', 'self-modification-canaries', 'coder.rollback.json');
    const rollback = JSON.parse(readFileSync(rollbackPath, 'utf8')) as {
      rollback?: { errorRate: number; threshold: number };
      metrics?: { canaryRequests: number; canaryErrors: number };
    };
    expect(rollback.metrics).toMatchObject({ canaryRequests: 5, canaryErrors: 5 });
    expect(rollback.rollback).toMatchObject({ errorRate: 1, threshold: 0.1 });
  });

  it('uses the configured minimum sample size before rolling back', async () => {
    const manager = new SelfModificationCanaryManager(tmpDir);
    const [deployment] = await manager.stage({
      cycleId: 'cycle-2b',
      report: makeReport(),
      policy: {
        trafficPercent: 100,
        rollbackThreshold: 0.1,
        minCanaryRequests: 10,
        promoteAfterHealthyRequests: 0,
      },
    });

    let outcome = await manager.recordOutcome('coder', deployment!.flagId, true);
    for (let i = 1; i < 5; i++) {
      outcome = await manager.recordOutcome('coder', deployment!.flagId, true);
    }
    expect(outcome?.action).toBe('kept');
    expect(existsSync(canaryPath('coder'))).toBe(true);

    for (let i = 0; i < 5; i++) {
      outcome = await manager.recordOutcome('coder', deployment!.flagId, true);
    }
    expect(outcome?.action).toBe('rolled_back');
    expect(existsSync(canaryPath('coder'))).toBe(false);
  });

  it('promotes healthy staged lessons into agent YAML after the healthy sample threshold', async () => {
    const agentsDir = join(tmpDir, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, 'coder.yaml'),
      [
        'name: coder',
        'model: sonnet',
        'system_prompt: You are a coder.',
        'learnings:',
        '  - Keep existing learning.',
        '',
      ].join('\n'),
    );

    const manager = new SelfModificationCanaryManager(tmpDir);
    const [deployment] = await manager.stage({
      cycleId: 'cycle-3',
      report: makeReport('coder', ['Always verify canary changes.']),
      policy: {
        trafficPercent: 100,
        rollbackThreshold: 0,
        minCanaryRequests: 5,
        promoteAfterHealthyRequests: 2,
      },
    });

    await manager.recordOutcome('coder', deployment!.flagId, false);
    const outcome = await manager.recordOutcome('coder', deployment!.flagId, false);

    expect(outcome?.action).toBe('promoted');
    expect(existsSync(canaryPath('coder'))).toBe(false);
    const parsed = yaml.load(readFileSync(join(agentsDir, 'coder.yaml'), 'utf8')) as { learnings?: string[] };
    expect(parsed.learnings).toEqual([
      'Always verify canary changes.',
      'Keep existing learning.',
    ]);
  });

  it('fails closed when promotion would target invalid agent YAML', async () => {
    const agentsDir = join(tmpDir, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'coder.yaml'), '[]');

    const manager = new SelfModificationCanaryManager(tmpDir);
    const [deployment] = await manager.stage({
      cycleId: 'cycle-4',
      report: makeReport('coder', ['Keep promotion safe.']),
      policy: {
        trafficPercent: 100,
        rollbackThreshold: 0,
        minCanaryRequests: 1,
        promoteAfterHealthyRequests: 1,
      },
    });

    const outcome = await manager.recordOutcome('coder', deployment!.flagId, false);
    expect(outcome?.action).toBe('rolled_back');
    expect(outcome?.deployment.rollback?.reason).toContain('promotion failed');
    expect(existsSync(canaryPath('coder'))).toBe(false);
  });
});
