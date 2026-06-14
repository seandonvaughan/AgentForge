import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const RUNNER = resolve('scripts/verify-cycle-success.mjs');

interface FixtureOptions {
  cycle?: Record<string, unknown>;
  execute?: Record<string, unknown>;
  prs?: unknown[];
}

function makeTmpDir(): string {
  const dir = join(tmpdir(), `verify-cycle-success-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(projectRoot: string, options: FixtureOptions = {}): void {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', 'cycle-a');
  mkdirSync(join(cycleDir, 'phases'), { recursive: true });
  writeFileSync(
    join(cycleDir, 'cycle.json'),
    JSON.stringify({
      cycleId: 'cycle-a',
      stage: 'completed',
      gateVerdict: 'APPROVE',
      tests: { total: 1, passed: 1, failed: 0, newFailures: [] },
      ...options.cycle,
    }),
    'utf8',
  );
  writeFileSync(
    join(cycleDir, 'phases', 'execute.json'),
    JSON.stringify({
      itemResults: [{ itemId: 'item-1', status: 'completed' }],
      ...options.execute,
    }),
    'utf8',
  );
  writeFileSync(
    join(cycleDir, 'agent-prs.json'),
    JSON.stringify(options.prs ?? [{
      cycleId: 'cycle-a',
      branch: 'codex/cycle-a',
      prUrl: 'https://example.test/pull/1',
      prNumber: 1,
      status: 'open',
    }]),
    'utf8',
  );
}

function runVerifier(projectRoot: string) {
  return spawnSync(process.execPath, [RUNNER, '--project-root', projectRoot, '--cycle', 'cycle-a'], {
    encoding: 'utf8',
  });
}

function runVerifierWithArgs(projectRoot: string, args: string[]) {
  return spawnSync(process.execPath, [RUNNER, ...args, '--project-root', projectRoot, '--cycle', 'cycle-a'], {
    encoding: 'utf8',
  });
}

describe('verify-cycle-success CLI', () => {
  let projectRoot: string;

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('passes when the cycle has terminal approval, clean execute state, tests, and PR metadata', () => {
    projectRoot = makeTmpDir();
    writeFixture(projectRoot);

    const result = runVerifier(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[verify:cycle-success] PASS cycle=cycle-a');
  });

  it('passes with baseline test failures when no new failures are recorded', () => {
    projectRoot = makeTmpDir();
    writeFixture(projectRoot, {
      cycle: { tests: { total: 9206, passed: 9202, failed: 4, newFailures: [] } },
    });

    const result = runVerifier(projectRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[verify:cycle-success] PASS cycle=cycle-a');
    expect(result.stderr).toContain('baseline/pre-existing test failures present: failed=4 newFailures=0');
  });

  it('rejects baseline failures in strict all-tests-pass mode', () => {
    projectRoot = makeTmpDir();
    writeFixture(projectRoot, {
      cycle: { tests: { total: 9206, passed: 9202, failed: 4, newFailures: [] } },
    });

    const result = runVerifierWithArgs(projectRoot, ['--require-all-tests-pass']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tests not fully green: passed=9202/9206 failed=4');
  });

  it('accepts a literal -- separator before CLI args', () => {
    projectRoot = makeTmpDir();
    writeFixture(projectRoot);

    const result = runVerifierWithArgs(projectRoot, ['--']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[verify:cycle-success] PASS cycle=cycle-a');
  });

  it.each([
    {
      name: 'incomplete terminal stage',
      fixture: { cycle: { stage: 'failed' } },
      message: 'cycle stage is "failed", expected "completed"',
    },
    {
      name: 'gate rejection',
      fixture: { cycle: { gateVerdict: 'REJECT' } },
      message: 'gateVerdict is "REJECT", expected "APPROVE"',
    },
    {
      name: 'failed execute item',
      fixture: { execute: { itemResults: [{ itemId: 'item-1', status: 'failed' }] } },
      message: 'execute has final failed/blocked items: item-1:failed',
    },
    {
      name: 'empty execute results',
      fixture: { execute: { itemResults: [] } },
      message: 'execute.itemResults is empty',
    },
    {
      name: 'zero tests',
      fixture: { cycle: { tests: { total: 0, passed: 0, failed: 0, newFailures: [] } } },
      message: 'cycle tests.total is 0',
    },
    {
      name: 'new test failures',
      fixture: { cycle: { tests: { total: 2, passed: 1, failed: 1, newFailures: ['test-a'] } } },
      message: 'cycle has new test failures: newFailures=1',
    },
    {
      name: 'missing new failure classification',
      fixture: { cycle: { tests: { total: 2, passed: 1, failed: 1 } } },
      message: 'cycle tests.newFailures is missing',
    },
    {
      name: 'missing PR metadata',
      fixture: { prs: [] },
      message: 'cycle has no PR metadata',
    },
    {
      name: 'foreign-cycle PR metadata',
      fixture: { prs: [{ cycleId: 'other-cycle', prUrl: 'https://example.test/pull/2' }] },
      message: 'cycle has no PR metadata',
    },
  ])('rejects $name', ({ fixture, message }) => {
    projectRoot = makeTmpDir();
    writeFixture(projectRoot, fixture);

    const result = runVerifier(projectRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[verify:cycle-success] FAILED cycle=cycle-a');
    expect(result.stderr).toContain(message);
  });
});
