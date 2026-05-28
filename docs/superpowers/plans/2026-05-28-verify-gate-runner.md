# Memory-Adaptive + Affected-Test Verify Gate Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static full-suite verify command with a runner that sizes vitest workers from live memory, runs affected-tests by default with a full-suite deep-gate safety net, and self-heals once on OOM — so autonomous cycles stop OOM-crashing in the test gate and can scale.

**Architecture:** A pure planning library (`scripts/verify-test-planner.mjs`) holds all decisions as side-effect-free functions (worker math, gate-mode selection, OOM detection, vitest arg construction, config defaulting). A thin entry script (`scripts/run-verify-tests.mjs`) reads `.agentforge/autonomous.yaml`, derives changed files via `git`, calls the pure planner, spawns vitest (`node <vitest-bin>`, no shell), retries once at half workers on OOM, and writes a summary. `.agentforge/autonomous.yaml`'s `testing.command` points at the runner.

**Tech Stack:** Node ESM `.mjs` (root is `type: module`), `js-yaml ^4.1.1`, vitest 4 (`run` + `related` subcommands), vitest for the unit/integration tests (TypeScript).

**Scope:** This is Phase 1 of the production-autonomous-cycles spec (`docs/superpowers/specs/2026-05-28-production-autonomous-cycles-design.md`), Section 1 only. Sections 2–5 (routing wiring, risk-based auto-merge, size ramp + guardrails, observability integration) are separate follow-up plans; this one ships and is validated first.

---

## File Structure

- **Create** `scripts/verify-test-planner.mjs` — pure functions: `computeWorkers`, `matchesCoreGlobs`, `selectGateMode`, `isOomExit`, `nextWorkersOnOom`, `buildVitestArgs`, `resolveVerifyConfig`. No I/O. The unit-testable core.
- **Create** `scripts/run-verify-tests.mjs` — executable entry; reads config + git diff, calls the planner, spawns vitest, OOM-retries once, writes summary, propagates exit code. Thin glue only.
- **Create** `tests/verify/verify-test-planner.test.ts` — unit tests for every pure function.
- **Create** `tests/verify/run-verify-tests.integration.test.ts` — one subprocess test of the entry script against a tiny temp fixture.
- **Modify** `.agentforge/autonomous.yaml` — set `testing.command: node scripts/run-verify-tests.mjs` and add the `testing` knobs the runner reads.

All relative imports end in `.js`/`.mjs`; Node builtins use the `node:` prefix; no `exec` (spawn only); matching uses `String` ops or fixed simple patterns (no regex over file paths) per repo conventions.

---

### Task 1: Pure worker-sizing math

**Files:**
- Create: `scripts/verify-test-planner.mjs`
- Test: `tests/verify/verify-test-planner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/verify/verify-test-planner.test.ts
import { describe, expect, it } from 'vitest';
import { computeWorkers } from '../../scripts/verify-test-planner.mjs';

describe('computeWorkers', () => {
  it('is bounded by memory when memory is the tighter constraint', () => {
    // (10 - 2) / 1 = 8 byMem; cores-1 = 7 → min = 7
    expect(computeWorkers(10, 8, { reserveGb: 2, perWorkerGb: 1 })).toBe(7);
  });

  it('is bounded by CPUs when memory is plentiful', () => {
    // (32 - 2) / 1 = 30 byMem; cores-1 = 3 → 3
    expect(computeWorkers(32, 4, { reserveGb: 2, perWorkerGb: 1 })).toBe(3);
  });

  it('never returns less than 1 even under memory pressure', () => {
    // (2 - 2)/1 = 0 → clamped to 1
    expect(computeWorkers(2, 8, { reserveGb: 2, perWorkerGb: 1 })).toBe(1);
  });

  it('honors a larger per-worker budget', () => {
    // (10 - 2) / 2 = 4 byMem; cores-1 = 7 → 4
    expect(computeWorkers(10, 8, { reserveGb: 2, perWorkerGb: 2 })).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/verify-test-planner.mjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// scripts/verify-test-planner.mjs
#!/usr/bin/env node
/**
 * verify-test-planner.mjs — pure planning functions for the autonomous-cycle
 * VERIFY gate. No I/O, no process state: every function is a deterministic
 * transform so it is unit-testable without running vitest or touching the FS.
 */

/**
 * Safe vitest worker count: bounded by both available memory and CPUs.
 * @returns {number} integer >= 1
 */
export function computeWorkers(freeGb, cores, { reserveGb, perWorkerGb }) {
  const byMem = Math.floor((freeGb - reserveGb) / perWorkerGb);
  const byCpu = cores - 1;
  return Math.max(1, Math.min(byMem, byCpu));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-test-planner.mjs tests/verify/verify-test-planner.test.ts
git commit -m "feat(verify-gate): memory-adaptive worker sizing (pure)"
```

