import { describe, expect, it } from 'vitest';
import {
  ScriptPipelineHarness,
  loadRootScripts,
} from './script-pipeline-harness.js';

const ADVERSARIAL_REGRESSION_COMMAND = 'vitest run tests/ci/dashboard-adversarial-guards.test.ts tests/ci/package-scripts.test.ts packages/server/src/routes/v5/__tests__/flywheel.test.ts packages/server/src/routes/v5/__tests__/search.test.ts';

function createHarnessWithFailures(failingLeafCommands: Set<string>) {
  const scripts = loadRootScripts();
  const trace: string[] = [];
  const harness = new ScriptPipelineHarness(scripts, (command) => {
    trace.push(command);
    return failingLeafCommands.has(command) ? 1 : 0;
  });
  return { harness, trace };
}

describe('dashboard verification adversarial guards', () => {
  it('fails verify:dashboard fast when dashboard check fails', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set(['pnpm --filter @agentforge/dashboard check']),
    );

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('pnpm --filter @agentforge/dashboard check');
    expect(result.trace).toEqual(['pnpm --filter @agentforge/dashboard check']);
    expect(trace).toEqual(['pnpm --filter @agentforge/dashboard check']);
  });

  it('runs dashboard build only after dashboard check succeeds', async () => {
    const { harness, trace } = createHarnessWithFailures(new Set());

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(true);
    expect(result.trace).toEqual([
      'pnpm --filter @agentforge/dashboard check',
      'pnpm --filter @agentforge/dashboard build',
    ]);
    expect(trace).toEqual(result.trace);
  });

  it('propagates dashboard verification failure into verify:gates and aborts post-check steps', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set(['pnpm --filter @agentforge/dashboard check']),
    );

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('pnpm --filter @agentforge/dashboard check');
    expect(
      result.trace.some((command) =>
        command.startsWith('eslint "src/**/*.{js,mjs,cjs,ts,tsx}"'),
      ),
    ).toBe(true);
    expect(result.trace).toContain('node scripts/check-version-sync.mjs');
    expect(result.trace).toContain('tsc -b');
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard check');
    expect(result.trace).not.toContain(ADVERSARIAL_REGRESSION_COMMAND);
    expect(result.trace).not.toContain('node scripts/check-help-output.mjs');
    expect(result.trace).not.toContain('node scripts/check-changelog.mjs');
    expect(result.trace).not.toContain('pnpm audit --audit-level low');
    expect(trace).toEqual(result.trace);
  });

  it('runs adversarial regression gate after verify:dashboard and before post-check steps', async () => {
    const { harness, trace } = createHarnessWithFailures(new Set());

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(true);
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard check');
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard build');
    expect(result.trace).toContain(ADVERSARIAL_REGRESSION_COMMAND);
    expect(result.trace.indexOf('pnpm --filter @agentforge/dashboard build')).toBeLessThan(
      result.trace.indexOf(ADVERSARIAL_REGRESSION_COMMAND),
    );
    expect(result.trace.indexOf(ADVERSARIAL_REGRESSION_COMMAND)).toBeLessThan(
      result.trace.indexOf('node scripts/check-help-output.mjs'),
    );
    expect(trace).toEqual(result.trace);
  });

  it('aborts verify:gates post-check steps when adversarial regression gate fails', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set([ADVERSARIAL_REGRESSION_COMMAND]),
    );

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(false);
    expect(result.failedScript).toBe('test:regression:adversarial');
    expect(result.failedCommand).toBe(ADVERSARIAL_REGRESSION_COMMAND);
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard check');
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard build');
    expect(result.trace).toContain(ADVERSARIAL_REGRESSION_COMMAND);
    expect(result.trace).not.toContain('node scripts/check-help-output.mjs');
    expect(result.trace).not.toContain('node scripts/check-changelog.mjs');
    expect(result.trace).not.toContain('pnpm audit --audit-level low');
    expect(trace).toEqual(result.trace);
  });
});
