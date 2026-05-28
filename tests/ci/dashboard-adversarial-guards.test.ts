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

const DASHBOARD_CHECK = 'node scripts/run-pnpm.mjs -- --filter @agentforge/dashboard check';
const DASHBOARD_BUILD = 'node scripts/run-pnpm.mjs -- --filter @agentforge/dashboard build';
const AUDIT_DEPS = 'node scripts/run-pnpm.mjs -- audit --audit-level low';

describe('dashboard verification adversarial guards', () => {
  it('fails verify:dashboard fast when dashboard check fails', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set([DASHBOARD_CHECK]),
    );

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe(DASHBOARD_CHECK);
    expect(result.trace).toEqual([DASHBOARD_CHECK]);
    expect(trace).toEqual([DASHBOARD_CHECK]);
  });

  it('runs dashboard build only after dashboard check succeeds', async () => {
    const { harness, trace } = createHarnessWithFailures(new Set());

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(true);
    expect(result.trace).toEqual([
      DASHBOARD_CHECK,
      DASHBOARD_BUILD,
    ]);
    expect(trace).toEqual(result.trace);
  });

  it('propagates dashboard verification failure into verify:gates and aborts post-check steps', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set([DASHBOARD_CHECK]),
    );

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe(DASHBOARD_CHECK);
    expect(
      result.trace.some((command) =>
        command.startsWith('eslint "src/**/*.{js,mjs,cjs,ts,tsx}"'),
      ),
    ).toBe(true);
    expect(result.trace).toContain('node scripts/check-version-sync.mjs');
    expect(result.trace).toContain('tsc -b');
    expect(result.trace).toContain(DASHBOARD_CHECK);
    expect(result.trace).not.toContain('node scripts/check-help-output.mjs');
    expect(result.trace).not.toContain('node scripts/check-changelog.mjs');
    expect(result.trace).not.toContain(AUDIT_DEPS);
    expect(trace).toEqual(result.trace);
  });
});
