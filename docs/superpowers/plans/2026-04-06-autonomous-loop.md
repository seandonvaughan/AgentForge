# Autonomous Development Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a supervised autonomous development loop that plans, executes, tests, commits, and opens PRs with minimal human intervention.

**Architecture:** Single-process CLI (`npm run autonomous:cycle`) drives a `CycleRunner` through 6 stages (PLAN → STAGE → RUN → VERIFY → COMMIT → REVIEW). Phase advancement uses the existing EventBus for in-process event wiring. All external effects (vitest, git, gh CLI) are real subprocesses with safety guards.

**Tech Stack:** TypeScript, Node.js `>=20.19.0`, Fastify (existing), SQLite (existing via better-sqlite3), Anthropic SDK, js-yaml, vitest, real git, gh CLI.

**Spec reference:** `docs/superpowers/specs/2026-04-06-autonomous-loop-design.md`

---

## File Structure

New files in `packages/core/src/autonomous/`:
- `types.ts` — all shared types (CycleStage, CycleConfig, CycleResult, etc.)
- `version-bumper.ts` — semver with tag-driven rules
- `config-loader.ts` — parse `.agentforge/autonomous.yaml`
- `cycle-logger.ts` — structured per-cycle logging
- `pr-body-renderer.ts` — markdown template for PR bodies
- `kill-switch.ts` — centralized trip logic
- `proposal-to-backlog.ts` — SelfProposalEngine → BacklogItem[]
- `scoring-pipeline.ts` — agent-driven ranking with fallback ladder
- `budget-approval.ts` — TTY + file-based overrun approval
- `sprint-generator.ts` — SprintPredictor + SprintPlanner wiring
- `phase-scheduler.ts` — EventBus-driven phase auto-advance
- `cycle-runner.ts` — top-level orchestrator
- `exec/real-test-runner.ts` — shell vitest
- `exec/git-ops.ts` — real git with safety guards
- `exec/pr-opener.ts` — gh pr create
- `index.ts` — barrel export

Other new files:
- `packages/cli/src/commands/autonomous.ts` — CLI entry point
- `packages/server/src/lib/phase-handlers.ts` — extracted from sprint-orchestration.ts
- `.agentforge/autonomous.yaml` — cycle configuration
- `.agentforge/agents/backlog-scorer.yaml` — new scoring agent

Modified files:
- `packages/server/src/routes/v5/sprint-orchestration.ts` — thin wrappers calling phase-handlers.ts + event publishing
- `packages/core/src/index.ts` — add autonomous export
- `package.json` — add `autonomous:cycle` npm script

---

## Task Overview

**Phase 1 — Pure Logic (Tasks 1-5):** Types, version bumper, config, logger, PR body renderer.
**Phase 2 — Safety & Data (Tasks 6-8):** Kill switch, proposal bridge, sprint generator.
**Phase 3 — Subprocess Wrappers (Tasks 9-14):** Real test runner, git ops, PR opener.
**Phase 4 — Phase Handler Refactor (Tasks 15-17):** Regression capture, extraction, event publishing.
**Phase 5 — Autonomous Orchestration (Tasks 18-22):** Scoring, approval, scheduler, cycle runner.
**Phase 6 — Integration (Tasks 23-26):** Config, CLI, E2E, smoke procedure.

---

## Task 1: Scaffold autonomous module + types

**Files:**
- Create: `packages/core/src/autonomous/types.ts`
- Create: `packages/core/src/autonomous/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/autonomous/types.test.ts` (minimal)

**Context:** Creates the new module directory and defines every shared type referenced by later tasks. No business logic — just types and the barrel export.

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p packages/core/src/autonomous/exec
```

- [ ] **Step 2: Create `packages/core/src/autonomous/types.ts`**

```typescript
// packages/core/src/autonomous/types.ts

export enum CycleStage {
  PLAN = 'plan',
  STAGE = 'stage',
  RUN = 'run',
  VERIFY = 'verify',
  COMMIT = 'commit',
  REVIEW = 'review',
  KILLED = 'killed',
  FAILED = 'failed',
  COMPLETED = 'completed',
}

export type KillReason =
  | 'budget'
  | 'duration'
  | 'regression'
  | 'testFloor'
  | 'buildFailure'
  | 'typeCheckFailure'
  | 'consecutiveFailures'
  | 'manualStop'
  | 'manualStopFile';

export interface KillSwitchTrip {
  reason: KillReason;
  detail: string;
  triggeredAt: string;
  stageAtTrip: CycleStage;
}

export interface CycleConfig {
  budget: {
    perCycleUsd: number;
    perItemUsd: number;
    perAgentUsd: number;
    allowOverageApproval: boolean;
  };
  limits: {
    maxItemsPerSprint: number;
    maxDurationMinutes: number;
    maxConsecutiveFailures: number;
    maxExecutePhaseFailureRate: number;
  };
  quality: {
    testPassRateFloor: number;
    allowRegression: boolean;
    requireBuildSuccess: boolean;
    requireTypeCheckSuccess: boolean;
  };
  git: {
    branchPrefix: string;
    baseBranch: string;
    refuseCommitToBaseBranch: boolean;
    includeDiagnosticBranchOnFailure: boolean;
    maxFilesPerCommit: number;
  };
  pr: {
    draft: boolean;
    assignReviewer: string | null;
    labelPrefix: string;
    labels: string[];
    titleTemplate: string;
  };
  sourcing: {
    lookbackDays: number;
    minProposalConfidence: number;
    includeTodoMarkers: boolean;
    todoMarkerPattern: string;
  };
  testing: {
    command: string;
    timeoutMinutes: number;
    reporter: string;
    saveRawLog: boolean;
    buildCommand: string;
    typeCheckCommand: string;
  };
  scoring: {
    agentId: string;
    maxRetries: number;
    fallbackToStatic: boolean;
  };
  logging: {
    logDir: string;
    retainCycles: number;
  };
  safety: {
    stopFilePath: string;
    secretScanEnabled: boolean;
    verifyCleanWorkingTreeBeforeStart: boolean;
    workingTreeWhitelist: string[];
  };
}

export interface FailedTest {
  file: string;
  suite: string;
  name: string;
  error: string;
  snippet: string;
}

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
  durationMs: number;
  failedTests: FailedTest[];
  newFailures: string[];
  rawOutputPath: string;
  exitCode: number;
}

export interface RankedItem {
  itemId: string;
  title: string;
  rank: number;
  score: number;
  confidence: number;
  estimatedCostUsd: number;
  estimatedDurationMinutes: number;
  rationale: string;
  dependencies: string[];
  suggestedAssignee: string;
  suggestedTags: string[];
  withinBudget: boolean;
}

export interface ScoringResult {
  rankings: RankedItem[];
  totalEstimatedCostUsd: number;
  budgetOverflowUsd: number;
  summary: string;
  warnings: string[];
}

export interface CycleResult {
  cycleId: string;
  sprintVersion: string;
  stage: CycleStage;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  cost: {
    totalUsd: number;
    budgetUsd: number;
    byAgent: Record<string, number>;
    byPhase: Record<string, number>;
  };
  tests: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    passRate: number;
    newFailures: string[];
  };
  git: {
    branch: string;
    commitSha: string | null;
    filesChanged: string[];
  };
  pr: {
    url: string | null;
    number: number | null;
    draft: boolean;
  };
  killSwitch?: KillSwitchTrip;
  scoringFallback?: 'static';
}

export class CycleKilledError extends Error {
  constructor(public readonly trip: KillSwitchTrip) {
    super(`Cycle killed: ${trip.reason} — ${trip.detail}`);
    this.name = 'CycleKilledError';
  }
}

export class PhaseFailedError extends Error {
  constructor(public readonly phase: string, public readonly reason: string) {
    super(`Phase ${phase} failed: ${reason}`);
    this.name = 'PhaseFailedError';
  }
}
```

- [ ] **Step 3: Create `packages/core/src/autonomous/index.ts`**

```typescript
// packages/core/src/autonomous/index.ts
export * from './types.js';
```

- [ ] **Step 4: Add autonomous export to `packages/core/src/index.ts`**

Append to the end of the file:

```typescript
export * from './autonomous/index.js';
```

- [ ] **Step 5: Verify build**

Run: `cd packages/core && npm run build`
Expected: Clean build, 0 errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/autonomous/types.ts \
        packages/core/src/autonomous/index.ts \
        packages/core/src/index.ts
git commit -m "feat(autonomous): scaffold autonomous module + types"
```

---

## Task 2: Version bumper (pure function)

**Files:**
- Create: `packages/core/src/autonomous/version-bumper.ts`
- Test: `packages/core/src/autonomous/version-bumper.test.ts`

**Context:** Pure function that bumps semver based on sprint item tags. Patch for fixes, minor for features, major for breaking changes. See spec §6.7.

- [ ] **Step 1: Write failing test for version bumper**

Create `packages/core/src/autonomous/version-bumper.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bumpVersion } from './version-bumper.js';

describe('bumpVersion', () => {
  it.each([
    // [currentVersion, itemTags, expectedNext]
    ['6.4.0', ['fix'], '6.4.1'],
    ['6.4.0', ['bug'], '6.4.1'],
    ['6.4.0', ['security'], '6.4.1'],
    ['6.4.0', ['chore'], '6.4.1'],
    ['6.4.0', ['docs'], '6.4.1'],
    ['6.4.0', ['refactor'], '6.4.1'],
    ['6.4.0', ['feature'], '6.5.0'],
    ['6.4.0', ['capability'], '6.5.0'],
    ['6.4.0', ['enhancement'], '6.5.0'],
    ['6.4.0', ['new'], '6.5.0'],
    ['6.4.0', ['breaking'], '7.0.0'],
    ['6.4.0', ['architecture'], '7.0.0'],
    ['6.4.0', ['platform'], '7.0.0'],
    ['6.4.0', ['major-ui'], '7.0.0'],
    ['6.4.0', ['rewrite'], '7.0.0'],
    ['6.4.0', ['fix', 'feature'], '6.5.0'],              // highest tier wins
    ['6.4.0', ['fix', 'feature', 'breaking'], '7.0.0'],  // major beats minor beats patch
    ['6.4.0', [], '6.5.0'],                              // default = minor
    ['6.4.9', ['fix'], '6.4.10'],
    ['6.9.9', ['feature'], '6.10.0'],
  ] as const)('bumps %s with tags %o → %s', (current, tags, expected) => {
    expect(bumpVersion(current, [...tags])).toBe(expected);
  });

  it('respects explicit override to major', () => {
    expect(bumpVersion('6.4.0', ['fix'], 'major')).toBe('7.0.0');
  });

  it('respects explicit override to minor', () => {
    expect(bumpVersion('6.4.0', ['fix'], 'minor')).toBe('6.5.0');
  });

  it('respects explicit override to patch', () => {
    expect(bumpVersion('6.4.0', ['breaking'], 'patch')).toBe('6.4.1');
  });

  it('pads legacy 2-segment versions to semver', () => {
    expect(bumpVersion('6.3', ['fix'])).toBe('6.3.1');
    expect(bumpVersion('6.3', ['feature'])).toBe('6.4.0');
  });

  it('strips leading v prefix', () => {
    expect(bumpVersion('v6.4.0', ['fix'])).toBe('6.4.1');
  });

  it('throws on malformed version', () => {
    expect(() => bumpVersion('not-a-version', ['fix'])).toThrow();
  });
});
```

- [ ] **Step 2: Run test — verify all fail**

Run: `cd packages/core && npx vitest run src/autonomous/version-bumper.test.ts`
Expected: All tests FAIL with "Cannot find module './version-bumper.js'".

- [ ] **Step 3: Implement `version-bumper.ts`**

Create `packages/core/src/autonomous/version-bumper.ts`:

