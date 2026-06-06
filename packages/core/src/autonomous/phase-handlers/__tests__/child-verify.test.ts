/**
 * P0.5 — Unit tests for the DETERMINISTIC per-child completion bar.
 *
 * verifyChildWorktree runs entirely in code (no LLM). The command runner is
 * injected, so these tests mock every subprocess and never touch git/vitest/tsc.
 * They assert the iron-law checks, the scoped typecheck/test gating, the
 * force-include of changed test files, and the CI-config requiresFullGates flag.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  verifyChildWorktree,
  isTestFilePath,
  isCiConfigPath,
  selectChildAffectedFiles,
  formatChildVerifyError,
  type ChildVerifyCommandRunner,
  type ChildVerifyCommandResult,
} from '../child-verify.js';

/** A runner that returns ok for every command. */
const allGreenRunner: ChildVerifyCommandRunner = async () => ({ ok: true, code: 0, output: '' });

/** A runner whose result is keyed on whether the args include `related` (tests) vs not (typecheck). */
function runnerWith(opts: {
  typecheck?: ChildVerifyCommandResult;
  tests?: ChildVerifyCommandResult;
}): { runner: ChildVerifyCommandRunner; calls: Array<{ cmd: string; args: string[]; cwd: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const runner: ChildVerifyCommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    if (args.includes('related')) return opts.tests ?? { ok: true, code: 0, output: '' };
    return opts.typecheck ?? { ok: true, code: 0, output: '' };
  };
  return { runner, calls };
}

describe('isTestFilePath', () => {
  it('matches .test/.spec across extensions and normalizes backslashes', () => {
    expect(isTestFilePath('packages/core/src/foo.test.ts')).toBe(true);
    expect(isTestFilePath('a/b.spec.tsx')).toBe(true);
    expect(isTestFilePath('a\\b\\c.test.mjs')).toBe(true);
    expect(isTestFilePath('packages/core/src/foo.ts')).toBe(false);
    expect(isTestFilePath('packages/core/src/test-helper.ts')).toBe(false);
  });
});

describe('isCiConfigPath', () => {
  it('flags package.json, pnpm-lock.yaml, workflows and scripts', () => {
    expect(isCiConfigPath('package.json')).toBe(true);
    expect(isCiConfigPath('packages/core/package.json')).toBe(true);
    expect(isCiConfigPath('pnpm-lock.yaml')).toBe(true);
    expect(isCiConfigPath('.github/workflows/ci.yml')).toBe(true);
    expect(isCiConfigPath('scripts/run-verify-tests.mjs')).toBe(true);
    expect(isCiConfigPath('packages/core/src/index.ts')).toBe(false);
  });
});

describe('selectChildAffectedFiles', () => {
  it('puts source files first, then force-includes changed test files, deduped', () => {
    expect(
      selectChildAffectedFiles(['src/a.test.ts', 'src/impl.ts', 'src/a.test.ts']),
    ).toEqual(['src/impl.ts', 'src/a.test.ts']);
  });
});

describe('verifyChildWorktree — all green', () => {
  it('returns ok with no failures when iron-law + typecheck + tests all pass', async () => {
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['packages/core/src/impl.ts', 'packages/core/src/impl.test.ts'],
      declaredFiles: ['packages/core/src/impl.ts', 'packages/core/src/impl.test.ts'],
      requiresTests: true,
      runner: allGreenRunner,
    });
    expect(result.ok).toBe(true);
    expect(result.failures.filter((f) => f.severity === 'failure')).toHaveLength(0);
    expect(result.requiresFullGates).toBe(false);
    expect(result.affectedTests).toContain('packages/core/src/impl.test.ts');
  });
});

describe('verifyChildWorktree — iron-law: empty diff', () => {
  it('fails with an iron-law failure and runs no commands', async () => {
    const { runner, calls } = runnerWith({});
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: [],
      runner,
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.check).toBe('iron-law');
    expect(result.failures[0]!.message).toMatch(/empty diff/i);
    // No subprocess should run when the diff is empty.
    expect(calls).toHaveLength(0);
  });
});

describe('verifyChildWorktree — failing scoped tests', () => {
  it('lists a tests failure with the captured output tail when vitest exits non-zero', async () => {
    const { runner } = runnerWith({
      tests: { ok: false, code: 1, output: 'FAIL src/impl.test.ts\nAssertionError: expected 1 to be 2' },
    });
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts', 'src/impl.test.ts'],
      declaredFiles: ['src/impl.ts', 'src/impl.test.ts'],
      runner,
    });
    expect(result.ok).toBe(false);
    const testFail = result.failures.find((f) => f.check === 'tests');
    expect(testFail).toBeDefined();
    expect(testFail!.severity).toBe('failure');
    expect(testFail!.outputTail).toContain('AssertionError');
  });
});

