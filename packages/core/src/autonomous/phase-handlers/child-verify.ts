// packages/core/src/autonomous/phase-handlers/child-verify.ts
//
// P0.5 — DETERMINISTIC per-child completion bar for epic-mode items.
//
// An epic-mode child runs in its own isolated worktree and is merged into the
// integration branch only if it "completed". Before this module a child was
// "completed" the moment its agent run finished with a non-empty diff; tests
// only ran cycle-wide later (VERIFY). Two verified gaps closed here:
//
//   (a) the old LLM gate's "iron law" checks (non-empty diff, declared files
//       touched, spec-required tests present) lived in a *prompt*, not code;
//   (b) `vitest related` does not run a NEWLY-ADDED test whose subject was
//       unchanged — a broken new test passed VERIFY and only failed in full CI
//       (PR #258). The scoped child run here force-includes changed test files.
//
// `verifyChildWorktree` is pure-deterministic: no LLM judgement. It runs the
// iron-law checks in code, a scoped typecheck, and the affected tests INSIDE the
// child's worktree, and returns a structured result. The command runner is
// injected (execFile wrapper) so unit tests can mock every subprocess — the same
// pattern RealTestRunner uses with execFile.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Default scoped typecheck command (mirrors autonomous.yaml testing.typeCheckCommand). */
const DEFAULT_TYPECHECK_COMMAND = 'corepack pnpm exec tsc -b --noEmit --pretty false';

/** Max characters of captured subprocess output retained on a failure entry. */
const OUTPUT_TAIL_LIMIT = 2000;

/**
 * Result of a single injected command invocation. `ok` is true when the process
 * exited 0. `output` is the combined stdout+stderr tail. Mirrors the minimal
 * surface a mock needs to provide in unit tests.
 */
export interface ChildVerifyCommandResult {
  ok: boolean;
  /** Exit code when known (null for signal-only termination). */
  code: number | null;
  /** Combined stdout + stderr (the caller tails it for the failure entry). */
  output: string;
}

/**
 * Injectable command runner. The production implementation shells `cmd args`
 * via execFile (never `exec` — no shell, no interpolation) inside `cwd`. Unit
 * tests pass a mock so no real subprocess runs.
 */
export type ChildVerifyCommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<ChildVerifyCommandResult>;

/** A single deterministic failure (or warning) produced by a child-verify check. */
export interface ChildVerifyFailure {
  /** Which check produced this entry. */
  check: 'iron-law' | 'scope' | 'requires-tests' | 'typecheck' | 'tests' | 'ci-config';
  /**
   * Severity. `failure` blocks the child (ok=false). `warning` is advisory and
   * does NOT by itself flip ok to false (e.g. out-of-scope files when no scope
   * was declared).
   */
  severity: 'failure' | 'warning';
  /** Human-readable explanation, safe to surface in the item error. */
  message: string;
  /** Tail of captured subprocess output, when the check ran a command. */
  outputTail?: string;
}

export interface VerifyChildWorktreeOptions {
  /** Absolute path to the child's isolated worktree. */
  worktreePath: string;
  /** Files the child actually changed (from meaningfulWorktreeChanges). */
  changedFiles: string[];
  /** Files the item declared it would touch. Empty ⇒ scope check is warn-level. */
  declaredFiles?: string[];
  /** When true, at least one changed file must be a test file. */
  requiresTests?: boolean;
  /** Injected command runner; defaults to a real execFile wrapper. */
  runner?: ChildVerifyCommandRunner;
  /** Scoped typecheck command override (defaults to the autonomous.yaml default). */
  typeCheckCommand?: string;
  /**
   * Vitest binary invocation used for the scoped affected-test run, as a single
   * command string (e.g. `corepack pnpm exec vitest`). The affected file list is
   * appended as `related --run <files>`. Defaults to `corepack pnpm exec vitest`.
   */
  testCommand?: string;
}

export interface ChildVerifyResult {
  /** True when no `failure`-severity entry was produced. */
  ok: boolean;
  /** All failures and warnings, in check order. */
  failures: ChildVerifyFailure[];
  /**
   * P0.5(4) — set true when a changed file is in the CI-config class
   * (package.json, pnpm-lock.yaml, .github/workflows/**, scripts/**). The
   * per-child bar does NOT run the full verify:gates pipeline; it surfaces this
   * flag so execute-phase can propagate it and the cycle-runner runs verify:gates
   * once at the epic level.
   */
  requiresFullGates: boolean;
  /** The affected test files the scoped run executed (deterministic, for traceability). */
  affectedTests: string[];
}

