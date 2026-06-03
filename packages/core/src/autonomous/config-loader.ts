// packages/core/src/autonomous/config-loader.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { CycleConfig } from './types.js';

export const DEFAULT_CYCLE_CONFIG: CycleConfig = Object.freeze({
  budget: Object.freeze({
    // v6.7.4: default budget raised from $50 → $200 per user request.
    // The kill-switch budget check is now warn-only (see kill-switch.ts);
    // cycles continue to completion even when cumulative spend crosses
    // this ceiling. The number is still used by the approval gate and
    // the dashboard cost bars as a reference line.
    perCycleUsd: 200,
    // v15.0.0: dropped from 40 → 1.50. The flat $40 was used as both the
    // budget guardrail per-item AND the static-fallback cost estimate.
    // Historical actuals (last 7 cycles) show items completing for
    // $0.55-$2.20 median, never near $40. Using $40 as the static estimate
    // produced 34× overestimates that triggered budget-overflow approvals
    // for trivial work. The kill-switch uses perCycleUsd anyway, so this
    // per-item value is purely an estimation calibration point.
    perItemUsd: 1.5,
    perAgentUsd: 60,
    allowOverageApproval: true,
  }),
  limits: Object.freeze({
    maxItemsPerSprint: 20,
    maxDurationMinutes: 180,
    maxConsecutiveFailures: 5,
    maxExecutePhaseFailureRate: 0.5,
    // v6.7.4: raised from 3 → 10. The old value capped execute to 3
    // concurrent agent dispatches even when 18+ items were approved,
    // making cycles take 60+ minutes for work that could finish in 15.
    maxExecutePhaseParallelism: 10,
    maxItemRetries: 1,
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
    // Per-commit changed-line ceiling (additions + deletions, summed over
    // the staged diff). Sibling to maxFilesPerCommit: a single runaway file
    // can blow past tens of thousands of lines while still under the
    // file-count cap. 4000 covers the largest legitimate generated-file
    // updates we have observed without giving cover to true runaway diffs.
    maxLinesPerCommit: 4000,
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
    // Build ALL workspace packages so every cross-package .d.ts is up-to-date
    // before the typecheck runs.  The original default only built @agentforge/core,
    // which left 7 other referenced packages unbuilt; tsc --noEmit then failed
    // to resolve their type declarations.
    buildCommand: 'pnpm build',
    // Use -b (build mode) so TypeScript walks the full project-reference graph
    // defined in the root tsconfig.json rather than only checking the root
    // project in isolation.  Without -b, tsc --noEmit ignores project references
    // and will fail on unresolved cross-package imports even after a build.
    typeCheckCommand: 'pnpm exec tsc -b --noEmit --pretty false',
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
  retry: Object.freeze({
    maxAutoRetries: 1,
    requireApprovalAfter: 1,
    reExecuteOnRetry: true,
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
    if (override === undefined || override === null) continue;

    // Optional root fields are primitives, not nested objects. If they fall
    // through to the object merge below, values like `prMode: multi` become
    // `{}` and silently disable the intended runtime behavior.
    if (key === 'modelCap') {
      if (override === 'opus' || override === 'sonnet' || override === 'haiku') {
        merged.modelCap = override;
      }
    } else if (key === 'effortCap') {
      if (override === 'low' || override === 'medium' || override === 'high' || override === 'xhigh' || override === 'max') {
        merged.effortCap = override;
      }
    } else if (key === 'fallbackEnabled') {
      if (typeof override === 'boolean') {
        merged.fallbackEnabled = override;
      }
    } else if (key === 'autoReforge') {
      if (typeof override === 'boolean') {
        merged.autoReforge = override;
      }
    } else if (key === 'prMode') {
      if (override === 'single' || override === 'multi') {
        merged.prMode = override;
      }
    } else if (key === 'autoMergePRs') {
      if (typeof override === 'boolean') {
        merged.autoMergePRs = override;
      }
    } else {
      const base = merged[key];
      if (isRecord(base) && isRecord(override)) {
        merged[key] = { ...base, ...override } as never;
      }
    }
  }

  validateConfig(merged);
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (typeof config.git.maxFilesPerCommit !== 'number' || config.git.maxFilesPerCommit <= 0) {
    throw new Error('git.maxFilesPerCommit must be a positive number');
  }
  if (typeof config.git.maxLinesPerCommit !== 'number' || config.git.maxLinesPerCommit <= 0) {
    throw new Error('git.maxLinesPerCommit must be a positive number');
  }
  if (config.prMode !== undefined && config.prMode !== 'single' && config.prMode !== 'multi') {
    throw new Error('prMode must be "single" or "multi"');
  }
  if (config.autoMergePRs !== undefined && typeof config.autoMergePRs !== 'boolean') {
    throw new Error('autoMergePRs must be a boolean');
  }
  if (config.autoReforge !== undefined && typeof config.autoReforge !== 'boolean') {
    throw new Error('autoReforge must be a boolean');
  }
  if (
    config.testing.multiPrVerifyCommands !== undefined &&
    (
      !Array.isArray(config.testing.multiPrVerifyCommands) ||
      config.testing.multiPrVerifyCommands.some((cmd) => typeof cmd !== 'string')
    )
  ) {
    throw new Error('testing.multiPrVerifyCommands must be an array of strings');
  }
}