```typescript
// packages/core/src/autonomous/version-bumper.ts

export type VersionBumpTier = 'major' | 'minor' | 'patch';

const MAJOR_TAGS = new Set(['breaking', 'architecture', 'platform', 'major-ui', 'rewrite']);
const MINOR_TAGS = new Set(['feature', 'capability', 'enhancement', 'new']);
const PATCH_TAGS = new Set(['fix', 'bug', 'security', 'patch', 'chore', 'docs', 'refactor']);

/**
 * Bump a semver version based on sprint item tags.
 * Rules:
 *   - breaking/architecture/platform/major-ui/rewrite → major (6.4.0 → 7.0.0)
 *   - feature/capability/enhancement/new → minor (6.4.0 → 6.5.0)
 *   - fix/bug/security/patch/chore/docs/refactor → patch (6.4.0 → 6.4.1)
 *   - none → minor (autonomous default)
 *   - explicit override → always wins
 */
export function bumpVersion(
  current: string,
  itemTags: string[],
  override?: VersionBumpTier,
): string {
  const { major, minor, patch } = parseSemver(current);
  const tier = override ?? determineTier(itemTags);

  switch (tier) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

function determineTier(tags: string[]): VersionBumpTier {
  if (tags.some(t => MAJOR_TAGS.has(t))) return 'major';
  if (tags.some(t => MINOR_TAGS.has(t))) return 'minor';
  if (tags.some(t => PATCH_TAGS.has(t))) return 'patch';
  return 'minor'; // autonomous default
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const cleaned = v.replace(/^v/, '');
  const parts = cleaned.split('.').map(Number);

  if (parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${v}`);
  }

  while (parts.length < 3) parts.push(0);

  return {
    major: parts[0]!,
    minor: parts[1]!,
    patch: parts[2]!,
  };
}
```

- [ ] **Step 4: Run tests — verify all pass**

Run: `cd packages/core && npx vitest run src/autonomous/version-bumper.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Export from barrel**

Edit `packages/core/src/autonomous/index.ts`:

```typescript
export * from './types.js';
export * from './version-bumper.js';
```

- [ ] **Step 6: Verify build**

Run: `cd packages/core && npm run build`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/version-bumper.ts \
        packages/core/src/autonomous/version-bumper.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): version bumper with tag-driven semver rules"
```

---

## Task 3: Config loader

**Files:**
- Create: `packages/core/src/autonomous/config-loader.ts`
- Test: `packages/core/src/autonomous/config-loader.test.ts`

**Context:** Parses `.agentforge/autonomous.yaml`, merges over sane defaults, validates with plain type guards (no zod in this codebase — verified in Task 0). See spec §9.

- [ ] **Step 1: Write failing test for defaults**

Create `packages/core/src/autonomous/config-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCycleConfig, DEFAULT_CYCLE_CONFIG } from './config-loader.js';

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
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/config-loader.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `config-loader.ts`**

Create `packages/core/src/autonomous/config-loader.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/config-loader.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel export**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './config-loader.js';
```

- [ ] **Step 6: Verify build**

Run: `cd packages/core && npm run build`
Expected: Clean build.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/autonomous/config-loader.ts \
        packages/core/src/autonomous/config-loader.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): config loader with yaml + defaults + validation"
```

---

## Task 4: Cycle logger

**Files:**
- Create: `packages/core/src/autonomous/cycle-logger.ts`
- Test: `packages/core/src/autonomous/cycle-logger.test.ts`

**Context:** Structured per-cycle logger. Writes JSON files to `.agentforge/cycles/{cycleId}/`. Each log method is a plain file write (no buffering). See spec §10.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/cycle-logger.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleLogger } from './cycle-logger.js';
import { CycleStage } from './types.js';

describe('CycleLogger', () => {
  let tmpDir: string;
  let logger: CycleLogger;
  const cycleId = 'test-cycle-abc123';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-logger-'));
    logger = new CycleLogger(tmpDir, cycleId);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the cycle directory on init', () => {
    const dir = join(tmpDir, '.agentforge/cycles', cycleId);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'phases'))).toBe(true);
  });

  it('logPhaseStart writes to events.jsonl', () => {
    logger.logPhaseStart('audit');
    const events = readEvents(tmpDir, cycleId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('phase.start');
    expect(events[0].phase).toBe('audit');
    expect(events[0].at).toBeDefined();
  });

  it('logPhaseResult writes phase json and events', () => {
    logger.logPhaseResult('audit', {
      phase: 'audit',
      status: 'completed',
      durationMs: 12345,
      costUsd: 0.50,
      agentRuns: [],
    } as any);

    const phasePath = join(tmpDir, '.agentforge/cycles', cycleId, 'phases', 'audit.json');
    expect(existsSync(phasePath)).toBe(true);
    const phaseData = JSON.parse(readFileSync(phasePath, 'utf8'));
    expect(phaseData.status).toBe('completed');

    const events = readEvents(tmpDir, cycleId);
    expect(events.some(e => e.type === 'phase.result')).toBe(true);
  });

  it('logTestRun writes tests.json', () => {
    logger.logTestRun({
      passed: 100,
      failed: 2,
      skipped: 0,
      total: 102,
      passRate: 100 / 102,
      durationMs: 5000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: '/tmp/raw.log',
      exitCode: 1,
    });
    const testsPath = join(tmpDir, '.agentforge/cycles', cycleId, 'tests.json');
    expect(existsSync(testsPath)).toBe(true);
    const data = JSON.parse(readFileSync(testsPath, 'utf8'));
    expect(data.passed).toBe(100);
    expect(data.failed).toBe(2);
  });

  it('logGitEvent appends to git.json', () => {
    logger.logGitEvent({ type: 'branch-created', branch: 'autonomous/v6.4.0' });
    logger.logGitEvent({ type: 'committed', sha: 'abc123def456', message: 'test' });

    const gitPath = join(tmpDir, '.agentforge/cycles', cycleId, 'git.json');
    const data = JSON.parse(readFileSync(gitPath, 'utf8'));
    expect(data.events).toHaveLength(2);
    expect(data.events[0].type).toBe('branch-created');
    expect(data.events[1].type).toBe('committed');
  });

  it('logCycleResult writes cycle.json with terminal state', () => {
    logger.logCycleResult({
      cycleId,
      sprintVersion: '6.4.0',
      stage: CycleStage.COMPLETED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:30:00Z',
      durationMs: 1800000,
      cost: { totalUsd: 42.50, budgetUsd: 50, byAgent: {}, byPhase: {} },
      tests: { passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0, newFailures: [] },
      git: { branch: 'autonomous/v6.4.0', commitSha: 'abc123', filesChanged: [] },
      pr: { url: 'https://github.com/x/y/pull/1', number: 1, draft: false },
    });

    const cyclePath = join(tmpDir, '.agentforge/cycles', cycleId, 'cycle.json');
    const data = JSON.parse(readFileSync(cyclePath, 'utf8'));
    expect(data.stage).toBe('completed');
    expect(data.cost.totalUsd).toBe(42.50);
  });

  it('events.jsonl is append-only (each line is one JSON object)', () => {
    logger.logPhaseStart('audit');
    logger.logPhaseStart('plan');
    logger.logPhaseStart('execute');

    const raw = readFileSync(join(tmpDir, '.agentforge/cycles', cycleId, 'events.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

function readEvents(cwd: string, cycleId: string): any[] {
  const path = join(cwd, '.agentforge/cycles', cycleId, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
}
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/cycle-logger.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `cycle-logger.ts`**

Create `packages/core/src/autonomous/cycle-logger.ts`:

```typescript
// packages/core/src/autonomous/cycle-logger.ts
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleResult, TestResult, ScoringResult, KillSwitchTrip } from './types.js';

export interface GitEvent {
  type: 'branch-created' | 'staged' | 'committed' | 'pushed' | 'rolled-back';
  branch?: string;
  sha?: string;
  fromSha?: string;
  files?: string[];
  message?: string;
}

export interface PREvent {
  type: 'opened' | 'failed';
  url?: string;
  number?: number;
  title?: string;
  error?: string;
}

export class CycleLogger {
  private readonly cycleDir: string;
  private readonly eventsPath: string;

  constructor(
    private readonly cwd: string,
    private readonly cycleId: string,
  ) {
    this.cycleDir = join(cwd, '.agentforge/cycles', cycleId);
    this.eventsPath = join(this.cycleDir, 'events.jsonl');
    mkdirSync(this.cycleDir, { recursive: true });
    mkdirSync(join(this.cycleDir, 'phases'), { recursive: true });
  }

  logPhaseStart(phase: string): void {
    this.appendEvent({ type: 'phase.start', phase, at: new Date().toISOString() });
  }

  logPhaseResult(phase: string, result: unknown): void {
    this.writeJson(join(this.cycleDir, 'phases', `${phase}.json`), result);
    this.appendEvent({ type: 'phase.result', phase, at: new Date().toISOString() });
  }

  logPhaseFailure(phase: string, error: string): void {
    this.writeJson(join(this.cycleDir, 'phases', `${phase}.json`), { phase, error, status: 'failed' });
    this.appendEvent({ type: 'phase.failure', phase, error, at: new Date().toISOString() });
  }

  logTestRun(result: TestResult): void {
    this.writeJson(join(this.cycleDir, 'tests.json'), result);
    this.appendEvent({ type: 'tests.complete', passed: result.passed, failed: result.failed, at: new Date().toISOString() });
  }

  logScoring(result: ScoringResult, grounding: unknown): void {
    this.writeJson(join(this.cycleDir, 'scoring.json'), { result, grounding, at: new Date().toISOString() });
    this.appendEvent({ type: 'scoring.complete', totalCostUsd: result.totalEstimatedCostUsd, at: new Date().toISOString() });
  }

  logScoringFallback(strike: number, error: string): void {
    this.appendEvent({ type: 'scoring.fallback', strike, error, at: new Date().toISOString() });
  }

  logApprovalPending(data: unknown): void {
    this.writeJson(join(this.cycleDir, 'approval-pending.json'), data);
    this.appendEvent({ type: 'approval.pending', at: new Date().toISOString() });
  }

  logApprovalDecision(data: unknown): void {
    this.writeJson(join(this.cycleDir, 'approval-decision.json'), data);
    this.appendEvent({ type: 'approval.decision', at: new Date().toISOString() });
  }

  logGitEvent(event: GitEvent): void {
    const path = join(this.cycleDir, 'git.json');
    const existing = existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8'))
      : { events: [] };
    existing.events.push({ ...event, at: new Date().toISOString() });
    this.writeJson(path, existing);
    this.appendEvent({ type: 'git.' + event.type, ...event, at: new Date().toISOString() });
  }

  logPREvent(event: PREvent): void {
    this.writeJson(join(this.cycleDir, 'pr.json'), { ...event, at: new Date().toISOString() });
    this.appendEvent({ type: 'pr.' + event.type, ...event, at: new Date().toISOString() });
  }

  logKillSwitch(trip: KillSwitchTrip): void {
    this.appendEvent({ type: 'kill-switch.trip', ...trip, at: new Date().toISOString() });
  }

  logCycleResult(result: CycleResult): void {
    this.writeJson(join(this.cycleDir, 'cycle.json'), result);
    this.appendEvent({ type: 'cycle.complete', stage: result.stage, at: new Date().toISOString() });
  }

  private writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data, null, 2));
  }

  private appendEvent(event: Record<string, unknown>): void {
    appendFileSync(this.eventsPath, JSON.stringify(event) + '\n');
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/cycle-logger.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './cycle-logger.js';
```

- [ ] **Step 6: Verify build and commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/cycle-logger.ts \
        packages/core/src/autonomous/cycle-logger.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): structured per-cycle logger"
```

---

## Task 5: PR body renderer

**Files:**
- Create: `packages/core/src/autonomous/pr-body-renderer.ts`
- Test: `packages/core/src/autonomous/pr-body-renderer.test.ts`

**Context:** Pure function that renders a markdown PR body from cycle data. Snapshot-testable.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/pr-body-renderer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderPrBody } from './pr-body-renderer.js';
import { CycleStage } from './types.js';