/** Normalize a path for matching: backslashes → slashes, strip a leading `./`. */
function normalizePath(file: string): string {
  return file.split('\\').join('/').replace(/^\.\//, '').trim();
}

/**
 * True when `file` is a test/spec file (.test|.spec × ts/tsx/js/jsx/mjs/cjs).
 * String-only matching (no regex over file paths) per repo convention — kept in
 * lockstep with scripts/verify-test-planner.mjs isTestFile.
 */
export function isTestFilePath(file: string): boolean {
  const norm = normalizePath(file);
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  return exts.some((ext) => norm.endsWith('.test' + ext) || norm.endsWith('.spec' + ext));
}

/** CI-config-class path prefixes/names whose change requires a full verify:gates run. */
export function isCiConfigPath(file: string): boolean {
  const norm = normalizePath(file);
  return (
    norm === 'package.json' ||
    norm.endsWith('/package.json') ||
    norm === 'pnpm-lock.yaml' ||
    norm.endsWith('/pnpm-lock.yaml') ||
    norm.startsWith('.github/workflows/') ||
    norm.startsWith('scripts/')
  );
}

/**
 * True when `changed` is within the declared scope. A changed file is in scope
 * when it equals a declared file or is a clean path-suffix/prefix of one
 * (tolerates relative-vs-absolute and directory declarations). Deliberately
 * tolerant on directory-style declarations (a declared `packages/core/src`
 * covers everything beneath it).
 */
function isWithinDeclaredScope(changed: string, declared: string[]): boolean {
  const c = normalizePath(changed);
  return declared.some((d) => {
    const dn = normalizePath(d);
    if (dn.length === 0) return false;
    if (c === dn) return true;
    if (c.endsWith('/' + dn) || dn.endsWith('/' + c)) return true;
    // Directory-style declaration: changed file lives under the declared dir.
    return c.startsWith(dn.endsWith('/') ? dn : dn + '/');
  });
}

/**
 * Compute the affected test set for the scoped child run: the changed source
 * files drive `vitest related` resolution, and every changed test file is
 * force-included so a brand-new test ALWAYS runs (PR #258 guard). Mirrors
 * selectAffectedFiles in scripts/verify-test-planner.mjs.
 */
export function selectChildAffectedFiles(changedFiles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (file: string): void => {
    const norm = normalizePath(file);
    if (norm.length === 0 || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  // Source files first (related resolution), then any changed test files.
  for (const f of changedFiles) {
    if (!isTestFilePath(f)) push(f);
  }
  for (const f of changedFiles) {
    if (isTestFilePath(f)) push(f);
  }
  return out;
}

/** The default production command runner: execFile, no shell. Output is tailed. */
const realCommandRunner: ChildVerifyCommandRunner = async (cmd, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, code: 0, output: `${stdout.toString()}${stderr.toString()}` };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
    return { ok: false, code: typeof e.code === 'number' ? e.code : null, output: out };
  }
};

/** Parse a single command string into [cmd, ...args] on whitespace. */
function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { cmd: parts[0] ?? '', args: parts.slice(1) };
}

function tail(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) return output;
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}

/**
 * P0.5 — Deterministic per-child verification bar. Runs entirely in code (no LLM):
 *
 *   1. iron-law checks: non-empty diff; every changed file within declared scope
 *      (warn-level when no scope declared); if requiresTests, ≥1 changed test file.
 *   2. scoped typecheck: run typeCheckCommand inside the worktree (execFile).
 *   3. affected tests: run `related --run <affected>` inside the worktree, where
 *      <affected> force-includes every changed test file. Zero failures required.
 *
 * CI-config-class changes set `requiresFullGates: true` (a `ci-config` warning is
 * also recorded) so the caller can run verify:gates once at the epic level —
 * this function never runs the full pipeline per child.
 *
 * Never throws: a runner rejection is captured as a failure entry, so the worst
 * case is `ok: false` with a structured reason. Callers can fail the child on it.
 */
