import { describe, expect, it } from 'vitest';
import {
  ScriptPipelineHarness,
  loadRootScripts,
} from './script-pipeline-harness.js';

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
  it('pins critical dashboard e2e coverage in test:e2e:dashboard', () => {
    const scripts = loadRootScripts();
    const dashboardSuite = scripts['test:e2e:dashboard'];

    expect(typeof dashboardSuite).toBe('string');
    expect(dashboardSuite).toContain('tests/e2e/dashboard-runner.test.ts');
    expect(dashboardSuite).toContain('tests/e2e/dashboard-live.test.ts');
    expect(dashboardSuite).toContain('tests/e2e/dashboard-health.test.ts');
  });

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

  it('keeps dashboard e2e after vitest in verify:product', async () => {
    const { harness } = createHarnessWithFailures(new Set());

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(true);
    const vitestIndex = result.trace.indexOf('vitest run');
    const dashboardE2eIndex = result.trace.findIndex((command) =>
      command.includes('playwright test tests/e2e/dashboard-agents.test.ts'),
    );
    expect(vitestIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardE2eIndex).toBeGreaterThan(vitestIndex);
    const dashboardE2eCommand = result.trace[dashboardE2eIndex] ?? '';
    expect(dashboardE2eCommand).toContain('tests/e2e/dashboard-runner.test.ts');
    expect(dashboardE2eCommand).toContain('tests/e2e/dashboard-live.test.ts');
    expect(dashboardE2eCommand).toContain('tests/e2e/dashboard-health.test.ts');
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
    expect(result.trace).not.toContain('node scripts/check-help-output.mjs');
    expect(result.trace).not.toContain('node scripts/check-changelog.mjs');
    expect(result.trace).not.toContain('pnpm audit --audit-level low');
    expect(trace).toEqual(result.trace);
  });
});