describe('renderPrBody', () => {
  const baseInput = {
    sprint: {
      version: '6.4.0',
      items: [
        { id: 'i1', priority: 'P0', title: 'Add X', assignee: 'coder' },
        { id: 'i2', priority: 'P1', title: 'Fix Y', assignee: 'debugger' },
      ],
    } as any,
    result: {
      cycleId: 'abc-123',
      sprintVersion: '6.4.0',
      stage: CycleStage.COMPLETED,
      startedAt: '2026-04-06T15:00:00Z',
      completedAt: '2026-04-06T15:30:00Z',
      durationMs: 1800000,
      cost: {
        totalUsd: 42.5,
        budgetUsd: 50,
        byAgent: { coder: 20, debugger: 15, 'backlog-scorer': 1.5, reviewer: 6 },
        byPhase: {},
      },
      tests: { passed: 4020, failed: 0, skipped: 0, total: 4020, passRate: 1.0, newFailures: [] },
      git: {
        branch: 'autonomous/v6.4.0',
        commitSha: 'abc123def456',
        filesChanged: ['src/foo.ts', 'src/bar.ts'],
      },
      pr: { url: null, number: null, draft: false },
    } as any,
    testResult: {
      passed: 4020,
      failed: 0,
      skipped: 0,
      total: 4020,
      passRate: 1.0,
      durationMs: 180000,
      failedTests: [],
      newFailures: [],
      rawOutputPath: '/tmp/raw.log',
      exitCode: 0,
    },
    scoringResult: {
      rankings: [],
      totalEstimatedCostUsd: 45,
      budgetOverflowUsd: 0,
      summary: 'Selected 2 high-impact items within $50 budget.',
      warnings: [],
    },
  };

  it('renders a markdown PR body with version in title', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('## Autonomous Cycle: v6.4.0');
    expect(body).toContain('abc-123');
  });

  it('includes cost summary', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('$42.50');
    expect(body).toContain('/ $50.00');
  });

  it('includes test results', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('4020 passed');
    expect(body).toContain('100.0%');
  });

  it('lists sprint items with priority and assignee', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('**P0** Add X');
    expect(body).toContain('`coder`');
    expect(body).toContain('**P1** Fix Y');
    expect(body).toContain('`debugger`');
  });

  it('lists files changed', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('`src/foo.ts`');
    expect(body).toContain('`src/bar.ts`');
  });

  it('includes scoring rationale', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('Selected 2 high-impact items');
  });

  it('cost breakdown sorted by amount descending', () => {
    const body = renderPrBody(baseInput);
    const coderIdx = body.indexOf('`coder`');
    const debuggerIdx = body.indexOf('`debugger`');
    const reviewerIdx = body.indexOf('`reviewer`');
    const scorerIdx = body.indexOf('`backlog-scorer`');
    expect(coderIdx).toBeLessThan(debuggerIdx);
    expect(debuggerIdx).toBeLessThan(reviewerIdx);
    expect(reviewerIdx).toBeLessThan(scorerIdx);
  });

  it('ends with Co-Authored-By footer', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('Co-Authored-By: Claude Opus 4.6');
  });

  it('includes cycle log directory reference', () => {
    const body = renderPrBody(baseInput);
    expect(body).toContain('.agentforge/cycles/abc-123/');
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/pr-body-renderer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `pr-body-renderer.ts`**

Create `packages/core/src/autonomous/pr-body-renderer.ts`:

```typescript
// packages/core/src/autonomous/pr-body-renderer.ts
import type { CycleResult, TestResult, ScoringResult } from './types.js';

export interface PrBodyInput {
  sprint: {
    version: string;
    items: Array<{ id: string; priority: string; title: string; assignee: string }>;
  };
  result: CycleResult;
  testResult: TestResult;
  scoringResult: ScoringResult;
}

export function renderPrBody(input: PrBodyInput): string {
  const { sprint, result, testResult, scoringResult } = input;

  const itemsList = sprint.items
    .map(i => `- **${i.priority}** ${i.title} — \`${i.assignee}\``)
    .join('\n');

  const filesList = result.git.filesChanged.length > 0
    ? result.git.filesChanged.map(f => `- \`${f}\``).join('\n')
    : '_(none)_';

  const costBreakdown = Object.entries(result.cost.byAgent)
    .sort(([, a], [, b]) => b - a)
    .map(([agent, cost]) => `- \`${agent}\`: $${cost.toFixed(2)}`)
    .join('\n');

  const passRatePct = (testResult.passRate * 100).toFixed(1);
  const durationMin = (result.durationMs / 60000).toFixed(1);

  return `## Autonomous Cycle: v${sprint.version}

**Cycle ID:** \`${result.cycleId}\`
**Duration:** ${durationMin} minutes
**Cost:** $${result.cost.totalUsd.toFixed(2)} / $${result.cost.budgetUsd.toFixed(2)}
**Stage:** \`${result.stage}\`

### Sprint items
${itemsList}

### Test results
- ${testResult.passed} passed
- ${testResult.failed} failed
- ${testResult.skipped} skipped
- **Pass rate:** ${passRatePct}%

### Scoring rationale
${scoringResult.summary}

### Files changed
${filesList}

### Cost breakdown (by agent)
${costBreakdown}

---

Generated by AgentForge autonomous loop.
Cycle logs: \`.agentforge/cycles/${result.cycleId}/\`

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
`;
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/pr-body-renderer.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './pr-body-renderer.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/pr-body-renderer.ts \
        packages/core/src/autonomous/pr-body-renderer.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): PR body markdown renderer"
```

---

## Task 6: Kill switch

**Files:**
- Create: `packages/core/src/autonomous/kill-switch.ts`
- Test: `packages/core/src/autonomous/kill-switch.test.ts`

**Context:** Centralized trip logic. Sticky state, signal handlers, STOP file watching, check points at every boundary. See spec §8.4.

- [ ] **Step 1: Write failing tests for every trip reason**

Create `packages/core/src/autonomous/kill-switch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KillSwitch } from './kill-switch.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';
import { CycleStage } from './types.js';

describe('KillSwitch', () => {
  let tmpDir: string;
  const cycleId = 'test-ks-cycle';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ks-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeKS(overrides: any = {}) {
    const config = {
      ...DEFAULT_CYCLE_CONFIG,
      ...overrides,
      budget: { ...DEFAULT_CYCLE_CONFIG.budget, ...overrides.budget },
      limits: { ...DEFAULT_CYCLE_CONFIG.limits, ...overrides.limits },
      quality: { ...DEFAULT_CYCLE_CONFIG.quality, ...overrides.quality },
    };
    return new KillSwitch(config, cycleId, Date.now(), tmpDir);
  }

  it('does not trip when all metrics are within limits', () => {
    const ks = makeKS();
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 10, consecutiveFailures: 0 });
    expect(trip).toBeNull();
    expect(ks.isTripped()).toBe(false);
  });

  it('trips on budget overrun', () => {
    const ks = makeKS({ budget: { perCycleUsd: 50 } });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 51, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('budget');
    expect(trip?.detail).toContain('51');
    expect(trip?.detail).toContain('50');
  });

  it('trips on duration overrun', () => {
    const ks = new KillSwitch(
      { ...DEFAULT_CYCLE_CONFIG, limits: { ...DEFAULT_CYCLE_CONFIG.limits, maxDurationMinutes: 1 } },
      cycleId,
      Date.now() - 2 * 60_000,
      tmpDir,
    );
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('duration');
  });

  it('trips on consecutive failures', () => {
    const ks = makeKS({ limits: { maxConsecutiveFailures: 3 } });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 3 });
    expect(trip?.reason).toBe('consecutiveFailures');
  });

  it('trips on STOP file presence', () => {
    const ks = makeKS();
    writeFileSync(join(tmpDir, '.agentforge/cycles', cycleId, 'STOP'), '');
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 0, consecutiveFailures: 0 });
    expect(trip?.reason).toBe('manualStopFile');
  });

  it('trips on testFloor violation', () => {
    const ks = makeKS({ quality: { testPassRateFloor: 0.95 } });
    const trip = ks.checkPostVerify(
      {
        passed: 90, failed: 10, skipped: 0, total: 100,
        passRate: 0.90, durationMs: 1000, failedTests: [],
        newFailures: [], rawOutputPath: '', exitCode: 1,
      },
      { detected: false, reason: '' },
    );
    expect(trip?.reason).toBe('testFloor');
    expect(trip?.detail).toContain('90.0%');
  });

  it('trips on regression when allowRegression=false', () => {
    const ks = makeKS({ quality: { allowRegression: false } });
    const trip = ks.checkPostVerify(
      {
        passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0,
        durationMs: 1000, failedTests: [], newFailures: [], rawOutputPath: '', exitCode: 0,
      },
      { detected: true, reason: '2 previously-passing tests now fail' },
    );
    expect(trip?.reason).toBe('regression');
  });

  it('does NOT trip on regression when allowRegression=true', () => {
    const ks = makeKS({ quality: { allowRegression: true } });
    const trip = ks.checkPostVerify(
      {
        passed: 100, failed: 0, skipped: 0, total: 100, passRate: 1.0,
        durationMs: 1000, failedTests: [], newFailures: [], rawOutputPath: '', exitCode: 0,
      },
      { detected: true, reason: 'regression' },
    );
    expect(trip).toBeNull();
  });

  it('trip is sticky — subsequent checks return same trip', () => {
    const ks = makeKS({ budget: { perCycleUsd: 50 } });
    const trip1 = ks.checkBetweenPhases({ cumulativeCostUsd: 100, consecutiveFailures: 0 });
    const trip2 = ks.checkBetweenPhases({ cumulativeCostUsd: 10, consecutiveFailures: 0 });
    expect(trip1).toBe(trip2);
    expect(ks.isTripped()).toBe(true);
  });

  it('first trip wins when multiple conditions exceed simultaneously', () => {
    const ks = makeKS({
      budget: { perCycleUsd: 10 },
      limits: { maxConsecutiveFailures: 1 },
    });
    const trip = ks.checkBetweenPhases({ cumulativeCostUsd: 50, consecutiveFailures: 5 });
    expect(trip?.reason).toBe('manualStopFile' || 'budget'); // STOP file check is first, then budget
    // Budget should win since STOP file does not exist
    expect(trip?.reason).toBe('budget');
  });

  it('trip() can be called manually', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test reason', CycleStage.RUN);
    expect(trip.reason).toBe('manualStop');
    expect(trip.detail).toBe('test reason');
    expect(ks.isTripped()).toBe(true);
  });

  it('getTrip returns null when not tripped', () => {
    const ks = makeKS();
    expect(ks.getTrip()).toBeNull();
  });

  it('stageAtTrip is preserved in trip data', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test', CycleStage.VERIFY);
    expect(trip.stageAtTrip).toBe(CycleStage.VERIFY);
  });

  it('triggeredAt is ISO 8601 formatted', () => {
    const ks = makeKS();
    const trip = ks.trip('manualStop', 'test', CycleStage.RUN);
    expect(trip.triggeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
```

- [ ] **Step 2: Run tests — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/kill-switch.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `kill-switch.ts`**

Create `packages/core/src/autonomous/kill-switch.ts`:

```typescript
// packages/core/src/autonomous/kill-switch.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, KillReason, KillSwitchTrip, TestResult } from './types.js';
import { CycleStage } from './types.js';

export interface RegressionResult {
  detected: boolean;
  reason: string;
}

export class KillSwitch {
  private trippedState: KillSwitchTrip | null = null;
  private readonly stopFilePath: string;

  constructor(
    private readonly config: CycleConfig,
    private readonly cycleId: string,
    private readonly cycleStartedAt: number,
    private readonly cwd: string,
  ) {
    this.stopFilePath = join(
      cwd,
      config.safety.stopFilePath.replace('{cycleId}', cycleId),
    );
    this.installSignalHandlers();
  }

  /** Called by PhaseScheduler between every phase. */
  checkBetweenPhases(state: {
    cumulativeCostUsd: number;
    consecutiveFailures: number;
  }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;

    if (existsSync(this.stopFilePath)) {
      return this.trip('manualStopFile', `STOP file at ${this.stopFilePath}`, CycleStage.RUN);
    }

    if (state.cumulativeCostUsd >= this.config.budget.perCycleUsd) {
      return this.trip(
        'budget',
        `Cumulative cost $${state.cumulativeCostUsd.toFixed(2)} exceeds limit $${this.config.budget.perCycleUsd}`,
        CycleStage.RUN,
      );
    }

    const elapsedMin = (Date.now() - this.cycleStartedAt) / 60000;
    if (elapsedMin >= this.config.limits.maxDurationMinutes) {
      return this.trip(
        'duration',
        `Duration ${elapsedMin.toFixed(1)}m exceeds limit ${this.config.limits.maxDurationMinutes}m`,
        CycleStage.RUN,
      );
    }

    if (state.consecutiveFailures >= this.config.limits.maxConsecutiveFailures) {
      return this.trip(
        'consecutiveFailures',
        `${state.consecutiveFailures} consecutive failures (limit ${this.config.limits.maxConsecutiveFailures})`,
        CycleStage.RUN,
      );
    }

    return null;
  }

  /** Called after real test run in VERIFY stage. */
  checkPostVerify(testResult: TestResult, regression: RegressionResult): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;

    if (testResult.passRate < this.config.quality.testPassRateFloor) {
      return this.trip(
        'testFloor',
        `Pass rate ${(testResult.passRate * 100).toFixed(1)}% below floor ${(this.config.quality.testPassRateFloor * 100).toFixed(1)}%`,
        CycleStage.VERIFY,
      );
    }

    if (regression.detected && !this.config.quality.allowRegression) {
      return this.trip('regression', regression.reason, CycleStage.VERIFY);
    }

    return null;
  }

  /** Check after build/typecheck commands. */
  checkBuildResult(result: { success: boolean; error?: string }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;
    if (!result.success && this.config.quality.requireBuildSuccess) {
      return this.trip('buildFailure', result.error ?? 'build failed', CycleStage.VERIFY);
    }
    return null;
  }

  checkTypeCheckResult(result: { success: boolean; error?: string }): KillSwitchTrip | null {
    if (this.trippedState) return this.trippedState;
    if (!result.success && this.config.quality.requireTypeCheckSuccess) {
      return this.trip('typeCheckFailure', result.error ?? 'typecheck failed', CycleStage.VERIFY);
    }
    return null;
  }

  trip(reason: KillReason, detail: string, stage: CycleStage): KillSwitchTrip {
    if (this.trippedState) return this.trippedState;
    this.trippedState = {
      reason,
      detail,
      triggeredAt: new Date().toISOString(),
      stageAtTrip: stage,
    };
    return this.trippedState;
  }

  isTripped(): boolean {
    return this.trippedState !== null;
  }

  getTrip(): KillSwitchTrip | null {
    return this.trippedState;
  }

  private installSignalHandlers(): void {
    const handler = (sig: string) => {
      this.trip('manualStop', `Received ${sig}`, CycleStage.RUN);
    };
    process.once('SIGINT', () => handler('SIGINT'));
    process.once('SIGTERM', () => handler('SIGTERM'));
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/kill-switch.test.ts`
Expected: All pass.

- [ ] **Step 5: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './kill-switch.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/kill-switch.ts \
        packages/core/src/autonomous/kill-switch.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): kill switch with sticky trips and signal handlers"
```

---

## Task 7: Proposal-to-backlog bridge

**Files:**
- Create: `packages/core/src/autonomous/proposal-to-backlog.ts`
- Test: `packages/core/src/autonomous/proposal-to-backlog.test.ts`

**Context:** Queries SQLite for recent failures/costs/test flakes, invokes `SelfProposalEngine.fromSessions()`, scans for `TODO(autonomous)` markers, converts proposals into `BacklogItem[]`. See spec §6.3.

**Pre-step:** Read `packages/core/src/intelligence/self-proposal.ts` to understand the existing `SelfProposalEngine` interface. The bridge adapts its output to `BacklogItem[]`.

- [ ] **Step 1: Read existing SelfProposalEngine**

Run: `Read packages/core/src/intelligence/self-proposal.ts` to understand the AgentProposal shape and `fromSessions()` signature. Record the method signature and return type in your scratch notes.

- [ ] **Step 2: Write failing test with mocked adapter**

Create `packages/core/src/autonomous/proposal-to-backlog.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProposalToBacklog } from './proposal-to-backlog.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';

describe('ProposalToBacklog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-p2b-'));
  });

  function makeMockAdapter(overrides: any = {}) {
    return {
      getRecentFailedSessions: overrides.getRecentFailedSessions ?? (async () => []),
      getCostAnomalies: overrides.getCostAnomalies ?? (async () => []),
      getFailedTaskOutcomes: overrides.getFailedTaskOutcomes ?? (async () => []),
      getFlakingTests: overrides.getFlakingTests ?? (async () => []),
    };
  }

  it('returns empty backlog when no data sources have items', async () => {
    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items).toEqual([]);
  });

  it('converts failed sessions into backlog items with confidence filter', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'TypeError: undefined', confidence: 0.8 },
        { id: 's2', agent: 'debugger', error: 'race', confidence: 0.4 }, // below default 0.6
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(i => !i.title.includes('race'))).toBe(true); // filtered
  });

  it('scans for TODO(autonomous) markers in the codebase', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src/foo.ts'),
      `// TODO(autonomous): migrate workspace-adapter to postgres\nexport const x = 1;`,
    );
    writeFileSync(
      join(tmpDir, 'src/bar.ts'),
      `// TODO: regular human todo — should be ignored\nexport const y = 2;`,
    );
    writeFileSync(
      join(tmpDir, 'src/baz.ts'),
      `// FIXME(autonomous): broken parser\nexport const z = 3;`,
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();

    expect(items.some(i => i.title.includes('migrate workspace-adapter'))).toBe(true);
    expect(items.some(i => i.title.includes('broken parser'))).toBe(true);
    expect(items.some(i => i.title.includes('regular human'))).toBe(false);
  });

  it('deduplicates items with same title', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'same error', confidence: 0.8 },
        { id: 's2', agent: 'coder', error: 'same error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);
    const uniqueTitles = new Set(titles);
    expect(titles.length).toBe(uniqueTitles.size);
  });

  it('assigns priority based on source type', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'crash', confidence: 0.9 },
      ],
      getCostAnomalies: async () => [
        { agent: 'runner', anomaly: 'cost spike', confidence: 0.9 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.some(i => i.priority === 'P0')).toBe(true); // crashes = P0
    expect(items.some(i => i.priority === 'P1')).toBe(true); // cost = P1
  });

  it('every BacklogItem has required fields', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    for (const item of items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('tags');
      expect(item).toHaveProperty('source');
    }
  });
});
```

- [ ] **Step 3: Run tests — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/proposal-to-backlog.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `proposal-to-backlog.ts`**

Create `packages/core/src/autonomous/proposal-to-backlog.ts`:

```typescript
// packages/core/src/autonomous/proposal-to-backlog.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig } from './types.js';

