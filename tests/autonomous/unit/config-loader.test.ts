import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCycleConfig, DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';

describe('loadCycleConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const config = loadCycleConfig(tmpDir);
    expect(config.budget.perCycleUsd).toBe(50);
    expect(config.budget.perItemUsd).toBe(10);
    expect(config.limits.maxItemsPerSprint).toBe(20);
    expect(config.quality.testPassRateFloor).toBe(0.95);
    expect(config.git.baseBranch).toBe('main');
    expect(config.git.refuseCommitToBaseBranch).toBe(true);
  });

  it('exposes v6.5.3 execute parallelism + retry defaults', () => {
    const config = loadCycleConfig(tmpDir);
    expect(config.limits.maxExecutePhaseParallelism).toBe(3);
    expect(config.limits.maxItemRetries).toBe(1);
  });

  it('merges user overrides over defaults', () => {
    mkdirSync(join(tmpDir, '.agentforge'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.agentforge/autonomous.yaml'),
      `
budget:
  perCycleUsd: 100
limits:
  maxDurationMinutes: 240
`,
    );

    const config = loadCycleConfig(tmpDir);
    expect(config.budget.perCycleUsd).toBe(100);
    expect(config.budget.perItemUsd).toBe(10); // default
    expect(config.limits.maxDurationMinutes).toBe(240);
    expect(config.limits.maxItemsPerSprint).toBe(20); // default
  });

  it('throws on malformed yaml', () => {
    mkdirSync(join(tmpDir, '.agentforge'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.agentforge/autonomous.yaml'),
      'this: is: not: valid: yaml:::',
    );
    expect(() => loadCycleConfig(tmpDir)).toThrow();
  });

  it('throws when budget.perCycleUsd is not a number', () => {
    mkdirSync(join(tmpDir, '.agentforge'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.agentforge/autonomous.yaml'),
      `budget:\n  perCycleUsd: "fifty"`,
    );
    expect(() => loadCycleConfig(tmpDir)).toThrow(/perCycleUsd must be a number/i);
  });

  it('preserves full CycleConfig shape with all required fields', () => {
    const config = loadCycleConfig(tmpDir);
    expect(config).toHaveProperty('budget');
    expect(config).toHaveProperty('limits');
    expect(config).toHaveProperty('quality');
    expect(config).toHaveProperty('git');
    expect(config).toHaveProperty('pr');
    expect(config).toHaveProperty('sourcing');
    expect(config).toHaveProperty('testing');
    expect(config).toHaveProperty('scoring');
    expect(config).toHaveProperty('logging');
    expect(config).toHaveProperty('safety');
  });

  it('DEFAULT_CYCLE_CONFIG is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_CYCLE_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CYCLE_CONFIG.budget)).toBe(true);
  });
});
