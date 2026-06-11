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
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveCommandForExecFile,
  type ResolvedExecFileCommand,
} from '../subprocess-command.js';

const execFileAsync = promisify(execFile);

/**
 * Package-manager-aware command defaults, detected from the target worktree's
 * lockfile. The original defaults hardcoded `corepack pnpm exec ...`, which
 * deterministically failed EVERY child in any non-pnpm repository (observed on
 * acceptance cycle 11955f95: ledgerline is an npm project, so the scoped
 * typecheck exited 1 via corepack/pnpm.mjs before the child's code was even
 * considered). AgentForge must work on external projects with zero config —
 * the lockfile is the ground truth:
 *
 *   pnpm-lock.yaml     → corepack pnpm exec …  (AgentForge itself; -b for
 *                        project-reference workspaces)
 *   yarn.lock          → yarn …
 *   anything else      → npx …  (npm / package-lock.json / no lockfile)
 *
 * Explicit VerifyChildWorktreeOptions overrides always win.
 */
export interface DetectedPackageCommands {
  packageManager: 'pnpm' | 'yarn' | 'npm';
  typeCheckCommand: string;
  /** Vitest invocation prefix; child-verify appends `related --run <files>`. */
  testCommand: string;
  /** One-line tooling instruction for agent prompts in this repo. */
  toolingNote: string;
}

export function detectPackageCommands(rootDir: string): DetectedPackageCommands {
  if (existsSync(join(rootDir, 'pnpm-lock.yaml'))) {
    return {
      packageManager: 'pnpm',
      // NO --noEmit here: on project-reference workspaces `tsc -b --noEmit`
      // fails with TS6310 ("referenced project may not disable emit") — child-5
      // on cycle 72b6b50e failed exactly this way. Build mode emitting into the
      // throwaway worktree's dist/ is harmless and matches `pnpm build`.
      typeCheckCommand: 'corepack pnpm exec tsc -b --pretty false',
      testCommand: 'corepack pnpm exec vitest',
      toolingNote:
        'use `corepack pnpm` for every package/test command in this repo (e.g. `corepack pnpm exec vitest run <file>`); do not use bare `pnpm` or `npx`. If the isolated worktree is missing installed workspace links, run `corepack pnpm install --frozen-lockfile` first.',
    };
  }
  if (existsSync(join(rootDir, 'yarn.lock'))) {
    return {
      packageManager: 'yarn',
      typeCheckCommand: 'yarn tsc --noEmit --pretty false',
      testCommand: 'yarn vitest',
      toolingNote:
        'use `yarn` for every package/test command in this repo (e.g. `yarn vitest run <file>`). If dependencies are missing in the worktree, run `yarn install --frozen-lockfile` first.',
    };
  }
  return {
    packageManager: 'npm',
    typeCheckCommand: 'npx tsc --noEmit --pretty false',
    testCommand: 'npx vitest',
    toolingNote:
      'use `npm`/`npx` for every package/test command in this repo (e.g. `npx vitest run <file>`). If dependencies are missing in the worktree, run `npm ci` (or `npm install`) first.',
  };
}

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
  /** Terminating signal when known. */
  signal?: string | null;
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