---

### Task 2: Core-glob matching + gate-mode selection

**Files:**
- Modify: `scripts/verify-test-planner.mjs`
- Test: `tests/verify/verify-test-planner.test.ts`

- [ ] **Step 1: Write the failing test (append to the test file)**

```ts
import { matchesCoreGlobs, selectGateMode } from '../../scripts/verify-test-planner.mjs';

const CORE = ['packages/core/src/runtime/**', 'packages/shared/**'];

describe('matchesCoreGlobs', () => {
  it('matches a file under a /** prefix glob', () => {
    expect(matchesCoreGlobs('packages/core/src/runtime/types.ts', CORE)).toBe(true);
  });
  it('normalizes Windows backslashes before matching', () => {
    expect(matchesCoreGlobs('packages\\shared\\src\\index.ts', CORE)).toBe(true);
  });
  it('does not match files outside the globs', () => {
    expect(matchesCoreGlobs('packages/cli/src/bin.ts', CORE)).toBe(false);
  });
});

describe('selectGateMode', () => {
  const base = { coreGlobs: CORE, cycleIndex: 1, deepGateEveryNCycles: 5, affectedMode: 'auto' };

  it('returns related for a non-core diff in auto mode', () => {
    expect(selectGateMode({ ...base, changedFiles: ['packages/cli/src/bin.ts'] })).toBe('related');
  });
  it('forces full when a changed file is under coreGlobs', () => {
    expect(selectGateMode({ ...base, changedFiles: ['packages/core/src/runtime/x.ts'] })).toBe('full');
  });
  it('forces full on the deep-gate cadence (every Nth cycle)', () => {
    expect(selectGateMode({ ...base, cycleIndex: 5, changedFiles: ['packages/cli/src/bin.ts'] })).toBe('full');
  });
  it('forces full when the changed-file list is empty (unknown diff)', () => {
    expect(selectGateMode({ ...base, changedFiles: [] })).toBe('full');
  });
  it('honors affectedMode=full and affectedMode=related overrides', () => {
    expect(selectGateMode({ ...base, affectedMode: 'full', changedFiles: ['packages/cli/x.ts'] })).toBe('full');
    expect(selectGateMode({ ...base, affectedMode: 'related', changedFiles: ['packages/core/src/runtime/x.ts'] })).toBe('related');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: FAIL — `matchesCoreGlobs is not a function` / `selectGateMode is not a function`.

- [ ] **Step 3: Write minimal implementation (append to the planner module)**

```js
/** Match a path against simple globs (prefix `/**`, single-segment `/*`, or exact). */
export function matchesCoreGlobs(file, globs) {
  const norm = String(file).split('\\').join('/');
  return globs.some((glob) => {
    const g = String(glob).split('\\').join('/');
    if (g.endsWith('/**')) return norm.startsWith(g.slice(0, -2));
    if (g.endsWith('/*')) {
      const prefix = g.slice(0, -1);
      return norm.startsWith(prefix) && !norm.slice(prefix.length).includes('/');
    }
    return norm === g;
  });
}

