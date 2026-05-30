#!/usr/bin/env node
/**
 * verify-test-planner.mjs — pure planning functions for the autonomous-cycle
 * VERIFY gate. No I/O, no process state: every function is a deterministic
 * transform so it is unit-testable without running vitest or touching the FS.
 *
 * Phase 1, Section 1 of docs/superpowers/specs/2026-05-28-production-autonomous-cycles-design.md.
 */

/**
 * Safe vitest worker count: bounded by both available memory and CPUs.
 * @param {number} freeGb   currently-available memory, in GB
 * @param {number} cores    logical CPU count
 * @param {{ reserveGb: number, perWorkerGb: number }} budget
 * @returns {number} integer >= 1
 */
export function computeWorkers(freeGb, cores, { reserveGb, perWorkerGb }) {
  const byMem = Math.floor((freeGb - reserveGb) / perWorkerGb);
  const byCpu = cores - 1;
  return Math.max(1, Math.min(byMem, byCpu));
}

/**
 * Match a path against simple globs (prefix `/**`, single-segment `/*`, or exact).
 * Uses String ops only (no regex over file paths) per repo convention.
 */
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

/** OOM signatures: OS OOM-killer (SIGKILL→137) or V8 heap abort (SIGABRT→134). */
export function isOomExit(code, signal) {
  return signal === 'SIGKILL' || signal === 'SIGABRT' || code === 137 || code === 134;
}

/** Halve workers for the single OOM retry; never below 1. */
export function nextWorkersOnOom(workers) {
  return Math.max(1, Math.floor(workers / 2));
}

/**
 * Construct vitest CLI args. `related --run <files>` runs only affected tests once.
 *
 * IMPORTANT: only `--maxWorkers` is emitted. vitest 4.x rejects `--minWorkers`
 * with a fatal `CACError: Unknown option --minWorkers` before any test runs,
 * which is exactly the bug that broke the VERIFY gate for every cycle.
 */
export function buildVitestArgs({ mode, changedFiles = [], workers }) {
  const workerFlags = [`--maxWorkers=${workers}`];
  if (mode === 'related' && changedFiles.length > 0) {
    return ['related', '--run', ...changedFiles, ...workerFlags];
  }
  return ['run', ...workerFlags];
}

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