describe('verifyChildWorktree — failing scoped typecheck', () => {
  it('lists a typecheck failure with the captured output tail', async () => {
    const { runner } = runnerWith({
      typecheck: { ok: false, code: 2, output: "error TS2322: Type 'string' is not assignable to type 'number'." },
    });
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts'],
      declaredFiles: ['src/impl.ts'],
      runner,
    });
    expect(result.ok).toBe(false);
    const tcFail = result.failures.find((f) => f.check === 'typecheck');
    expect(tcFail).toBeDefined();
    expect(tcFail!.outputTail).toContain('TS2322');
  });
});

describe('verifyChildWorktree — out-of-scope file', () => {
  it('flags an out-of-scope changed file as a blocking failure when scope is declared', async () => {
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts', 'src/unrelated.ts'],
      declaredFiles: ['src/impl.ts'],
      runner: allGreenRunner,
    });
    expect(result.ok).toBe(false);
    const scope = result.failures.find((f) => f.check === 'scope');
    expect(scope).toBeDefined();
    expect(scope!.severity).toBe('failure');
    expect(scope!.message).toContain('src/unrelated.ts');
  });

  it('downgrades scope to a warning (non-blocking) when no scope was declared', async () => {
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts'],
      declaredFiles: [],
      runner: allGreenRunner,
    });
    expect(result.ok).toBe(true);
    const scope = result.failures.find((f) => f.check === 'scope');
    expect(scope).toBeDefined();
    expect(scope!.severity).toBe('warning');
  });
});

describe('verifyChildWorktree — requiresTests', () => {
  it('fails when requiresTests but no test file is among the changed files', async () => {
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts'],
      declaredFiles: ['src/impl.ts'],
      requiresTests: true,
      runner: allGreenRunner,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.find((f) => f.check === 'requires-tests')).toBeDefined();
  });
});

describe('verifyChildWorktree — CI-config requiresFullGates', () => {
  it('sets requiresFullGates and records a ci-config warning when package.json changes', async () => {
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['package.json', 'src/impl.ts'],
      declaredFiles: ['package.json', 'src/impl.ts'],
      runner: allGreenRunner,
    });
    expect(result.requiresFullGates).toBe(true);
    const ci = result.failures.find((f) => f.check === 'ci-config');
    expect(ci).toBeDefined();
    expect(ci!.severity).toBe('warning');
    // The warning alone does not block the child.
    expect(result.ok).toBe(true);
  });
});

describe('verifyChildWorktree — force-includes a newly-added test file (PR #258 guard)', () => {
  it('passes the brand-new test file to the scoped vitest run', async () => {
    const { runner, calls } = runnerWith({});
    await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/feature.ts', 'src/__tests__/brand-new.test.ts'],
      declaredFiles: ['src/feature.ts', 'src/__tests__/brand-new.test.ts'],
      runner,
    });
    const testCall = calls.find((c) => c.args.includes('related'));
    expect(testCall).toBeDefined();
    expect(testCall!.args).toContain('src/__tests__/brand-new.test.ts');
  });
});

describe('verifyChildWorktree — runner rejection is captured, never thrown', () => {
  it('records a typecheck failure when the runner throws', async () => {
    const throwingRunner: ChildVerifyCommandRunner = async (_cmd, args) => {
      if (!args.includes('related')) throw new Error('spawn ENOENT');
      return { ok: true, code: 0, output: '' };
    };
    const result = await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts'],
      declaredFiles: ['src/impl.ts'],
      runner: throwingRunner,
    });
    expect(result.ok).toBe(false);
    const tc = result.failures.find((f) => f.check === 'typecheck');
    expect(tc).toBeDefined();
    expect(tc!.outputTail ?? tc!.message).toContain('ENOENT');
  });
});

describe('formatChildVerifyError', () => {
  it('renders only failures by default and includes check labels', () => {
    const msg = formatChildVerifyError({
      ok: false,
      requiresFullGates: false,
      affectedTests: [],
      failures: [
        { check: 'scope', severity: 'warning', message: 'no scope' },
        { check: 'tests', severity: 'failure', message: 'tests failed', outputTail: 'AssertionError' },
      ],
    });
    expect(msg).toContain('[tests/failure]');
    expect(msg).not.toContain('[scope/warning]');
    expect(msg).toContain('AssertionError');
  });
});

// Defensive: spy verification that the production runner default isn't accidentally
// invoked when a mock is supplied (no real subprocess).
describe('verifyChildWorktree — uses the injected runner only', () => {
  it('never calls execFile when a mock runner is supplied', async () => {
    const spy = vi.fn(allGreenRunner);
    await verifyChildWorktree({
      worktreePath: '/tmp/wt',
      changedFiles: ['src/impl.ts'],
      declaredFiles: ['src/impl.ts'],
      runner: spy,
    });
    expect(spy).toHaveBeenCalled();
  });
});