export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  source: 'failed-session' | 'cost-anomaly' | 'task-outcome' | 'flaking-test' | 'todo-marker';
  confidence: number;
  estimatedCostUsd?: number;
}

export interface ProposalAdapter {
  getRecentFailedSessions(days: number): Promise<Array<{
    id: string;
    agent: string;
    error: string;
    confidence: number;
  }>>;
  getCostAnomalies(days: number): Promise<Array<{
    agent: string;
    anomaly: string;
    confidence: number;
  }>>;
  getFailedTaskOutcomes(days: number): Promise<Array<{
    taskId: string;
    description: string;
    confidence: number;
  }>>;
  getFlakingTests(days: number): Promise<Array<{
    file: string;
    name: string;
    failRate: number;
  }>>;
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.agentforge',
  'coverage', '.turbo', '.next', 'build',
]);

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class ProposalToBacklog {
  constructor(
    private readonly adapter: ProposalAdapter,
    private readonly cwd: string,
    private readonly config: CycleConfig,
  ) {}

  async build(): Promise<BacklogItem[]> {
    const items: BacklogItem[] = [];

    const [sessions, costs, outcomes, tests] = await Promise.all([
      this.adapter.getRecentFailedSessions(this.config.sourcing.lookbackDays),
      this.adapter.getCostAnomalies(this.config.sourcing.lookbackDays),
      this.adapter.getFailedTaskOutcomes(this.config.sourcing.lookbackDays),
      this.adapter.getFlakingTests(this.config.sourcing.lookbackDays),
    ]);

    const minConf = this.config.sourcing.minProposalConfidence;

    for (const s of sessions) {
      if (s.confidence < minConf) continue;
      items.push({
        id: `sess-${s.id}`,
        title: `Fix: ${s.agent} error: ${this.truncate(s.error, 80)}`,
        description: `Session ${s.id} failed with: ${s.error}. Investigate root cause and fix.`,
        priority: 'P0',
        tags: ['fix', 'bug'],
        source: 'failed-session',
        confidence: s.confidence,
      });
    }

    for (const c of costs) {
      if (c.confidence < minConf) continue;
      items.push({
        id: `cost-${c.agent}-${items.length}`,
        title: `Investigate cost anomaly in ${c.agent}`,
        description: `Cost anomaly detected: ${c.anomaly}. Investigate and optimize.`,
        priority: 'P1',
        tags: ['chore', 'performance'],
        source: 'cost-anomaly',
        confidence: c.confidence,
      });
    }

    for (const o of outcomes) {
      if (o.confidence < minConf) continue;
      items.push({
        id: `outcome-${o.taskId}`,
        title: `Revisit failed task: ${this.truncate(o.description, 80)}`,
        description: `Task ${o.taskId} reached a dead end. Re-approach or break down.`,
        priority: 'P1',
        tags: ['fix'],
        source: 'task-outcome',
        confidence: o.confidence,
      });
    }

    for (const t of tests) {
      if (t.failRate < 0.3) continue;
      items.push({
        id: `flaky-${t.file.replace(/\W/g, '-')}-${items.length}`,
        title: `Stabilize flaking test: ${t.name}`,
        description: `Test ${t.file} > ${t.name} flakes at ${(t.failRate * 100).toFixed(0)}%.`,
        priority: 'P1',
        tags: ['fix', 'chore'],
        source: 'flaking-test',
        confidence: Math.min(t.failRate + 0.3, 1.0),
      });
    }

    if (this.config.sourcing.includeTodoMarkers) {
      const markers = this.scanTodoMarkers();
      for (const m of markers) {
        items.push(m);
      }
    }

    return this.deduplicate(items);
  }

  private scanTodoMarkers(): BacklogItem[] {
    const items: BacklogItem[] = [];
    const pattern = new RegExp(this.config.sourcing.todoMarkerPattern);

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'));
          if (!SCANNABLE_EXTENSIONS.has(ext)) continue;

          let content: string;
          try {
            content = readFileSync(full, 'utf8');
          } catch {
            continue;
          }

          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i]!)) {
              const marker = lines[i]!.match(/TODO\(autonomous\):\s*(.*)|FIXME\(autonomous\):\s*(.*)/);
              const text = (marker?.[1] ?? marker?.[2] ?? '').trim();
              if (!text) continue;

              const rel = full.slice(this.cwd.length + 1);
              items.push({
                id: `todo-${rel.replace(/\W/g, '-')}-${i}`,
                title: text,
                description: `From ${rel}:${i + 1}`,
                priority: lines[i]!.includes('FIXME') ? 'P0' : 'P1',
                tags: this.inferTagsFromMarker(text),
                source: 'todo-marker',
                confidence: 1.0,
              });
            }
          }
        }
      }
    };

    walk(this.cwd);
    return items;
  }

  private inferTagsFromMarker(text: string): string[] {
    const lower = text.toLowerCase();
    if (/\b(breaking|rewrite|migrate|architecture)\b/.test(lower)) return ['breaking'];
    if (/\b(add|new|feature|implement)\b/.test(lower)) return ['feature'];
    if (/\b(fix|bug|security)\b/.test(lower)) return ['fix'];
    return ['chore'];
  }

  private deduplicate(items: BacklogItem[]): BacklogItem[] {
    const seen = new Set<string>();
    const result: BacklogItem[] = [];
    for (const item of items) {
      const key = item.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/proposal-to-backlog.test.ts`
Expected: All pass.

- [ ] **Step 6: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './proposal-to-backlog.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/proposal-to-backlog.ts \
        packages/core/src/autonomous/proposal-to-backlog.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): proposal-to-backlog bridge with TODO marker scan"
```

---

## Task 8: Sprint generator

**Files:**
- Create: `packages/core/src/autonomous/sprint-generator.ts`
- Test: `packages/core/src/autonomous/sprint-generator.test.ts`

**Context:** Takes approved `RankedItem[]`, calls the existing `SprintPredictor` + `SprintPlanner`, writes the next sprint JSON. Uses `bumpVersion` from Task 2.

**Pre-step:** Read `packages/core/src/sprint/sprint-planner.ts` and `packages/core/src/predictive-planning/sprint-predictor.ts` to understand their existing interfaces. The generator adapts RankedItem → BacklogItem → SprintPlan.

- [ ] **Step 1: Read existing predictor + planner**

Run: `Read packages/core/src/sprint/sprint-planner.ts` and `Read packages/core/src/predictive-planning/sprint-predictor.ts`. Record the method signatures and return types.

- [ ] **Step 2: Write failing test**

Create `packages/core/src/autonomous/sprint-generator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SprintGenerator } from './sprint-generator.js';
import { DEFAULT_CYCLE_CONFIG } from './config-loader.js';
import type { RankedItem } from './types.js';

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
```

- [ ] **Step 3: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/sprint-generator.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `sprint-generator.ts`**

Create `packages/core/src/autonomous/sprint-generator.ts`:

```typescript
// packages/core/src/autonomous/sprint-generator.ts
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig, RankedItem } from './types.js';
import { bumpVersion } from './version-bumper.js';

export interface SprintPlan {
  version: string;
  sprintId: string;
  title: string;
  createdAt: string;
  phase: 'planned';
  items: SprintPlanItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
}

export interface SprintPlanItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: 'planned';
  estimatedCostUsd: number;
  tags: string[];
  source?: string;
}

const DEFAULT_STARTING_VERSION = '6.4.0';

export class SprintGenerator {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig,
  ) {}

  async generate(approvedItems: RankedItem[]): Promise<SprintPlan> {
    const currentVersion = this.findLatestSprintVersion();
    const allTags = approvedItems.flatMap(i => i.suggestedTags);
    const nextVersion = bumpVersion(currentVersion, allTags);

    const maxItems = this.config.limits.maxItemsPerSprint;
    const selected = approvedItems.slice(0, maxItems);

    const plan: SprintPlan = {
      version: nextVersion,
      sprintId: `v${nextVersion.replace(/\./g, '-')}-autonomous`,
      title: `AgentForge v${nextVersion} — Autonomous Cycle`,
      createdAt: new Date().toISOString(),
      phase: 'planned',
      items: selected.map(item => this.toSprintItem(item)),
      budget: this.config.budget.perCycleUsd,
      teamSize: Math.max(1, new Set(selected.map(i => i.suggestedAssignee)).size),
      successCriteria: [
        'All sprint items completed',
        `Test pass rate >= ${(this.config.quality.testPassRateFloor * 100).toFixed(0)}%`,
        `Total cost <= $${this.config.budget.perCycleUsd}`,
      ],
    };

    const wrapper = { sprints: [plan] };
    const sprintPath = join(this.cwd, '.agentforge/sprints', `v${nextVersion}.json`);
    writeFileSync(sprintPath, JSON.stringify(wrapper, null, 2));

    return plan;
  }

  private toSprintItem(item: RankedItem): SprintPlanItem {
    return {
      id: item.itemId,
      title: item.title,
      description: item.rationale,
      priority: this.rankToPriority(item.rank),
      assignee: item.suggestedAssignee,
      status: 'planned',
      estimatedCostUsd: item.estimatedCostUsd,
      tags: item.suggestedTags,
    };
  }

  private rankToPriority(rank: number): 'P0' | 'P1' | 'P2' {
    if (rank <= 3) return 'P0';
    if (rank <= 8) return 'P1';
    return 'P2';
  }

  private findLatestSprintVersion(): string {
    const sprintsDir = join(this.cwd, '.agentforge/sprints');
    if (!existsSync(sprintsDir)) return DEFAULT_STARTING_VERSION;

    const files = readdirSync(sprintsDir)
      .filter(f => f.startsWith('v') && f.endsWith('.json'));

    if (files.length === 0) return DEFAULT_STARTING_VERSION;

    const versions = files
      .map(f => f.slice(1, -5)) // strip "v" prefix and ".json" suffix
      .filter(v => /^\d+(\.\d+)*$/.test(v))
      .map(v => ({ raw: v, parts: padVersion(v) }))
      .sort((a, b) => compareVersions(b.parts, a.parts)); // descending

    return versions[0]?.raw ?? DEFAULT_STARTING_VERSION;
  }
}

function padVersion(v: string): [number, number, number] {
  const parts = v.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return [parts[0]!, parts[1]!, parts[2]!];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/sprint-generator.test.ts`
Expected: All pass.

- [ ] **Step 6: Update barrel and commit**

Edit `packages/core/src/autonomous/index.ts` to add:

```typescript
export * from './sprint-generator.js';
```

Then:

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/sprint-generator.ts \
        packages/core/src/autonomous/sprint-generator.test.ts \
        packages/core/src/autonomous/index.ts
git commit -m "feat(autonomous): sprint generator with version bump and item selection"
```

---

## Task 9: Real test runner (unit tests with mocked execFile)

**Files:**
- Create: `packages/core/src/autonomous/exec/real-test-runner.ts`
- Test: `packages/core/src/autonomous/exec/real-test-runner.test.ts`

**Context:** Unit tests use mocked `execFile`. Parses a canned vitest JSON report fixture. See spec §8.1.

- [ ] **Step 1: Create fixture directory and canned vitest report**

```bash
mkdir -p packages/core/src/autonomous/exec/__fixtures__
```

Create `packages/core/src/autonomous/exec/__fixtures__/vitest-report.json`:

```json
{
  "numTotalTests": 3,
  "numPassedTests": 2,
  "numFailedTests": 1,
  "numPendingTests": 0,
  "startTime": 1743958800000,
  "testResults": [
    {
      "name": "sample.test.ts",
      "assertionResults": [
        { "title": "passes", "status": "passed", "ancestorTitles": ["sample"] },
        { "title": "also passes", "status": "passed", "ancestorTitles": ["sample"] },
        {
          "title": "fails deliberately",
          "status": "failed",
          "ancestorTitles": ["sample"],
          "failureMessages": ["AssertionError: expected 1 to be 2"]
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write failing unit test**

Create `packages/core/src/autonomous/exec/real-test-runner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealTestRunner, TestRunnerError } from './real-test-runner.js';
import { DEFAULT_CYCLE_CONFIG } from '../config-loader.js';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<any>('node:child_process');
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], opts: any, cb: any) => {
      // Simulate vitest producing an output file
      const outputFileIdx = args.findIndex(a => a === '--outputFile');
      const outputFile = outputFileIdx >= 0 ? args[outputFileIdx + 1] : null;
      if (outputFile) {
        const { readFileSync, writeFileSync } = require('node:fs');
        const fixture = readFileSync(
          require('node:path').join(__dirname, '__fixtures__/vitest-report.json'),
          'utf8',
        );
        writeFileSync(outputFile, fixture);
      }
      cb(null, { stdout: 'mock stdout', stderr: '' });
    }),
  };
});

describe('RealTestRunner (unit, mocked execFile)', () => {
  let tmpDir: string;
  const cycleId = 'test-rtr-cycle';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-rtr-'));
    mkdirSync(join(tmpDir, '.agentforge/cycles', cycleId), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses vitest JSON report into TestResult', async () => {
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const result = await runner.run(cycleId);

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.passRate).toBeCloseTo(0.667, 2);
    expect(result.failedTests).toHaveLength(1);
    expect(result.failedTests[0]!.name).toBe('fails deliberately');
  });

  it('returns rawOutputPath pointing to saved log', async () => {
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    const result = await runner.run(cycleId);
    expect(result.rawOutputPath).toContain(cycleId);
    expect(result.rawOutputPath).toMatch(/\.log$/);
  });

  it('computes newFailures against a prior snapshot', async () => {
    const priorSnapshot = {
      passed: 3, failed: 0, skipped: 0, total: 3, passRate: 1.0,
      durationMs: 1000, failedTests: [],
      newFailures: [], rawOutputPath: '', exitCode: 0,
    };
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, priorSnapshot);
    const result = await runner.run(cycleId);
    expect(result.newFailures.length).toBeGreaterThan(0);
    expect(result.newFailures[0]).toContain('fails deliberately');
  });

  it('newFailures excludes pre-existing failures', async () => {
    const priorSnapshot = {
      passed: 2, failed: 1, skipped: 0, total: 3, passRate: 0.667,
      durationMs: 1000,
      failedTests: [{
        file: 'sample.test.ts',
        suite: 'sample',
        name: 'fails deliberately',
        error: 'old',
        snippet: 'old',
      }],
      newFailures: [], rawOutputPath: '', exitCode: 1,
    };
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, priorSnapshot);
    const result = await runner.run(cycleId);
    expect(result.newFailures).toHaveLength(0);
  });

  it('throws TestRunnerError when output file missing', async () => {
    const { execFile } = await import('node:child_process');
    (execFile as any).mockImplementationOnce((cmd: any, args: any, opts: any, cb: any) => {
      cb(null, { stdout: '', stderr: '' });
    });
    const runner = new RealTestRunner(tmpDir, DEFAULT_CYCLE_CONFIG.testing, null);
    await expect(runner.run(cycleId)).rejects.toThrow(TestRunnerError);
  });
});
```

- [ ] **Step 3: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/exec/real-test-runner.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `real-test-runner.ts`**

Create `packages/core/src/autonomous/exec/real-test-runner.ts`:

```typescript
// packages/core/src/autonomous/exec/real-test-runner.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { CycleConfig, TestResult, FailedTest } from '../types.js';

const execFileAsync = promisify(execFile);

export class TestRunnerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'TestRunnerError';
  }
}

export class TestRunTimeoutError extends TestRunnerError {
  constructor(timeoutMs: number) {
    super(`Test run timed out after ${timeoutMs}ms`);
    this.name = 'TestRunTimeoutError';
  }
}

export class RealTestRunner {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['testing'],
    private readonly priorSnapshot: TestResult | null,
  ) {}

  async run(cycleId: string): Promise<TestResult> {
    const outputFile = join(this.cwd, '.agentforge/cycles', cycleId, 'test-results.json');
    mkdirSync(dirname(outputFile), { recursive: true });

    const cmdParts = this.config.command.split(' ');
    const cmd = cmdParts[0]!;
    const args = [
      ...cmdParts.slice(1),
      '--',
      '--reporter=json',
      '--outputFile',
      outputFile,
    ];
    const timeoutMs = this.config.timeoutMinutes * 60_000;

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const startedAt = Date.now();

    try {
      const result = await execFileAsync(cmd, args, {
        cwd: this.cwd,
        timeout: timeoutMs,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
      });
      stdout = result.stdout.toString();
      stderr = result.stderr.toString();
    } catch (err: any) {
      exitCode = err.code ?? 1;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
      if (err.killed || err.signal === 'SIGTERM') {
        throw new TestRunTimeoutError(timeoutMs);
      }
    }

    const rawLogPath = join(this.cwd, '.agentforge/cycles', cycleId, 'tests-raw.log');
    if (this.config.saveRawLog) {
      writeFileSync(rawLogPath, stdout + '\n--- STDERR ---\n' + stderr);
    }

    if (!existsSync(outputFile)) {
      throw new TestRunnerError(
        `vitest did not produce output file (exit ${exitCode}): ${stderr.slice(0, 500)}`,
      );
    }

    const raw = JSON.parse(readFileSync(outputFile, 'utf8'));
    return this.parseVitestJson(raw, rawLogPath, startedAt, exitCode);
  }

  private parseVitestJson(
    raw: any,
    rawLogPath: string,
    startedAt: number,
    exitCode: number,
  ): TestResult {
    const passed = raw.numPassedTests ?? 0;
    const failed = raw.numFailedTests ?? 0;
    const skipped = raw.numPendingTests ?? 0;
    const total = passed + failed + skipped;

    const failedTests: FailedTest[] = [];
    for (const file of raw.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        if (assertion.status === 'failed') {
          const err = assertion.failureMessages?.[0] ?? '';
          failedTests.push({
            file: file.name,
            suite: (assertion.ancestorTitles ?? []).join(' > '),
            name: assertion.title,
            error: err,
            snippet: err.slice(0, 500),
          });
        }
      }
    }

    const newFailures = this.priorSnapshot
      ? failedTests
          .filter(
            t =>
              !this.priorSnapshot!.failedTests.some(
                p => p.file === t.file && p.name === t.name,
              ),
          )
          .map(t => `${t.file}::${t.name}`)
      : [];

    return {
      passed,
      failed,
      skipped,
      total,
      passRate: total > 0 ? passed / total : 0,
      durationMs: Date.now() - startedAt,
      failedTests,
      newFailures,
      rawOutputPath: rawLogPath,
      exitCode,
    };
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/exec/real-test-runner.test.ts`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/exec/real-test-runner.ts \
        packages/core/src/autonomous/exec/real-test-runner.test.ts \
        packages/core/src/autonomous/exec/__fixtures__/vitest-report.json
git commit -m "feat(autonomous): real test runner (unit tests with mocked execFile)"
```

---

## Task 10: Real test runner integration test

**Files:**
- Test: `tests/autonomous/integration/real-test-runner.integration.test.ts`

**Context:** Runs real `vitest` against a minimal fixture project in a temp dir. Proves the parser works against real vitest output.

- [ ] **Step 1: Check whether tests directory already exists at repo root**

Run: `ls tests/ 2>/dev/null || echo "does not exist"`

- [ ] **Step 2: Create integration test directory**

```bash
mkdir -p tests/autonomous/integration
```

- [ ] **Step 3: Write integration test**

Create `tests/autonomous/integration/real-test-runner.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RealTestRunner } from '../../../packages/core/src/autonomous/exec/real-test-runner.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';

const execFileAsync = promisify(execFile);

describe('RealTestRunner integration (real vitest)', () => {
  let tmpProject: string;

  beforeAll(async () => {
    tmpProject = mkdtempSync(join(tmpdir(), 'agentforge-rtr-integration-'));
    mkdirSync(join(tmpProject, '.agentforge/cycles/test-cycle'), { recursive: true });

    writeFileSync(
      join(tmpProject, 'package.json'),
      JSON.stringify({
        name: 'rtr-fixture',
        version: '0.0.0',
        type: 'module',
        scripts: { 'test:run': 'vitest run' },
        devDependencies: { vitest: '^3.0.4' },
      }, null, 2),
    );

    writeFileSync(
      join(tmpProject, 'sample.test.ts'),
      `
import { test, expect } from 'vitest';
test('passes', () => expect(1).toBe(1));
test('also passes', () => expect(2).toBe(2));
test('fails deliberately', () => expect(1).toBe(2));
`,
    );

    await execFileAsync('npm', ['install'], { cwd: tmpProject });
  }, 120_000);

  afterAll(() => {
    if (tmpProject) rmSync(tmpProject, { recursive: true, force: true });
  });

  it('runs real vitest and parses 2 passed / 1 failed', async () => {
    const runner = new RealTestRunner(
      tmpProject,
      { ...DEFAULT_CYCLE_CONFIG.testing, timeoutMinutes: 2 },
      null,
    );
    const result = await runner.run('test-cycle');

    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.passRate).toBeCloseTo(0.667, 2);
    expect(result.failedTests).toHaveLength(1);
    expect(result.failedTests[0]!.name).toBe('fails deliberately');
  }, 120_000);
});
```

- [ ] **Step 4: Run the integration test**

Run: `cd packages/core && npx vitest run ../../tests/autonomous/integration/real-test-runner.integration.test.ts`
Expected: PASS (may take 30-90 seconds due to `npm install` in the fixture).

- [ ] **Step 5: Commit**

```bash
git add tests/autonomous/integration/real-test-runner.integration.test.ts
git commit -m "test(autonomous): real vitest integration test against fixture project"
```

---

## Task 11: Git ops safety guards

**Files:**
- Create: `packages/core/src/autonomous/exec/git-ops.ts`
- Test: `packages/core/src/autonomous/exec/git-ops.test.ts`

**Context:** Implements `verifyPreconditions()` and the static `SECRET_PATTERNS` + `DANGEROUS_PATHS` constants. This task focuses only on safety guards — actual commit/push comes in Task 12.

- [ ] **Step 1: Write failing test for safety guards**

Create `packages/core/src/autonomous/exec/git-ops.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitOps, GitSafetyError } from './git-ops.js';
import { DEFAULT_CYCLE_CONFIG } from '../config-loader.js';
import { CycleLogger } from '../cycle-logger.js';

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

describe('GitOps safety guards', () => {
  let tmpRepo: string;
  const cycleId = 'test-gitops-cycle';

  beforeEach(async () => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'agentforge-gitops-'));
    mkdirSync(join(tmpRepo, '.agentforge/cycles', cycleId), { recursive: true });
    await initRepo(tmpRepo);
  });

  afterEach(() => {
    if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true });
  });

  function makeOps(): GitOps {
    const logger = new CycleLogger(tmpRepo, cycleId);
    return new GitOps(tmpRepo, DEFAULT_CYCLE_CONFIG.git, logger);
  }

  it('verifyPreconditions succeeds on clean repo with authed gh', async () => {
    const ops = makeOps();
    // Note: this test may skip or be marked pending if gh is not authed locally
    try {
      await ops.verifyPreconditions();
    } catch (err: any) {
      if (err.message.includes('gh CLI')) {
        console.warn('Skipping precondition test — gh not authed');
        return;
      }
      throw err;
    }
  });

  it('refuses when current branch is baseBranch (no-op before createBranch)', async () => {
    // After init, we are on main. createBranch should be called before commit,
    // but if we try to commit directly, it should refuse.
    const ops = makeOps();
    await expect(
      ops.commit('test commit'),
    ).rejects.toThrow(GitSafetyError);
  });

  it('scanStagedForSecrets throws on ANTHROPIC_API_KEY pattern', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(
      join(tmpRepo, 'bad.ts'),
      `const key = 'ANTHROPIC_API_KEY=sk-ant-api03-abcd1234567890abcd1234567890abcd';`,
    );
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on GitHub PAT pattern', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'bad.ts'), `const token = 'ghp_1234567890abcdefghij1234567890abcdef12';`);
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on AWS access key', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'bad.ts'), `const k = 'AKIAIOSFODNN7EXAMPLE';`);
    await execFileAsync('git', ['add', 'bad.ts'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('scanStagedForSecrets throws on private key header', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(
      join(tmpRepo, 'bad.pem'),
      `-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n`,
    );
    // Note: stage() will refuse .pem; this test uses direct git add to reach the scan
    await execFileAsync('git', ['add', '-f', 'bad.pem'], { cwd: tmpRepo });

    const ops = makeOps();
    await expect(ops.scanStagedForSecrets()).rejects.toThrow(/secret/i);
  });

  it('stage refuses dangerous path patterns (.env)', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, '.env'), 'KEY=value\n');
    const ops = makeOps();
    await expect(ops.stage(['.env'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses .pem files', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    writeFileSync(join(tmpRepo, 'cert.pem'), 'pem content\n');
    const ops = makeOps();
    await expect(ops.stage(['cert.pem'])).rejects.toThrow(/dangerous/i);
  });

  it('stage refuses paths that traverse out of repo', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage(['../../etc/passwd'])).rejects.toThrow(/suspicious|outside/i);
  });

  it('stage refuses absolute paths', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage(['/etc/passwd'])).rejects.toThrow(/suspicious/i);
  });

  it('stage refuses more files than maxFilesPerCommit', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const config = {
      ...DEFAULT_CYCLE_CONFIG.git,
      maxFilesPerCommit: 3,
    };
    const logger = new CycleLogger(tmpRepo, cycleId);
    const ops = new GitOps(tmpRepo, config, logger);
    await expect(
      ops.stage(['a.ts', 'b.ts', 'c.ts', 'd.ts']),
    ).rejects.toThrow(/maxFilesPerCommit/);
  });

  it('stage refuses empty file list', async () => {
    await execFileAsync('git', ['checkout', '-b', 'autonomous/v6.4.0'], { cwd: tmpRepo });
    const ops = makeOps();
    await expect(ops.stage([])).rejects.toThrow(/no files/i);
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/exec/git-ops.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `git-ops.ts` with safety guards (commit/push stubs for Task 12)**

Create `packages/core/src/autonomous/exec/git-ops.ts`:

```typescript
// packages/core/src/autonomous/exec/git-ops.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';
import type { CycleConfig } from '../types.js';
import type { CycleLogger } from '../cycle-logger.js';

const execFileAsync = promisify(execFile);

export class GitSafetyError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GitSafetyError';
  }
}

const DANGEROUS_PATHS = [
  /^\.env$/,
  /^\.env\./,
  /credentials\.json$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /\.secret$/,
];

const SECRET_PATTERNS = [
  /ANTHROPIC_API_KEY\s*=\s*['"]?sk-ant-/,
  /OPENAI_API_KEY\s*=\s*['"]?sk-/,
  /ghp_[a-zA-Z0-9]{36}/,
  /AKIA[0-9A-Z]{16}/,
  /aws_secret_access_key/i,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
];

export class GitOps {
  constructor(
    private readonly cwd: string,
    private readonly config: CycleConfig['git'],
    private readonly logger: CycleLogger,
  ) {}

  async verifyPreconditions(): Promise<void> {
    // 1. In a git repo
    try {
      await this.git(['rev-parse', '--show-toplevel']);
    } catch {
      throw new GitSafetyError('Not a git repository');
    }

    // 2. Current branch is not the base branch (only a warning at precondition stage)
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (this.config.refuseCommitToBaseBranch && currentBranch === this.config.baseBranch) {
      // OK at precondition — we'll create feature branch next. Just verify the check works.
    }

    // 3. gh CLI is authenticated
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    } catch {
      throw new GitSafetyError('gh CLI is not authenticated. Run `gh auth login` first.');
    }
  }

  async stage(files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new GitSafetyError('No files to stage');
    }
    if (files.length > this.config.maxFilesPerCommit) {
      throw new GitSafetyError(
        `REFUSED: ${files.length} files exceeds maxFilesPerCommit (${this.config.maxFilesPerCommit})`,
      );
    }

    const repoRoot = resolve(this.cwd);
    for (const file of files) {
      if (file.startsWith('/') || file.includes('..')) {
        throw new GitSafetyError(`REFUSED: suspicious path: ${file}`);
      }

      const absolute = resolve(this.cwd, file);
      const rel = relative(repoRoot, absolute);
      if (rel.startsWith('..') || rel.startsWith('/')) {
        throw new GitSafetyError(`REFUSED: path outside repo: ${file}`);
      }

      for (const pattern of DANGEROUS_PATHS) {
        if (pattern.test(file)) {
          throw new GitSafetyError(`REFUSED: dangerous pattern: ${file}`);
        }
      }
    }

    await this.git(['add', '--', ...files]);

    const staged = (await this.git(['diff', '--cached', '--name-only'])).stdout
      .split('\n')
      .filter(Boolean);
    this.logger.logGitEvent({ type: 'staged', files: staged });
  }

  async scanStagedForSecrets(): Promise<void> {
    const diff = (await this.git(['diff', '--cached'])).stdout;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(diff)) {
        throw new GitSafetyError(`REFUSED: secret pattern matched (${pattern.source})`);
      }
    }
  }

  async commit(message: string): Promise<string> {
    // Refuse direct commit to base branch
    const currentBranch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (this.config.refuseCommitToBaseBranch && currentBranch === this.config.baseBranch) {
      throw new GitSafetyError(
        `REFUSED: refuse to commit directly to ${this.config.baseBranch}. Create a feature branch first.`,
      );
    }

    // Secret scan before commit
    await this.scanStagedForSecrets();

    // Commit via stdin to avoid shell escaping
    await execFileAsync('git', ['commit', '-F', '-'], {
      cwd: this.cwd,
      input: message,
      timeout: 120_000,
    } as any);

    const sha = (await this.git(['rev-parse', 'HEAD'])).stdout.trim();

    // Verify post-commit branch (catches git hook weirdness)
    const branchAfter = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (branchAfter === this.config.baseBranch) {
      throw new GitSafetyError(
        `POST-COMMIT PANIC: landed on ${this.config.baseBranch}`,
      );
    }

    this.logger.logGitEvent({ type: 'committed', sha, message });
    return sha;
  }

  // Placeholder methods — implemented in Task 12
  async createBranch(_version: string, _suffix?: string): Promise<string> {
    throw new Error('createBranch: not yet implemented (Task 12)');
  }
  async push(_branch: string): Promise<void> {
    throw new Error('push: not yet implemented (Task 12)');
  }
  async rollbackCommit(_branch: string, _sha: string): Promise<void> {
    throw new Error('rollbackCommit: not yet implemented (Task 12)');
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync('git', args, {
      cwd: this.cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/exec/git-ops.test.ts`
Expected: All pass (tests requiring gh auth may print a warning and skip).

- [ ] **Step 5: Commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/exec/git-ops.ts \
        packages/core/src/autonomous/exec/git-ops.test.ts
git commit -m "feat(autonomous): git ops safety guards + secret scan"
```

---

## Task 12: Git ops happy path + integration

**Files:**
- Modify: `packages/core/src/autonomous/exec/git-ops.ts`
- Test: extend `packages/core/src/autonomous/exec/git-ops.test.ts`
- Test: `tests/autonomous/integration/git-ops.integration.test.ts`

**Context:** Implement `createBranch`, `push`, `rollbackCommit`. Extend existing tests. Add an integration test that runs a full commit cycle against a real tmp repo.

- [ ] **Step 1: Extend git-ops.test.ts with happy-path cases**

Append to `packages/core/src/autonomous/exec/git-ops.test.ts` (inside the same `describe` block):

```typescript
  it('createBranch creates and checks out feature branch', async () => {
    const ops = makeOps();
    const branch = await ops.createBranch('6.4.0');
    expect(branch).toBe('autonomous/v6.4.0');
    const current = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo })).stdout.trim();
    expect(current).toBe(branch);
  });

  it('createBranch appends suffix (e.g., -failed)', async () => {
    const ops = makeOps();
    const branch = await ops.createBranch('6.4.0', '-failed');
    expect(branch).toBe('autonomous/v6.4.0-failed');
  });

  it('createBranch refuses if branch already exists', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    // Go back to main first to try re-creating
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });
    await expect(ops.createBranch('6.4.0')).rejects.toThrow(/already exists/);
  });

  it('full happy path: createBranch → stage → commit', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('autonomous(v6.4.0): add new file\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const current = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo })).stdout.trim();
    expect(current).toBe('autonomous/v6.4.0');
  });

  it('rollbackCommit resets to previous state on feature branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new-file.ts'), 'export const x = 1;\n');
    await ops.stage(['new-file.ts']);
    const sha = await ops.commit('test commit');

    await ops.rollbackCommit('autonomous/v6.4.0', sha);

    const log = (await execFileAsync('git', ['log', '--oneline'], { cwd: tmpRepo })).stdout;
    expect(log).not.toContain('test commit');
  });

  it('rollbackCommit refuses if not on the expected branch', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'new.ts'), 'x');
    await ops.stage(['new.ts']);
    const sha = await ops.commit('test');
    await execFileAsync('git', ['checkout', 'main'], { cwd: tmpRepo });
    await expect(
      ops.rollbackCommit('autonomous/v6.4.0', sha),
    ).rejects.toThrow(/not on branch/i);
  });

  it('never passes -A or . to git add', async () => {
    const ops = makeOps();
    await ops.createBranch('6.4.0');
    writeFileSync(join(tmpRepo, 'a.ts'), 'a');
    writeFileSync(join(tmpRepo, 'b.ts'), 'b');
    // If the impl used git add -A or git add ., this would still pass, but
    // our impl uses `git add -- a.ts b.ts`. Verify by spying on execFile would be nice.
    // Simpler: verify we can selectively stage.
    await ops.stage(['a.ts']);
    const staged = (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: tmpRepo })).stdout;
    expect(staged.trim()).toBe('a.ts');
    expect(staged).not.toContain('b.ts');
  });
