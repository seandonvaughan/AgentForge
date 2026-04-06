// packages/core/src/autonomous/config-loader.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { CycleConfig } from './types.js';

export const DEFAULT_CYCLE_CONFIG: CycleConfig = Object.freeze({
  budget: Object.freeze({
    perCycleUsd: 50,
    perItemUsd: 10,
    perAgentUsd: 15,
    allowOverageApproval: true,
  }),
  limits: Object.freeze({
    maxItemsPerSprint: 20,
    maxDurationMinutes: 180,
    maxConsecutiveFailures: 5,
    maxExecutePhaseFailureRate: 0.5,
  }),
  quality: Object.freeze({
    testPassRateFloor: 0.95,
    allowRegression: false,
    requireBuildSuccess: true,
    requireTypeCheckSuccess: true,
  }),
  git: Object.freeze({
    branchPrefix: 'autonomous/',
    baseBranch: 'main',
    refuseCommitToBaseBranch: true,
    includeDiagnosticBranchOnFailure: true,
    maxFilesPerCommit: 100,
  }),
  pr: Object.freeze({
    draft: false,
    assignReviewer: 'seandonvaughan',
    labelPrefix: 'autonomous',
    labels: Object.freeze(['autonomous', 'needs-review']) as unknown as string[],
    titleTemplate: 'autonomous(v{version}): {summary}',
  }),
  sourcing: Object.freeze({
    lookbackDays: 7,
    minProposalConfidence: 0.6,
    includeTodoMarkers: true,
    todoMarkerPattern: 'TODO\\(autonomous\\)|FIXME\\(autonomous\\)',
  }),
  testing: Object.freeze({
    command: 'npm run test:run',
    timeoutMinutes: 20,
    reporter: 'json',
    saveRawLog: true,
    buildCommand: 'npm run build',
    typeCheckCommand: 'npx tsc --noEmit',
  }),
  scoring: Object.freeze({
    agentId: 'backlog-scorer',
    maxRetries: 3,
    fallbackToStatic: true,
  }),
  logging: Object.freeze({
    logDir: '.agentforge/cycles',
    retainCycles: 50,
  }),
  safety: Object.freeze({
    stopFilePath: '.agentforge/cycles/{cycleId}/STOP',
    secretScanEnabled: true,
    verifyCleanWorkingTreeBeforeStart: true,
    workingTreeWhitelist: Object.freeze([
      '.agentforge/cycles/**',
      '.agentforge/audit.db-*',
    ]) as unknown as string[],
  }),
}) as CycleConfig;

export function loadCycleConfig(cwd: string): CycleConfig {
  const configPath = join(cwd, '.agentforge/autonomous.yaml');

  if (!existsSync(configPath)) {
    return DEFAULT_CYCLE_CONFIG;
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, 'utf8');
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }

  if (parsed === null || parsed === undefined) {
    return DEFAULT_CYCLE_CONFIG;
  }

  if (typeof parsed !== 'object') {
    throw new Error(`${configPath}: expected object at root, got ${typeof parsed}`);
  }

  return mergeConfig(DEFAULT_CYCLE_CONFIG, parsed as Partial<CycleConfig>);
}

function mergeConfig(defaults: CycleConfig, overrides: Partial<CycleConfig>): CycleConfig {
  const merged: CycleConfig = JSON.parse(JSON.stringify(defaults));

  for (const key of Object.keys(overrides) as (keyof CycleConfig)[]) {
    const override = overrides[key];
    if (override !== undefined && override !== null) {
      merged[key] = { ...merged[key], ...(override as object) } as never;
    }
  }

  validateConfig(merged);
  return merged;
}

function validateConfig(config: CycleConfig): void {
  if (typeof config.budget.perCycleUsd !== 'number') {
    throw new Error('budget.perCycleUsd must be a number');
  }
  if (typeof config.budget.perItemUsd !== 'number') {
    throw new Error('budget.perItemUsd must be a number');
  }
  if (typeof config.limits.maxItemsPerSprint !== 'number') {
    throw new Error('limits.maxItemsPerSprint must be a number');
  }
  if (typeof config.limits.maxDurationMinutes !== 'number') {
    throw new Error('limits.maxDurationMinutes must be a number');
  }
  if (config.quality.testPassRateFloor < 0 || config.quality.testPassRateFloor > 1) {
    throw new Error('quality.testPassRateFloor must be between 0 and 1');
  }
  if (typeof config.git.baseBranch !== 'string') {
    throw new Error('git.baseBranch must be a string');
  }
}
