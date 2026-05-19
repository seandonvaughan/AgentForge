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
  it('fails verify:dashboard fast when dashboard check fails', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set(['pnpm --filter @agentforge/dashboard check']),
    );

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('pnpm --filter @agentforge/dashboard check');
    expect(trace).toEqual(['pnpm --filter @agentforge/dashboard check']);
  });

  it('runs dashboard build only after dashboard check succeeds', async () => {
    const { harness, trace } = createHarnessWithFailures(new Set());

    const result = await harness.run('verify:dashboard');

    expect(result.ok).toBe(true);
    expect(trace).toEqual([
      'pnpm --filter @agentforge/dashboard check',
      'pnpm --filter @agentforge/dashboard build',
    ]);
  });

  it('propagates dashboard verification failure into verify:gates and aborts post-check steps', async () => {
    const { harness, trace } = createHarnessWithFailures(
      new Set(['pnpm --filter @agentforge/dashboard check']),
    );

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('pnpm --filter @agentforge/dashboard check');
    expect(trace).toContain('pnpm lint');
    expect(trace).toContain('node scripts/check-version-sync.mjs');
    expect(trace).toContain('tsc -b');
    expect(trace).not.toContain('node scripts/check-help-output.mjs');
    expect(trace).not.toContain('node scripts/check-changelog.mjs');
    expect(trace).not.toContain('pnpm audit --audit-level low');
  });
});