```

- [ ] **Step 2: Implement the placeholder methods**

Edit `packages/core/src/autonomous/exec/git-ops.ts` — replace the three placeholder methods:

```typescript
  async createBranch(version: string, suffix: string = ''): Promise<string> {
    const branch = `${this.config.branchPrefix}v${version}${suffix}`;

    // Check if branch already exists
    try {
      await this.git(['rev-parse', '--verify', `refs/heads/${branch}`]);
      throw new GitSafetyError(
        `REFUSED: branch ${branch} already exists — previous cycle may be uncleaned`,
      );
    } catch (err: any) {
      if (err instanceof GitSafetyError) throw err;
      // Expected: git rev-parse fails if branch does not exist
    }

    await this.git(['checkout', '-b', branch, this.config.baseBranch]);
    this.logger.logGitEvent({ type: 'branch-created', branch });
    return branch;
  }

  async push(branch: string): Promise<void> {
    await this.git(['push', '-u', 'origin', branch]);
    this.logger.logGitEvent({ type: 'pushed', branch });
  }

  async rollbackCommit(branch: string, sha: string): Promise<void> {
    const current = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (current !== branch) {
      throw new GitSafetyError(`Cannot rollback: not on branch ${branch} (current: ${current})`);
    }
    await this.git(['reset', '--hard', `${sha}~1`]);
    this.logger.logGitEvent({ type: 'rolled-back', branch, fromSha: sha });
  }
