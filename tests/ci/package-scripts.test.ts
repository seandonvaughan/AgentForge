import { describe, expect, it } from 'vitest';
import {
  ScriptPipelineHarness,
  loadRootScripts,
} from './script-pipeline-harness.js';

describe('package scripts', () => {
  it('stops verify:product before tests when typecheck fails', async () => {
    const scripts = loadRootScripts();
    const trace: string[] = [];
    const harness = new ScriptPipelineHarness(scripts, (command) => {
      trace.push(command);
      return command === 'pnpm build' ? 1 : 0;
    });

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('pnpm build');
    expect(trace).not.toContain('vitest run');
    expect(trace.some((command) => command.startsWith('playwright test'))).toBe(
      false,
    );
  });

  it('runs typecheck leaf commands before unit tests in verify:product', async () => {
    const scripts = loadRootScripts();
    const trace: string[] = [];
    const harness = new ScriptPipelineHarness(scripts, (command) => {
      trace.push(command);
      return 0;
    });

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(true);
    expect(trace.indexOf('pnpm build')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('pnpm exec tsc -b --noEmit')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('vitest run')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('pnpm build')).toBeLessThan(trace.indexOf('vitest run'));
    expect(trace.indexOf('pnpm exec tsc -b --noEmit')).toBeLessThan(trace.indexOf('vitest run'));
  });
});
