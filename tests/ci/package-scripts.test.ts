import { describe, expect, it } from 'vitest';
import {
  ScriptPipelineHarness,
  loadRootScripts,
} from './script-pipeline-harness.js';

describe('package scripts', () => {
  it('stops verify:product before tests when typecheck fails', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, (command) => {
      return command === 'tsc -b' ? 1 : 0;
    });

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(false);
    expect(result.failedCommand).toBe('tsc -b');
    expect(result.trace).not.toContain('vitest run');
    expect(result.trace.some((command) => command.startsWith('playwright test'))).toBe(
      false,
    );
  });

  it('runs typecheck leaf commands before unit tests in verify:product', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, () => 0);

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(true);
    expect(result.trace.indexOf('tsc -b')).toBeGreaterThanOrEqual(0);
    expect(result.trace.indexOf('pnpm exec tsc -b --noEmit')).toBeGreaterThanOrEqual(0);
    expect(result.trace.indexOf('vitest run')).toBeGreaterThanOrEqual(0);
    expect(result.trace.indexOf('tsc -b')).toBeLessThan(
      result.trace.indexOf('vitest run'),
    );
    expect(result.trace.indexOf('pnpm exec tsc -b --noEmit')).toBeLessThan(
      result.trace.indexOf('vitest run'),
    );
  });

  it('preserves parent trace when a nested script fails', async () => {
    const harness = new ScriptPipelineHarness(
      {
        parent: 'echo before && pnpm child && echo after',
        child: 'echo nested-ok && echo nested-fail',
      },
      (command) => (command === 'echo nested-fail' ? 1 : 0),
    );

    const result = await harness.run('parent');

    expect(result.ok).toBe(false);
    expect(result.failedScript).toBe('child');
    expect(result.failedCommand).toBe('echo nested-fail');
    expect(result.trace).toEqual(['echo before', 'echo nested-ok', 'echo nested-fail']);
  });

  it('cleans in-flight tracking when a leaf command throws', async () => {
    const harness = new ScriptPipelineHarness(
      {
        parent: 'pnpm child && echo parent-after',
        child: 'echo throws',
      },
      (command) => {
        if (command === 'echo throws') throw new Error('leaf exploded');
        return 0;
      },
    );

    const first = await harness.run('parent');
    const second = await harness.run('parent');

    expect(first).toMatchObject({
      ok: false,
      failedScript: 'child',
      failedCommand: 'echo throws',
      error: 'leaf exploded',
    });
    expect(second).toMatchObject({
      ok: false,
      failedScript: 'child',
      failedCommand: 'echo throws',
      error: 'leaf exploded',
    });
  });

  it('rejects circular and missing script references', async () => {
    const circular = new ScriptPipelineHarness({ a: 'pnpm b', b: 'pnpm a' }, () => 0);
    const missing = new ScriptPipelineHarness({ a: 'pnpm run b' }, () => 0);

    await expect(circular.run('a')).rejects.toThrow('circular script reference detected: a');
    await expect(missing.run('b')).rejects.toThrow('script not found: b');
  });
});