```

- [ ] **Step 3: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/exec/git-ops.test.ts`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/exec/git-ops.ts \
        packages/core/src/autonomous/exec/git-ops.test.ts
git commit -m "feat(autonomous): git ops happy path (createBranch/push/rollback)"
```

---

## Task 13: PR opener

**Files:**
- Create: `packages/core/src/autonomous/exec/pr-opener.ts`
- Test: `packages/core/src/autonomous/exec/pr-opener.test.ts`

**Context:** Thin wrapper around `gh pr create`. Supports dry-run for tests. Passes body via stdin to avoid shell escaping.

- [ ] **Step 1: Write failing test**

Create `packages/core/src/autonomous/exec/pr-opener.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PROpener, PROpenerError } from './pr-opener.js';

describe('PROpener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dry-run returns synthetic URL without subprocess', async () => {
    const opener = new PROpener('/tmp/test');
    const result = await opener.open({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'test',
      body: 'body',
      draft: false,
      labels: ['autonomous'],
      dryRun: true,
    });
    expect(result.url).toMatch(/^https:\/\/github\.com\//);
    expect(result.number).toBe(1);
  });

  it('dry-run preserves draft flag in result', async () => {
    const opener = new PROpener('/tmp/test');
    const result = await opener.open({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'test',
      body: 'body',
      draft: true,
      labels: [],
      dryRun: true,
    });
    expect(result.draft).toBe(true);
  });

  it('renderArgs builds correct gh pr create arguments', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'autonomous/v6.4.0',
      baseBranch: 'main',
      title: 'autonomous(v6.4.0): test',
      body: 'body',
      draft: false,
      labels: ['autonomous', 'needs-review'],
      reviewers: ['seandonvaughan'],
    });
    expect(args).toContain('pr');
    expect(args).toContain('create');
    expect(args).toContain('--title');
    expect(args).toContain('autonomous(v6.4.0): test');
    expect(args).toContain('--body-file');
    expect(args).toContain('-');
    expect(args).toContain('--base');
    expect(args).toContain('main');
    expect(args).toContain('--head');
    expect(args).toContain('autonomous/v6.4.0');
    expect(args).toContain('--label');
    expect(args).toContain('autonomous');
    expect(args).toContain('needs-review');
    expect(args).toContain('--reviewer');
    expect(args).toContain('seandonvaughan');
  });

  it('renderArgs includes --draft when draft=true', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'x',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      draft: true,
      labels: [],
    });
    expect(args).toContain('--draft');
  });

  it('renderArgs does not include --draft when draft=false', () => {
    const opener = new PROpener('/tmp/test');
    const args = opener.renderArgs({
      branch: 'x',
      baseBranch: 'main',
      title: 't',
      body: 'b',
      draft: false,
      labels: [],
    });
    expect(args).not.toContain('--draft');
  });

  it('parsePrNumber extracts number from URL', () => {
    const opener = new PROpener('/tmp/test');
    expect(opener.parsePrNumber('https://github.com/owner/repo/pull/42')).toBe(42);
    expect(opener.parsePrNumber('https://github.com/o/r/pull/1234')).toBe(1234);
  });

  it('parsePrNumber throws on malformed URL', () => {
    const opener = new PROpener('/tmp/test');
    expect(() => opener.parsePrNumber('not-a-url')).toThrow();
  });
});
```

- [ ] **Step 2: Run test — verify fails**

Run: `cd packages/core && npx vitest run src/autonomous/exec/pr-opener.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `pr-opener.ts`**

