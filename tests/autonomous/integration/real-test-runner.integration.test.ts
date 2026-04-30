import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RealTestRunner, TestRunTimeoutError } from '../../../packages/core/src/autonomous/exec/real-test-runner.js';
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

    const install = buildExecInvocation('npm', ['install']);
    await execFileAsync(install.file, install.args, { cwd: tmpProject });
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (tmpProject) {
      try {
        rmSync(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Windows can briefly retain npm/vitest file handles after process exit.
      }
    }
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

  it('throws TestRunTimeoutError when vitest exceeds the configured timeout', async () => {
    // 100ms / 60_000 ms-per-min ≈ 0.00167 minutes. Even with the fixture deps
    // already installed via beforeAll, vitest startup alone takes >100ms.
    const runner = new RealTestRunner(
      tmpProject,
      { ...DEFAULT_CYCLE_CONFIG.testing, timeoutMinutes: 100 / 60_000 },
      null,
    );
    await expect(runner.run('test-cycle')).rejects.toBeInstanceOf(TestRunTimeoutError);
  }, 120_000);
});

function buildExecInvocation(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { file: command, args };
  }

  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')],
  };
}

function quoteCmdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=,+@%\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}
