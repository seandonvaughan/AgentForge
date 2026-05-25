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

  it('runs the build-mode typecheck before unit tests in verify:product', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, () => 0);

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(true);
    expect(result.trace.indexOf('tsc -b')).toBeGreaterThanOrEqual(0);
    expect(result.trace.indexOf('vitest run')).toBeGreaterThanOrEqual(0);
    expect(result.trace.indexOf('tsc -b')).toBeLessThan(
      result.trace.indexOf('vitest run'),
    );
  });

  it('keeps verify:product on the reduced dashboard e2e selector', () => {
    const scripts = loadRootScripts();
    const verifyProduct = scripts['verify:product'];

    expect(verifyProduct).toContain('pnpm test:e2e:dashboard');
    expect(verifyProduct).not.toContain('test:e2e:dashboard:full');
    expect(verifyProduct).not.toContain('dashboard-agents.test.ts');
  });

  it('stops verify:gates before dashboard checks when verify:product typecheck fails', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, (command) => {
      return command === 'tsc -b' ? 1 : 0;
    });

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(false);
    expect(result.failedScript).toBe('check:types');
    expect(result.failedCommand).toBe('tsc -b');
    const lintCommand = result.trace.find((command) => command.startsWith('eslint '));
    expect(lintCommand).toBeDefined();
    expect(lintCommand).toContain('"src/**/*.{js,mjs,cjs,ts,tsx}"');
    expect(lintCommand).toContain('"packages/**/*.{js,mjs,cjs,ts,tsx,svelte}"');
    expect(lintCommand).toContain('"tests/**/*.{js,mjs,cjs,ts,tsx}"');
    expect(lintCommand).toContain('--max-warnings=0');
    expect(result.trace).toContain('node scripts/check-version-sync.mjs');
    expect(result.trace).not.toContain('pnpm --filter @agentforge/dashboard check');
    expect(result.trace).not.toContain('node scripts/check-help-output.mjs');
  });

  it('runs verify:product before verify:dashboard in verify:gates', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, () => 0);

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(true);
    expect(result.trace).toContain('vitest run');
    expect(
      result.trace.some((command) =>
        command.startsWith('playwright test tests/e2e/dashboard-agents.test.ts'),
      ),
    ).toBe(true);
    expect(result.trace).toContain('pnpm --filter @agentforge/dashboard check');
    expect(result.trace.indexOf('vitest run')).toBeLessThan(
      result.trace.indexOf('pnpm --filter @agentforge/dashboard check'),
    );
  });

  it('runs typecheck exactly once during verify:gates', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, () => 0);

    const result = await harness.run('verify:gates');

    expect(result.ok).toBe(true);
    const typecheckRuns = result.trace.filter((command) => command === 'tsc -b');
    expect(typecheckRuns).toHaveLength(1);
  });

  it('stops verify:product before dashboard e2e when unit tests fail', async () => {
    const scripts = loadRootScripts();
    const harness = new ScriptPipelineHarness(scripts, (command) => {
      return command === 'vitest run' ? 1 : 0;
    });

    const result = await harness.run('verify:product');

    expect(result.ok).toBe(false);
    expect(result.failedScript).toBe('test:run');
    expect(result.failedCommand).toBe('vitest run');
    expect(result.trace).toContain('tsc -b');
    expect(result.trace).toContain('vitest run');
    expect(result.trace.some((command) => command.startsWith('playwright test'))).toBe(
      false,
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

  it('preserves Windows-style backslashes in leaf commands and trace output', async () => {
    const observed: string[] = [];
    const harness = new ScriptPipelineHarness(
      {
        parent: 'echo C:\\repo\\pkg && pnpm run child',
        child: 'pnpm exec tsx C:\\repo\\scripts\\smoke.ts',
      },
      (command) => {
        observed.push(command);
        return 0;
      },
    );

    const result = await harness.run('parent');

    expect(result.ok).toBe(true);
    expect(result.trace).toEqual([
      'echo C:\\repo\\pkg',
      'pnpm exec tsx C:\\repo\\scripts\\smoke.ts',
    ]);
    expect(observed).toEqual(result.trace);
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

  it('cleans in-flight tracking when a leaf command rejects asynchronously', async () => {
    const harness = new ScriptPipelineHarness(
      {
        parent: 'pnpm child && echo parent-after',
        child: 'echo rejects',
      },
      async (command) => {
        if (command === 'echo rejects') {
          throw new Error('leaf rejected');
        }
        return 0;
      },
    );

    const first = await harness.run('parent');
    const second = await harness.run('parent');

    expect(first).toMatchObject({
      ok: false,
      failedScript: 'child',
      failedCommand: 'echo rejects',
      error: 'leaf rejected',
    });
    expect(second).toMatchObject({
      ok: false,
      failedScript: 'child',
      failedCommand: 'echo rejects',
      error: 'leaf rejected',
    });
  });

  it('does not split command chains on && inside quoted leaf commands', async () => {
    const observed: string[] = [];
    const harness = new ScriptPipelineHarness(
      {
        parent: 'echo "alpha && beta" && pnpm run child',
        child: "echo 'gamma && delta'",
      },
      (command) => {
        observed.push(command);
        return 0;
      },
    );

    const result = await harness.run('parent');

    expect(result.ok).toBe(true);
    expect(result.trace).toEqual(['echo "alpha && beta"', "echo 'gamma && delta'"]);
    expect(observed).toEqual(result.trace);
  });

  it('rejects circular and missing script references', async () => {
    const circular = new ScriptPipelineHarness({ a: 'pnpm b', b: 'pnpm a' }, () => 0);
    const missing = new ScriptPipelineHarness({ a: 'pnpm run b' }, () => 0);

    await expect(circular.run('a')).rejects.toThrow('circular script reference detected: a');
    await expect(missing.run('b')).rejects.toThrow('script not found: b');
  });
});