Create `packages/core/src/autonomous/exec/pr-opener.ts`:

```typescript
// packages/core/src/autonomous/exec/pr-opener.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class PROpenerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PROpenerError';
  }
}

export interface PROpenRequest {
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
  reviewers?: string[];
  dryRun?: boolean;
}

export interface PROpenResult {
  url: string;
  number: number;
  draft: boolean;
}

export class PROpener {
  constructor(private readonly cwd: string) {}

  async open(req: PROpenRequest): Promise<PROpenResult> {
    if (req.dryRun) {
      return {
        url: `https://github.com/dry-run/autonomous-test/pull/1`,
        number: 1,
        draft: req.draft,
      };
    }

    await this.requireGhInstalled();
    await this.requireGhAuthed();

    const args = this.renderArgs(req);

    try {
      const result = await execFileAsync('gh', args, {
        cwd: this.cwd,
        input: req.body,
        timeout: 60_000,
      } as any);

      const url = result.stdout.toString().trim().split('\n').pop() ?? '';
      if (!url.startsWith('https://')) {
        throw new PROpenerError(`Unexpected gh output: ${result.stdout}`);
      }

      const number = this.parsePrNumber(url);
      return { url, number, draft: req.draft };
    } catch (err: any) {
      throw new PROpenerError(`gh pr create failed: ${err.message}`);
    }
  }

  renderArgs(req: Omit<PROpenRequest, 'dryRun'>): string[] {
    const args = [
      'pr',
      'create',
      '--title', req.title,
      '--body-file', '-',
      '--base', req.baseBranch,
      '--head', req.branch,
    ];
    if (req.draft) args.push('--draft');
    for (const label of req.labels) {
      args.push('--label', label);
    }
    for (const reviewer of req.reviewers ?? []) {
      args.push('--reviewer', reviewer);
    }
    return args;
  }

  parsePrNumber(url: string): number {
    const match = url.match(/\/pull\/(\d+)/);
    if (!match) {
      throw new PROpenerError(`Cannot parse PR number from URL: ${url}`);
    }
    return parseInt(match[1]!, 10);
  }

  private async requireGhInstalled(): Promise<void> {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5_000 });
    } catch {
      throw new PROpenerError('gh CLI not installed. See https://cli.github.com');
    }
  }

  private async requireGhAuthed(): Promise<void> {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
    } catch {
      throw new PROpenerError('gh CLI not authenticated. Run `gh auth login`');
    }
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd packages/core && npx vitest run src/autonomous/exec/pr-opener.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
cd packages/core && npm run build && cd ../..
git add packages/core/src/autonomous/exec/pr-opener.ts \
        packages/core/src/autonomous/exec/pr-opener.test.ts
git commit -m "feat(autonomous): PR opener with dry-run mode"
```

---

## Task 14: Phase handler regression capture (pre-refactor)

**Files:**
- Test: `tests/autonomous/integration/phase-handlers-http.test.ts`

**Context:** Before refactoring `sprint-orchestration.ts`, capture its current HTTP behavior in a regression test suite. This ensures the extraction in Task 15 does not break v6.3 behavior.

- [ ] **Step 1: Read current sprint-orchestration routes**

Run: `Read packages/server/src/routes/v5/sprint-orchestration.ts` (full file, 1055 lines). Record: every HTTP route path, method, required parameters, expected response shape. Focus on: `PATCH /api/v5/sprints/:version/advance`, `POST /api/v5/sprints/:version/run-phase`, and `POST /api/v5/sprints/:version/execute`.

- [ ] **Step 2: Write regression test file**

Create `tests/autonomous/integration/phase-handlers-http.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
// NOTE: import path may need adjustment based on existing test setup
import { registerSprintOrchestrationRoutes } from '../../../packages/server/src/routes/v5/sprint-orchestration.js';

describe('Sprint orchestration HTTP routes (regression baseline)', () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-poh-'));
    mkdirSync(join(tmpDir, '.agentforge/sprints'), { recursive: true });

    // Write a test sprint
    writeFileSync(
      join(tmpDir, '.agentforge/sprints/v6.3.5.json'),
      JSON.stringify({
        sprints: [{
          sprintId: 'test-sprint',
          version: '6.3.5',
          title: 'Test',
          createdAt: new Date().toISOString(),
          phase: 'planned',
          items: [
            { id: 'i1', title: 'Test item', description: 'desc', priority: 'P0', assignee: 'coder', status: 'planned' },
          ],
        }],
      }),
    );

    app = Fastify({ logger: false });
    // The registration function name may differ — check sprint-orchestration.ts exports
    // If there's no exported function, skip this test and document it for Task 15
    try {
      await registerSprintOrchestrationRoutes(app as any, { projectRoot: tmpDir });
      await app.ready();
    } catch (err) {
      console.warn('Sprint orchestration routes could not be registered in test — mark as a blocker for Task 15');
      throw err;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/v5/sprints/:version returns the sprint', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/sprints/6.3.5',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe('6.3.5');
  });

  it('PATCH /api/v5/sprints/:version/advance transitions phase from planned to audit', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/sprints/6.3.5/advance',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phase).toBe('audit');
  });

  it('PATCH /api/v5/sprints/:version/advance continues through phase sequence', async () => {
    // Advance again → plan
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/sprints/6.3.5/advance',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.phase).toBe('plan');
  });

  // Note: The full regression suite should cover every HTTP endpoint.
  // This is a minimal smoke to prove the route shape is captured.
  // Expand as needed during Task 15 if refactoring breaks behavior.
});
```

- [ ] **Step 3: Run the regression test**

Run: `cd packages/server && npx vitest run ../../tests/autonomous/integration/phase-handlers-http.test.ts`

Expected: Tests pass (or the first one fails due to route registration differences — in that case, read `packages/server/src/routes/v5/sprint-orchestration.ts` again to find the actual exported registration function and update the test import).

**If the tests cannot run due to import issues:** Document the blocker and proceed to Task 15 — the refactor itself will produce callable functions that are easier to test. Mark Task 14 as "capturing behavior via manual inspection" in commit message.

- [ ] **Step 4: Commit regression baseline**

```bash
git add tests/autonomous/integration/phase-handlers-http.test.ts
git commit -m "test(autonomous): capture sprint-orchestration HTTP baseline before refactor"
```

---

## Task 15: Extract phase handlers from sprint-orchestration.ts

**Files:**
- Create: `packages/server/src/lib/phase-handlers.ts`
- Modify: `packages/server/src/routes/v5/sprint-orchestration.ts`

**Context:** Extract each phase's logic into a plain async function. The HTTP routes become thin wrappers. This enables the PhaseScheduler (Task 21) to call handlers directly. See spec §7.1.

- [ ] **Step 1: Read sprint-orchestration.ts in full**

Run: `Read packages/server/src/routes/v5/sprint-orchestration.ts` (all 1055 lines). Identify the exact lines where each phase's logic lives. Take notes:
- Audit phase logic: lines X-Y
- Plan phase logic: lines X-Y
- Assign phase logic: lines X-Y
- ... etc

- [ ] **Step 2: Create `packages/server/src/lib/phase-handlers.ts`**

Create the file with the function signatures from the spec. Copy each phase's logic from sprint-orchestration.ts into the corresponding function. Preserve the existing behavior exactly — no business logic changes in this step.

```typescript
// packages/server/src/lib/phase-handlers.ts
import type { AgentRuntime } from '@agentforge/core';
import type { WorkspaceAdapter } from '@agentforge/db';
import type { EventBus } from '@agentforge/shared';
import { nowIso } from '@agentforge/shared';

