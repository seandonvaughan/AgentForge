import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package scripts', () => {
  function readScripts() {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    return pkg.scripts ?? {};
  }

  it('keeps verify:product type-safe before product tests run', () => {
    const scripts = readScripts();
    const verifyProduct = scripts['verify:product'] ?? '';
    expect(verifyProduct).toContain('check:types');
    expect(verifyProduct).toContain('test:run');
    expect(verifyProduct).toContain('test:e2e:dashboard');
    expect(verifyProduct.indexOf('check:types')).toBeLessThan(
      verifyProduct.indexOf('test:run'),
    );
    expect(verifyProduct.indexOf('test:run')).toBeLessThan(
      verifyProduct.indexOf('test:e2e:dashboard'),
    );
  });

  it('keeps verify:dashboard compile-safe before dashboard build', () => {
    const scripts = readScripts();
    const verifyDashboard = scripts['verify:dashboard'] ?? '';

    expect(verifyDashboard).toContain('dashboard:check');
    expect(verifyDashboard).toContain('dashboard:build');
    expect(verifyDashboard.indexOf('dashboard:check')).toBeLessThan(
      verifyDashboard.indexOf('dashboard:build'),
    );
  });

  it('keeps verify:gates wired to dashboard verification', () => {
    const scripts = readScripts();
    const verifyGates = scripts['verify:gates'] ?? '';

    expect(verifyGates).toContain('lint');
    expect(verifyGates).toContain('build');
    expect(verifyGates).toContain('verify:dashboard');
    expect(verifyGates.indexOf('build')).toBeLessThan(
      verifyGates.indexOf('verify:dashboard'),
    );
  });

  it('verify scripts never bypass hooks with --no-verify', () => {
    const scripts = readScripts();
    for (const [name, script] of Object.entries(scripts)) {
      if (!name.startsWith('verify:')) continue;
      expect(script).not.toContain('--no-verify');
    }
  });
});