/**
 * Decide the gate mode. 'full' overrides everything; 'related' forces affected
 * tests; 'auto' runs affected tests except when a deep-gate trigger fires
 * (core-glob diff, deep-gate cadence, or an unknown/empty diff).
 * @returns {'related'|'full'}
 */
export function selectGateMode({
  changedFiles = [],
  coreGlobs = [],
  cycleIndex = 0,
  deepGateEveryNCycles = 0,
  affectedMode = 'auto',
}) {
  if (affectedMode === 'full') return 'full';
  if (affectedMode === 'related') return 'related';
  if (changedFiles.length === 0) return 'full';
  if (changedFiles.some((f) => matchesCoreGlobs(f, coreGlobs))) return 'full';
  if (deepGateEveryNCycles > 0 && cycleIndex > 0 && cycleIndex % deepGateEveryNCycles === 0) return 'full';
  return 'related';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-test-planner.mjs tests/verify/verify-test-planner.test.ts
git commit -m "feat(verify-gate): core-glob matching + gate-mode selection (pure)"
```

---

### Task 3: OOM detection, retry sizing, and vitest arg construction

**Files:**
- Modify: `scripts/verify-test-planner.mjs`
- Test: `tests/verify/verify-test-planner.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { isOomExit, nextWorkersOnOom, buildVitestArgs } from '../../scripts/verify-test-planner.mjs';

describe('isOomExit', () => {
  it('is true for SIGKILL (137) and SIGABRT (134) and the signals themselves', () => {
    expect(isOomExit(137, null)).toBe(true);
    expect(isOomExit(134, null)).toBe(true);
    expect(isOomExit(null, 'SIGKILL')).toBe(true);
    expect(isOomExit(null, 'SIGABRT')).toBe(true);
  });
  it('is false for clean and ordinary test failures', () => {
    expect(isOomExit(0, null)).toBe(false);
    expect(isOomExit(1, null)).toBe(false);
  });
});

describe('nextWorkersOnOom', () => {
  it('halves the worker count, floored, never below 1', () => {
    expect(nextWorkersOnOom(6)).toBe(3);
    expect(nextWorkersOnOom(3)).toBe(1);
    expect(nextWorkersOnOom(1)).toBe(1);
  });
});

describe('buildVitestArgs', () => {
  it('builds full-suite run args', () => {
    expect(buildVitestArgs({ mode: 'full', changedFiles: [], workers: 4 }))
      .toEqual(['run', '--maxWorkers=4', '--minWorkers=1']);
  });
  it('builds affected (related) args with the changed files', () => {
    expect(buildVitestArgs({ mode: 'related', changedFiles: ['a.ts', 'b.ts'], workers: 2 }))
      .toEqual(['related', '--run', 'a.ts', 'b.ts', '--maxWorkers=2', '--minWorkers=1']);
  });
  it('falls back to full run when related mode has no changed files', () => {
    expect(buildVitestArgs({ mode: 'related', changedFiles: [], workers: 2 }))
      .toEqual(['run', '--maxWorkers=2', '--minWorkers=1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: FAIL — `isOomExit is not a function` (and siblings).

- [ ] **Step 3: Write minimal implementation (append)**

```js
/** OOM signatures: OS OOM-killer (SIGKILL→137) or V8 heap abort (SIGABRT→134). */
export function isOomExit(code, signal) {
  return signal === 'SIGKILL' || signal === 'SIGABRT' || code === 137 || code === 134;
}

/** Halve workers for the single OOM retry; never below 1. */
export function nextWorkersOnOom(workers) {
  return Math.max(1, Math.floor(workers / 2));
}

/** Construct vitest CLI args. `related --run <files>` runs only affected tests once. */
export function buildVitestArgs({ mode, changedFiles = [], workers }) {
  const workerFlags = [`--maxWorkers=${workers}`, '--minWorkers=1'];
  if (mode === 'related' && changedFiles.length > 0) {
    return ['related', '--run', ...changedFiles, ...workerFlags];
  }
  return ['run', ...workerFlags];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-test-planner.mjs tests/verify/verify-test-planner.test.ts
git commit -m "feat(verify-gate): OOM detection, retry sizing, vitest args (pure)"
```

---

### Task 4: Config defaulting

**Files:**
- Modify: `scripts/verify-test-planner.mjs`
- Test: `tests/verify/verify-test-planner.test.ts`

- [ ] **Step 1: Write the failing test (append)**

```ts
import { resolveVerifyConfig } from '../../scripts/verify-test-planner.mjs';

describe('resolveVerifyConfig', () => {
  it('fills defaults when given an empty/undefined testing block', () => {
    expect(resolveVerifyConfig(undefined)).toEqual({
      affectedMode: 'auto',
      deepGateEveryNCycles: 5,
      coreGlobs: [
        'packages/core/src/runtime/**',
        'packages/core/src/autonomous/**',
        'packages/shared/**',
      ],
      reserveGb: 2.0,
      perWorkerGb: 1.0,
      heapCapMb: 2048,
    });
  });

  it('honors provided overrides and rejects invalid affectedMode', () => {
    const cfg = resolveVerifyConfig({
      affectedMode: 'bogus',
      deepGateEveryNCycles: 3,
      coreGlobs: ['packages/core/src/runtime/**'],
      memory: { reserveGb: 3, perWorkerGb: 1.5, heapCapMb: 4096 },
    });
    expect(cfg.affectedMode).toBe('auto'); // invalid → default
    expect(cfg.deepGateEveryNCycles).toBe(3);
    expect(cfg.coreGlobs).toEqual(['packages/core/src/runtime/**']);
    expect(cfg.reserveGb).toBe(3);
    expect(cfg.perWorkerGb).toBe(1.5);
    expect(cfg.heapCapMb).toBe(4096);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: FAIL — `resolveVerifyConfig is not a function`.

- [ ] **Step 3: Write minimal implementation (append)**

```js
const DEFAULT_CORE_GLOBS = [
  'packages/core/src/runtime/**',
  'packages/core/src/autonomous/**',
  'packages/shared/**',
];

/** Normalize the autonomous.yaml `testing` block into a complete config with defaults. */
export function resolveVerifyConfig(testing) {
  const t = testing && typeof testing === 'object' ? testing : {};
  const mem = t.memory && typeof t.memory === 'object' ? t.memory : {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  const int = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return {
    affectedMode: ['auto', 'related', 'full'].includes(t.affectedMode) ? t.affectedMode : 'auto',
    deepGateEveryNCycles: int(t.deepGateEveryNCycles, 5),
    coreGlobs: Array.isArray(t.coreGlobs) && t.coreGlobs.length > 0 ? t.coreGlobs : DEFAULT_CORE_GLOBS,
    reserveGb: num(mem.reserveGb, 2.0),
    perWorkerGb: num(mem.perWorkerGb, 1.0),
    heapCapMb: int(mem.heapCapMb, 2048),
  };
}
```

Note: `reserveGb` uses `num` which requires `> 0`; a configured `0` falls back to the default `2.0` (a zero reserve is unsafe and treated as "unset").

- [ ] **Step 4: Run test to verify it passes**

Run: `corepack pnpm exec vitest run tests/verify/verify-test-planner.test.ts`
Expected: PASS (all planner tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-test-planner.mjs tests/verify/verify-test-planner.test.ts
git commit -m "feat(verify-gate): testing-config defaulting (pure)"
```

---

### Task 5: Entry runner script

**Files:**
- Create: `scripts/run-verify-tests.mjs`

- [ ] **Step 1: Write the implementation**

```js
// scripts/run-verify-tests.mjs
#!/usr/bin/env node
/**
 * run-verify-tests.mjs — the autonomous-cycle VERIFY gate.
 *
 * Reads `.agentforge/autonomous.yaml` (the `testing` block), derives the changed
 * files via git, plans the run with verify-test-planner.mjs (memory-adaptive
 * workers + affected/full gate mode), spawns vitest with a per-fork heap cap
 * (no shell), retries ONCE at half workers on an OOM signature, writes a summary
 * sidecar, and propagates vitest's exit code.
 *
 * Exit codes: vitest's status (0 = gate passed). Non-zero fails the cycle gate.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { freemem, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import process from 'node:process';
import yaml from 'js-yaml';
import {
  resolveVerifyConfig,
  computeWorkers,
  selectGateMode,
  buildVitestArgs,
  isOomExit,
  nextWorkersOnOom,
} from './verify-test-planner.mjs';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

function loadAutonomousYaml() {
  try {
    const parsed = yaml.load(readFileSync(join(ROOT, '.agentforge', 'autonomous.yaml'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getChangedFiles(baseBranch) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // unknown diff → planner treats as a full gate (safe)
  }
}

function resolveVitestBin() {
  const pkgJson = require.resolve('vitest/package.json');
  return join(dirname(pkgJson), 'vitest.mjs');
}

function runVitest(args, heapCapMb) {
  const heapFlag = `--max-old-space-size=${heapCapMb}`;
  const env = { ...process.env };
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${heapFlag}` : heapFlag;
  const res = spawnSync(process.execPath, [resolveVitestBin(), ...args], {
    stdio: 'inherit',
    cwd: ROOT,
    env,
  });
  return { code: res.status, signal: res.signal };
}

function main() {
  const conf = loadAutonomousYaml();
  const cfg = resolveVerifyConfig(conf.testing);
  const baseBranch = conf.git && typeof conf.git.baseBranch === 'string' ? conf.git.baseBranch : 'main';

  const changedFiles = getChangedFiles(baseBranch);
  const cycleIndexRaw = Number.parseInt(process.env.AGENTFORGE_CYCLE_INDEX ?? '', 10);
  const cycleIndex = Number.isInteger(cycleIndexRaw) && cycleIndexRaw >= 0 ? cycleIndexRaw : 0;

  const mode = selectGateMode({
    changedFiles,
    coreGlobs: cfg.coreGlobs,
    cycleIndex,
    deepGateEveryNCycles: cfg.deepGateEveryNCycles,
    affectedMode: cfg.affectedMode,
  });

  let workers = computeWorkers(freemem() / 1e9, cpus().length, {
    reserveGb: cfg.reserveGb,
    perWorkerGb: cfg.perWorkerGb,
  });

  console.error(
    `[verify-gate] mode=${mode} workers=${workers} changedFiles=${changedFiles.length} freeGb=${(freemem() / 1e9).toFixed(1)}`,
  );

  let { code, signal } = runVitest(buildVitestArgs({ mode, changedFiles, workers }), cfg.heapCapMb);
  let oomRetryCount = 0;

  if (isOomExit(code, signal) && workers > 1) {
    oomRetryCount = 1;
    workers = nextWorkersOnOom(workers);
    console.error(`[verify-gate] OOM (code=${code} signal=${signal}); retrying once at workers=${workers}`);
    ({ code, signal } = runVitest(buildVitestArgs({ mode, changedFiles, workers }), cfg.heapCapMb));
  }

  const exitCode = code ?? (signal ? 1 : 0);
  const summary = { mode, workers, oomRetryCount, changedFileCount: changedFiles.length, exitCode, signal: signal ?? null };
  console.error(`[verify-gate] summary ${JSON.stringify(summary)}`);

  const summaryDir = process.env.AGENTFORGE_VERIFY_SUMMARY_DIR;
  if (summaryDir) {
    try {
      writeFileSync(join(summaryDir, 'verify-gate-summary.json'), JSON.stringify(summary, null, 2));
    } catch {
      // best-effort; never fail the gate on a summary-write error
    }
  }

  process.exit(exitCode);
}

main();
```

- [ ] **Step 2: Lint the new scripts**

Run: `corepack pnpm exec eslint scripts/run-verify-tests.mjs scripts/verify-test-planner.mjs --max-warnings=0`
Expected: clean (exit 0).

- [ ] **Step 3: Manual smoke (affected mode, fast)**

Run: `node scripts/run-verify-tests.mjs` from the repo root **on a branch with a small, non-core diff** (or expect a full run on `main`). Observe the `[verify-gate] mode=… workers=…` line and a `[verify-gate] summary …` line, and that the process exits with vitest's status.
Expected: a `[verify-gate]` summary prints; exit code mirrors vitest.

- [ ] **Step 4: Commit**

```bash
git add scripts/run-verify-tests.mjs
git commit -m "feat(verify-gate): entry runner (config + git diff + spawn + OOM retry)"
```

---

### Task 6: Subprocess integration test

**Files:**
- Create: `tests/verify/run-verify-tests.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/verify/run-verify-tests.integration.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Absolute path to the runner in THIS repo; createRequire inside it resolves
// vitest from this repo's node_modules even when run with a fixture cwd.
const RUNNER = resolve(process.cwd(), 'scripts/run-verify-tests.mjs');

let fixture: string;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'verify-gate-fixture-'));
  // A trivial passing test so the gate has something to run.
  writeFileSync(
    join(fixture, 'example.test.ts'),
    "import { expect, it } from 'vitest';\nit('passes', () => { expect(1).toBe(1); });\n",
    'utf8',
  );
  // Minimal vitest config scoped to the fixture file.
  writeFileSync(
    join(fixture, 'vitest.config.ts'),
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['example.test.ts'] } });\n",
    'utf8',
  );
  // Autonomous config with a testing block (empty diff in a non-repo → full gate).
  mkdirSync(join(fixture, '.agentforge'), { recursive: true });
  writeFileSync(
    join(fixture, '.agentforge', 'autonomous.yaml'),
    'testing:\n  affectedMode: auto\n  memory:\n    reserveGb: 1\n    perWorkerGb: 1\n    heapCapMb: 1024\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('run-verify-tests.mjs (subprocess)', () => {
  it('runs the fixture suite green and writes a full-gate summary', () => {
    const res = spawnSync(process.execPath, [RUNNER], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...process.env, AGENTFORGE_VERIFY_SUMMARY_DIR: fixture },
    });

    expect(res.status, res.stderr).toBe(0);
    const summaryPath = join(fixture, 'verify-gate-summary.json');
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    // Non-repo fixture → git diff fails → empty changed files → full gate.
    expect(summary.mode).toBe('full');
    expect(summary.exitCode).toBe(0);
    expect(summary.oomRetryCount).toBe(0);
    expect(summary.workers).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (then passes once Task 5 exists)**

Run: `corepack pnpm exec vitest run tests/verify/run-verify-tests.integration.test.ts`
Expected (if Task 5 not yet done): FAIL — runner missing. With Task 5 complete: PASS. If `vitest related`/bin resolution is wrong, this is where it surfaces — fix `resolveVitestBin` / `buildVitestArgs` until green.

- [ ] **Step 3: Run the full new suite together**

Run: `corepack pnpm exec vitest run tests/verify/`
Expected: PASS (planner unit tests + integration test).

- [ ] **Step 4: Commit**

```bash
git add tests/verify/run-verify-tests.integration.test.ts
git commit -m "test(verify-gate): subprocess integration test against a fixture"
```

---

### Task 7: Wire the runner into the cycle config

**Files:**
- Modify: `.agentforge/autonomous.yaml:47-53` (the `testing` block)

- [ ] **Step 1: Replace the testing block**

Change the existing block:

```yaml
testing:
  command: corepack pnpm exec vitest run --maxWorkers=2 --minWorkers=1
  timeoutMinutes: 20
  reporter: json
  saveRawLog: true
  buildCommand: corepack pnpm build
  typeCheckCommand: corepack pnpm exec tsc -b --noEmit --pretty false
```

to:

```yaml
testing:
  command: node scripts/run-verify-tests.mjs
  affectedMode: auto            # auto | related | full
  deepGateEveryNCycles: 5
  coreGlobs:
    - packages/core/src/runtime/**
    - packages/core/src/autonomous/**
    - packages/shared/**
  memory:
    reserveGb: 2.0
    perWorkerGb: 1.0
    heapCapMb: 2048
  timeoutMinutes: 20
  reporter: json
  saveRawLog: true
  buildCommand: corepack pnpm build
  typeCheckCommand: corepack pnpm exec tsc -b --noEmit --pretty false
```

- [ ] **Step 2: Validate the YAML parses**

Run: `node -e "const y=require('js-yaml'); const fs=require('fs'); console.log(JSON.stringify(y.load(fs.readFileSync('.agentforge/autonomous.yaml','utf8')).testing,null,2))"`
Expected: prints the testing block with `command: node scripts/run-verify-tests.mjs` and the `memory`/`coreGlobs` keys.

- [ ] **Step 3: Final gate — typecheck + lint + the new suite**

Run: `corepack pnpm run check:types && corepack pnpm exec eslint scripts/run-verify-tests.mjs scripts/verify-test-planner.mjs tests/verify/verify-test-planner.test.ts tests/verify/run-verify-tests.integration.test.ts --max-warnings=0 && corepack pnpm exec vitest run tests/verify/`
Expected: tsc exit 0, eslint exit 0, vitest all green.

- [ ] **Step 4: Commit**

```bash
git add .agentforge/autonomous.yaml
git commit -m "feat(verify-gate): point testing.command at the memory-adaptive runner"
```

---

## Self-Review

**Spec coverage (Section 1 of the design):**
- Memory-adaptive workers → Task 1 (`computeWorkers`) + Task 5 (live `freemem()`/`cpus()` wiring). ✓
- `NODE_OPTIONS` per-fork heap cap → Task 5 (`runVitest`). ✓
- OOM self-heal (retry once at half workers) → Task 3 (`isOomExit`/`nextWorkersOnOom`) + Task 5. ✓
- Affected-test selection (`vitest related`) → Task 3 (`buildVitestArgs`) + Task 5. ✓
- Deep-gate safety net (core-glob / every-Nth / empty-diff) → Task 2 (`selectGateMode`). ✓
- Config block (`affectedMode`, `deepGateEveryNCycles`, `coreGlobs`, `memory.*`) → Task 4 (`resolveVerifyConfig`) + Task 7 (yaml). ✓
- Summary fields (mode, workers, oomRetryCount) for later observability → Task 5 (sidecar + stderr). ✓
- `testPassRateFloor` unchanged → not touched (the gate still exits non-zero on test failure; pass-rate enforcement lives in the cycle gate phase, out of scope here). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type/name consistency:** `computeWorkers`, `matchesCoreGlobs`, `selectGateMode`, `isOomExit`, `nextWorkersOnOom`, `buildVitestArgs`, `resolveVerifyConfig` are defined in Tasks 1–4 and consumed by the runner in Task 5 with the same names/signatures. The summary object shape (`mode/workers/oomRetryCount/changedFileCount/exitCode/signal`) is produced in Task 5 and asserted in Task 6. ✓

**Known risk flagged in-plan:** the exact `vitest related --run` form and `resolveVitestBin` path are validated by the Task 6 integration test — if vitest 4's CLI differs, that test fails first and is the fix site (no silent breakage).

## Out of scope (later phases / separate plans)
- Passing the cycle's tracked `worktreeChangedFiles` into the runner via env (instead of the runner computing its own `git diff`) — the self-computed diff keeps Phase 1 a drop-in config change.
- Writing the summary fields into the per-cycle JSONL record (Section 5 observability).
- Routing/auto-switch wiring, risk-based auto-merge, size ramp + free-RAM guard (Sections 2–4).