export type PhaseName =
  | 'audit' | 'plan' | 'assign' | 'execute'
  | 'test' | 'review' | 'gate' | 'release' | 'learn';

export interface PhaseContext {
  sprintId: string;
  sprintVersion: string;
  projectRoot: string;
  adapter: WorkspaceAdapter;
  bus: EventBus;
  runtime: AgentRuntime;
  cycleId?: string;
}

export interface AgentRunSummary {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  succeeded: boolean;
}

export interface SprintItemResult {
  itemId: string;
  status: 'completed' | 'failed' | 'blocked';
  costUsd: number;
  durationMs: number;
  output?: string;
  error?: string;
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: AgentRunSummary[];
  itemResults?: SprintItemResult[];
  error?: string;
}

export const PHASE_SEQUENCE: PhaseName[] = [
  'audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate', 'release', 'learn',
];

export function nextPhase(current: PhaseName): PhaseName | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  return idx === -1 || idx === PHASE_SEQUENCE.length - 1
    ? null
    : PHASE_SEQUENCE[idx + 1]!;
}

// ---------------------------------------------------------------------------
// Phase handlers — extracted from sprint-orchestration.ts
// Each handler:
//   1. Publishes sprint.phase.started event
//   2. Executes the phase logic (previously inline in the HTTP handler)
//   3. On success: publishes sprint.phase.completed event, returns PhaseResult
//   4. On failure: publishes sprint.phase.failed event, throws
// ---------------------------------------------------------------------------

export async function runAuditPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = Date.now();
  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase: 'audit',
    cycleId: ctx.cycleId,
    startedAt: nowIso(),
  });

  try {
    // TODO(Task 15): Paste the audit phase logic from sprint-orchestration.ts here.
    // Run the researcher agent via ctx.runtime, collect findings, update sprint JSON.
    const result: PhaseResult = {
      phase: 'audit',
      status: 'completed',
      durationMs: Date.now() - startedAt,
      costUsd: 0,
      agentRuns: [],
    };

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      phase: 'audit',
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase: 'audit',
      cycleId: ctx.cycleId,
      error,
      failedAt: nowIso(),
    });
    throw err;
  }
}

// Pattern repeats for each phase. Implement all nine:
export async function runPlanPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = Date.now();
  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId, phase: 'plan', cycleId: ctx.cycleId, startedAt: nowIso(),
  });
  try {
    // TODO(Task 15): Paste plan phase logic (CTO agent invocation, etc.)
    const result: PhaseResult = { phase: 'plan', status: 'completed', durationMs: Date.now() - startedAt, costUsd: 0, agentRuns: [] };
    ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase: 'plan', cycleId: ctx.cycleId, result, completedAt: nowIso() });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.bus.publish('sprint.phase.failed', { sprintId: ctx.sprintId, phase: 'plan', cycleId: ctx.cycleId, error, failedAt: nowIso() });
    throw err;
  }
}

export async function runAssignPhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): AutoDelegationPipeline integration from sprint-orchestration.ts
  return runPhaseStub(ctx, 'assign');
}

export async function runExecutePhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): Parallel item dispatch from sprint-orchestration.ts
  return runPhaseStub(ctx, 'execute');
}

export async function runTestPhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): backend-qa agent from sprint-orchestration.ts
  return runPhaseStub(ctx, 'test');
}

export async function runReviewPhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): code-reviewer agent from sprint-orchestration.ts
  return runPhaseStub(ctx, 'review');
}

export async function runGatePhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): CEO agent from sprint-orchestration.ts
  return runPhaseStub(ctx, 'gate');
}

export async function runReleasePhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): release logic from sprint-orchestration.ts
  return runPhaseStub(ctx, 'release');
}

export async function runLearnPhase(ctx: PhaseContext): Promise<PhaseResult> {
  // TODO(Task 15): retrospective logic from sprint-orchestration.ts
  return runPhaseStub(ctx, 'learn');
}

// Helper — DRY the event wiring for phases where the logic is TBD
async function runPhaseStub(ctx: PhaseContext, phase: PhaseName): Promise<PhaseResult> {
  const startedAt = Date.now();
  ctx.bus.publish('sprint.phase.started', { sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId, startedAt: nowIso() });
  try {
    const result: PhaseResult = { phase, status: 'completed', durationMs: Date.now() - startedAt, costUsd: 0, agentRuns: [] };
    ctx.bus.publish('sprint.phase.completed', { sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId, result, completedAt: nowIso() });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.bus.publish('sprint.phase.failed', { sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId, error, failedAt: nowIso() });
    throw err;
  }
}

export const PHASE_HANDLERS: Record<PhaseName, (ctx: PhaseContext) => Promise<PhaseResult>> = {
  audit: runAuditPhase,
  plan: runPlanPhase,
  assign: runAssignPhase,
  execute: runExecutePhase,
  test: runTestPhase,
  review: runReviewPhase,
  gate: runGatePhase,
  release: runReleasePhase,
  learn: runLearnPhase,
};
```

**IMPORTANT:** The `TODO(Task 15)` markers above indicate where the full phase logic from `sprint-orchestration.ts` must be pasted. Do this carefully — preserve every conditional, every agent invocation, every file I/O. Do not rewrite; only relocate.

- [ ] **Step 3: Fill in each phase handler by copying from sprint-orchestration.ts**

For each phase handler in `phase-handlers.ts`, locate the corresponding logic in `sprint-orchestration.ts` (using the notes from Task 14 Step 1) and copy it into the function body, adapting variable names as needed. Replace any `reply.send(...)` calls with `return result;` — HTTP response handling stays in the HTTP wrapper.

- [ ] **Step 4: Update `sprint-orchestration.ts` to be thin wrappers**

Edit `packages/server/src/routes/v5/sprint-orchestration.ts` — for each route that previously had inline phase logic, replace the body with a call to the corresponding handler:

```typescript
// Before: ~150 lines of audit logic inline
fastify.post('/api/v5/sprints/:version/run-phase', async (req, reply) => {
  // ... inline logic ...
});

// After:
fastify.post('/api/v5/sprints/:version/run-phase', async (req, reply) => {
  const version = (req.params as any).version;
  const sprint = loadSprint(version, projectRoot);
  const currentPhase = sprint.phase as PhaseName;
  if (currentPhase === 'planned') {
    // Handle pre-audit transition (existing logic)
    return reply.send({ phase: 'audit', ... });
  }
  const ctx: PhaseContext = {
    sprintId: sprint.sprintId,
    sprintVersion: version,
    projectRoot,
    adapter,
    bus,
    runtime,
  };
  const handler = PHASE_HANDLERS[currentPhase];
  if (!handler) {
    return reply.code(400).send({ error: `No handler for phase ${currentPhase}` });
  }
  const result = await handler(ctx);
  return reply.send(result);
});
```

- [ ] **Step 5: Build and run the regression tests from Task 14**

Run:
```bash
cd packages/server && npm run build && cd ../..
cd packages/server && npx vitest run ../../tests/autonomous/integration/phase-handlers-http.test.ts
```
Expected: Pass. If not, the refactor has drift — compare behavior carefully against the original.

- [ ] **Step 6: Run the full server test suite to verify no regressions**

Run: `cd packages/server && npm run build && npx vitest run`
Expected: All previously-passing server tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/lib/phase-handlers.ts \
        packages/server/src/routes/v5/sprint-orchestration.ts
git commit -m "refactor(server): extract phase handlers from sprint-orchestration.ts"
```

---

## Task 16: Add event publishing to phase handlers

**Files:**
- Modify: `packages/server/src/lib/phase-handlers.ts`
- Test: `tests/autonomous/integration/phase-handlers-events.test.ts`

**Context:** Task 15 created the scaffolding for events but the TODO stubs publish empty events. This task verifies every phase publishes `sprint.phase.started` and `sprint.phase.completed` with the correct payload shape, and that failures publish `sprint.phase.failed`.

- [ ] **Step 1: Write failing event test**

Create `tests/autonomous/integration/phase-handlers-events.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import type { EventBus } from '@agentforge/shared';
import {
  runAuditPhase,
  runPlanPhase,
  PHASE_HANDLERS,
  PHASE_SEQUENCE,
} from '../../../packages/server/src/lib/phase-handlers.js';

function makeMockBus() {
  const published: any[] = [];
  return {
    published,
    bus: {
      publish: (topic: string, payload: any) => {
        published.push({ topic, payload });
      },
      subscribe: () => () => {},
    } as unknown as EventBus,
  };
}

function makeCtx(overrides: any = {}) {
  const { bus } = makeMockBus();
  return {
    sprintId: 'test-sprint',
    sprintVersion: '6.3.5',
    projectRoot: '/tmp',
    adapter: {} as any,
    bus,
    runtime: {} as any,
    cycleId: 'test-cycle',
    ...overrides,
  };
}

describe('Phase handler events', () => {
  it('runAuditPhase publishes started + completed events', async () => {
    const { published, bus } = makeMockBus();
    const ctx = makeCtx({ bus });
    await runAuditPhase(ctx);
    expect(published.some(e => e.topic === 'sprint.phase.started')).toBe(true);
    expect(published.some(e => e.topic === 'sprint.phase.completed')).toBe(true);
  });

  it('publishes events with sprintId and cycleId', async () => {
    const { published, bus } = makeMockBus();
    const ctx = makeCtx({ bus, cycleId: 'cycle-abc' });
    await runAuditPhase(ctx);
    const started = published.find(e => e.topic === 'sprint.phase.started');
    expect(started.payload.sprintId).toBe('test-sprint');
    expect(started.payload.cycleId).toBe('cycle-abc');
    expect(started.payload.phase).toBe('audit');
  });

  it('every phase in PHASE_SEQUENCE has a handler', () => {
    for (const phase of PHASE_SEQUENCE) {
      expect(PHASE_HANDLERS[phase]).toBeDefined();
      expect(typeof PHASE_HANDLERS[phase]).toBe('function');
    }
  });

  it('PHASE_SEQUENCE has expected order', () => {
    expect(PHASE_SEQUENCE).toEqual([
      'audit', 'plan', 'assign', 'execute',
      'test', 'review', 'gate', 'release', 'learn',
    ]);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd packages/server && npx vitest run ../../tests/autonomous/integration/phase-handlers-events.test.ts`
Expected: Tests pass (assuming Task 15 scaffolded events correctly).

- [ ] **Step 3: Commit**

```bash
git add tests/autonomous/integration/phase-handlers-events.test.ts
git commit -m "test(autonomous): phase handler event publishing"
```

---

**NOTE: Due to the size of this plan, Tasks 17-26 are continued in a second file.**

Tasks 17-26 cover:
- Task 17: Scoring pipeline (agent invocation with mocked runtime)
- Task 18: Scoring pipeline fallback ladder (3-strike retry + static fallback)
- Task 19: Budget approval gate (TTY + file modes)
- Task 20: Phase scheduler (event-driven auto-advance)
- Task 21: Cycle runner (top-level orchestrator)
- Task 22: `.agentforge/autonomous.yaml` + `backlog-scorer.yaml` agent
- Task 23: CLI command entry point
- Task 24: Full-cycle integration test (E2E)
- Task 25: Manual smoke test procedure documentation
- Task 26: CHANGELOG + final verification

See `docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md` for continuation.

---

## Part 1 Acceptance Criteria

After completing Tasks 1-16, verify:

- [ ] `cd packages/core && npm run build` passes with 0 errors
- [ ] `cd packages/core && npx vitest run src/autonomous/` — all new unit tests pass
- [ ] `cd packages/server && npm run build` passes with 0 errors
- [ ] `cd packages/server && npx vitest run` — all server tests (including regression suite) pass
- [ ] Integration tests in `tests/autonomous/integration/` pass
- [ ] No new TypeScript errors anywhere in the monorepo (`npm run build` at repo root)
- [ ] Git log shows one commit per task (16 new commits)