export function createSerialChildVerifyCommandRunner(
  baseRunner: ChildVerifyCommandRunner,
): ChildVerifyCommandRunner {
  let tail: Promise<void> = Promise.resolve();
  return async (cmd, args, cwd) => {
    const run = tail.then(() => baseRunner(cmd, args, cwd));
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** A single deterministic failure (or warning) produced by a child-verify check. */
export interface ChildVerifyFailure {
  /** Which check produced this entry. */
  check: 'iron-law' | 'scope' | 'requires-tests' | 'deps' | 'typecheck' | 'tests' | 'ci-config';
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
  /**
   * Scoped typecheck command override. Defaults to the worktree's detected
   * package manager (see detectPackageCommands — pnpm/yarn/npx).
   */
  typeCheckCommand?: string;
  /**
   * Vitest binary invocation used for the scoped affected-test run, as a single
   * command string (e.g. `corepack pnpm exec vitest`). The affected file list is
   * appended as `related --run <files>`. Defaults to the worktree's detected
   * package manager (see detectPackageCommands).
   */
  testCommand?: string;
  /**
   * Known-flaky / environment-specific test files to exclude from the scoped
   * run (testing.knownFlakyTestFiles). `vitest related` transitively resolves
   * tests by import graph, so a pre-existing darwin-only failure (e.g. the
   * /var vs /private/var realpath tests) gets pulled into UNRELATED children's
   * runs and fails them for an environmental issue that is not theirs —
   * observed failing 9 children on cycle 4e451e22. Entries are passed to
   * vitest as `--exclude <path>` globs and dropped from the force-include
   * list. The cycle-level VERIFY still runs the FULL suite with its own
   * newFailures-vs-baseline semantics, so nothing is silently skipped at
   * release time.
   */
  excludeTestFiles?: string[];
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

/**
 * Ensure the worktree has installed dependencies before running its toolchain.
 *
 * A fresh git worktree of a pnpm workspace has NO node_modules (pnpm links per
 * package from the store), so `corepack pnpm exec tsc` fails with
 * ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL "Command tsc not found" before the child's
 * code is even considered — observed as 22/22 children failing on the first
 * $300 epic run (cycle cbe1ec58). The multi-PR verify path already installs per
 * worktree; the per-child bar now does the same, once, only when node_modules
 * is absent. npm/yarn worktrees get the analogous install. A failed install is
 * surfaced as a structured `deps` failure rather than a misleading
 * typecheck/tests failure.
 */
async function ensureWorktreeDependencies(
  worktreePath: string,
  detected: DetectedPackageCommands,
  runner: ChildVerifyCommandRunner,
): Promise<ChildVerifyFailure | null> {
  // Completion MARKERS, not bare existsSync(node_modules): a killed prior run
  // leaves PARTIAL node_modules in pooled worktrees (no .bin links), which a
  // directory-existence check happily skips — observed on cycle 72b6b50e where
  // reused run-1 worktrees carried half-installed trees and `pnpm exec tsc`
  // still failed "not found". Each manager writes its marker at install
  // COMPLETION: pnpm → node_modules/.modules.yaml, npm → node_modules/
  // .package-lock.json. No marker → (re-)install; installs are idempotent and
  // near-instant on a warm store when the tree is actually complete.
  const installed = (marker: string): boolean =>
    existsSync(join(worktreePath, 'node_modules', marker));
  const install: { cmd: string; args: string[] } | null =
    detected.packageManager === 'pnpm'
      ? installed('.modules.yaml')
        ? null
        : { cmd: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'] }
      : detected.packageManager === 'yarn'
        ? installed('.yarn-state.yml') || installed('.yarn-integrity')
          ? null
          : { cmd: 'yarn', args: ['install', '--frozen-lockfile'] }
        : existsSync(join(worktreePath, 'package-lock.json'))
          ? installed('.package-lock.json')
            ? null
            : { cmd: 'npm', args: ['ci'] }
          : null; // npm repo without a lockfile — npx self-provisions; skip.
  if (!install) return null;
  let res: ChildVerifyCommandResult;
  try {
    res = await runner(install.cmd, install.args, worktreePath);
  } catch (err) {
    res = { ok: false, code: null, output: err instanceof Error ? err.message : String(err) };
  }
  if (res.ok) return null;
  return {
    check: 'deps',
    severity: 'failure',
    message:
      `Worktree dependency install failed (${formatCommandExit(res)}): ` +
      `${install.cmd} ${install.args.join(' ')}`,
    outputTail: tail(res.output),
  };
}

/** The default production command runner: execFile, no shell. Output is tailed. */
const rawRealCommandRunner: ChildVerifyCommandRunner = async (cmd, args, cwd) => {
  const invocation = resolveChildVerifyCommandForExecFile(cmd, args);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    return { ok: true, code: 0, output: `${stdout.toString()}${stderr.toString()}` };
  } catch (err: unknown) {
    const e = err as {
      code?: number;
      signal?: string | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
    const output = out.length > 0 ? out : e.message ?? '';
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : null,
      ...(typeof e.signal === 'string' ? { signal: e.signal } : {}),
      output,
    };
  }
};

const realCommandRunner = createSerialChildVerifyCommandRunner(rawRealCommandRunner);

export function resolveChildVerifyCommandForExecFile(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  nodeExecPath: string = process.execPath,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecFileCommand {
  return resolveCommandForExecFile(cmd, args, platform, nodeExecPath, env);
}

/** Parse a single command string into [cmd, ...args] on whitespace. */
function splitCommand(command: string): { cmd: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { cmd: parts[0] ?? '', args: parts.slice(1) };
}

function tail(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) return output;
  return output.slice(output.length - OUTPUT_TAIL_LIMIT);
}

function formatCommandExit(result: ChildVerifyCommandResult): string {
  if (result.code !== null) return `exit ${result.code}`;
  if (result.signal) return `signal ${result.signal}`;
  return 'signal';
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
  // Package-manager-aware defaults: detect from the worktree's lockfile so the
  // bar runs the repo's OWN toolchain (explicit opts always win).
  const detected = detectPackageCommands(opts.worktreePath);
  const {
    worktreePath,
    changedFiles,
    declaredFiles = [],
    requiresTests = false,
    runner = realCommandRunner,
    typeCheckCommand = detected.typeCheckCommand,
    testCommand = detected.testCommand,
    excludeTestFiles = [],
  } = opts;

  const failures: ChildVerifyFailure[] = [];
  // Drop known-flaky files from the force-include list; the same entries are
  // also passed to vitest as --exclude so `related` resolution cannot pull
  // them back in transitively.
  const excludeNorm = excludeTestFiles.map(normalizePath).filter((f) => f.length > 0);
  const isExcluded = (file: string): boolean => {
    const norm = normalizePath(file);
    return excludeNorm.some((ex) => norm === ex || norm.endsWith('/' + ex));
  };
  const affectedTests = selectChildAffectedFiles(changedFiles).filter((f) => !isExcluded(f));

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

  // ── (1.5) Worktree dependency provisioning (pnpm/yarn/npm-with-lockfile) ──
  // Must precede the toolchain checks: without node_modules they fail with a
  // misleading "Command tsc/vitest not found" regardless of the child's code.
  const depsFailure = await ensureWorktreeDependencies(worktreePath, detected, runner);
  if (depsFailure) {
    failures.push(depsFailure);
    // The toolchain cannot run — return the structural reason alone instead of
    // burying it under bogus typecheck/tests failures.
    return {
      ok: false,
      failures,
      requiresFullGates,
      affectedTests,
    };
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
        message: `Scoped typecheck failed (${formatCommandExit(res)}).`,
        outputTail: tail(res.output),
      });
    }
  }

  // ── (3) Affected tests inside the worktree (force-includes changed tests) ─
  if (affectedTests.length > 0) {
    const vt = splitCommand(testCommand);
    if (vt.cmd.length > 0) {
      // Full relative paths are valid vitest globs as-is; bare basenames need
      // the **/ prefix to match at any depth.
      const excludeArgs = excludeNorm.flatMap((ex) => [
        '--exclude',
        ex.includes('/') ? ex : `**/${ex}`,
      ]);
      const testArgs = [...vt.args, 'related', '--run', ...excludeArgs, ...affectedTests];
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
            `Scoped affected tests failed (${formatCommandExit(res)}) for ` +
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