export async function verifyChildWorktree(
  opts: VerifyChildWorktreeOptions,
): Promise<ChildVerifyResult> {
  const {
    worktreePath,
    changedFiles,
    declaredFiles = [],
    requiresTests = false,
    runner = realCommandRunner,
    typeCheckCommand = DEFAULT_TYPECHECK_COMMAND,
    testCommand = 'corepack pnpm exec vitest',
  } = opts;

  const failures: ChildVerifyFailure[] = [];
  const affectedTests = selectChildAffectedFiles(changedFiles);

  // ── (1) Iron-law: non-empty diff ────────────────────────────────────────
  if (changedFiles.length === 0) {
    failures.push({
      check: 'iron-law',
      severity: 'failure',
      message:
        'Child produced an empty diff: no source changes were made in the worktree.',
    });
    // An empty diff makes every subsequent check meaningless — return early.
    return { ok: false, failures, requiresFullGates: false, affectedTests };
  }

  // ── (1) Iron-law: declared-scope adherence ──────────────────────────────
  const hasScope = declaredFiles.some((d) => normalizePath(d).length > 0);
  const outOfScope = changedFiles.filter((f) => !isWithinDeclaredScope(f, declaredFiles));
  if (hasScope && outOfScope.length > 0) {
    failures.push({
      check: 'scope',
      severity: 'failure',
      message:
        `Child changed ${outOfScope.length} file(s) outside its declared scope: ` +
        outOfScope.map(normalizePath).join(', '),
    });
  } else if (!hasScope && changedFiles.length > 0) {
    // No declared scope to enforce — advisory only, never blocks.
    failures.push({
      check: 'scope',
      severity: 'warning',
      message:
        'Child declared no file scope; out-of-scope changes cannot be enforced (warning only).',
    });
  }

  // ── (1) Iron-law: spec-required tests present ───────────────────────────
  if (requiresTests) {
    const changedTestFiles = changedFiles.filter(isTestFilePath);
    if (changedTestFiles.length === 0) {
      failures.push({
        check: 'requires-tests',
        severity: 'failure',
        message:
          'Item requires tests but the child changed no test file ' +
          '(*.test.{ts,tsx,js,jsx,mjs,cjs} or *.spec.*).',
      });
    }
  }

  // ── (4) CI-config class → requiresFullGates flag ────────────────────────
  const ciConfigChanges = changedFiles.filter(isCiConfigPath);
  const requiresFullGates = ciConfigChanges.length > 0;
  if (requiresFullGates) {
    failures.push({
      check: 'ci-config',
      severity: 'warning',
      message:
        'Child touched CI-config-class file(s) (' +
        ciConfigChanges.map(normalizePath).join(', ') +
        '); the epic-level VERIFY must run verify:gates.',
    });
  }

  // ── (2) Scoped typecheck inside the worktree ────────────────────────────
  const tc = splitCommand(typeCheckCommand);
  if (tc.cmd.length > 0) {
    let res: ChildVerifyCommandResult;
    try {
      res = await runner(tc.cmd, tc.args, worktreePath);
    } catch (err) {
      res = {
        ok: false,
        code: null,
        output: err instanceof Error ? err.message : String(err),
      };
    }
    if (!res.ok) {
      failures.push({
        check: 'typecheck',
        severity: 'failure',
        message: `Scoped typecheck failed (exit ${res.code ?? 'signal'}).`,
        outputTail: tail(res.output),
      });
    }
  }

  // ── (3) Affected tests inside the worktree (force-includes changed tests) ─
  if (affectedTests.length > 0) {
    const vt = splitCommand(testCommand);
    if (vt.cmd.length > 0) {
      const testArgs = [...vt.args, 'related', '--run', ...affectedTests];
      let res: ChildVerifyCommandResult;
      try {
        res = await runner(vt.cmd, testArgs, worktreePath);
      } catch (err) {
        res = {
          ok: false,
          code: null,
          output: err instanceof Error ? err.message : String(err),
        };
      }
      if (!res.ok) {
        failures.push({
          check: 'tests',
          severity: 'failure',
          message:
            `Scoped affected tests failed (exit ${res.code ?? 'signal'}) for ` +
            `${affectedTests.length} file(s).`,
          outputTail: tail(res.output),
        });
      }
    }
  }

  const ok = !failures.some((f) => f.severity === 'failure');
  return { ok, failures, requiresFullGates, affectedTests };
}

/**
 * Render a child-verify result's failures into a single human-readable error
 * string, suitable for an ItemResult.error. Includes only `failure`-severity
 * entries by default; pass includeWarnings to also list warnings.
 */
export function formatChildVerifyError(
  result: ChildVerifyResult,
  includeWarnings = false,
): string {
  const entries = result.failures.filter(
    (f) => f.severity === 'failure' || (includeWarnings && f.severity === 'warning'),
  );
  if (entries.length === 0) return '';
  const lines = entries.map((f) => {
    const tailPart = f.outputTail ? `\n    ${f.outputTail.split('\n').slice(-8).join('\n    ')}` : '';
    return `[${f.check}/${f.severity}] ${f.message}${tailPart}`;
  });
  return `Per-child verify failed:\n${lines.join('\n')}`;
}
