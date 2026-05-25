import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageScripts = Record<string, string>;

function loadScripts(): PackageScripts {
  const pkg = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ) as { scripts?: PackageScripts };
  return pkg.scripts ?? {};
}

describe('adversarial regression gate wiring', () => {
  it('verify:product runs unit tests before dashboard e2e tests', () => {
    const scripts = loadScripts();
    const verifyProduct = scripts['verify:product'];

    expect(verifyProduct).toBeTruthy();
    expect(verifyProduct).toContain('pnpm test:run');
    expect(verifyProduct).toContain('pnpm test:e2e:dashboard');
    expect(verifyProduct.indexOf('pnpm test:run')).toBeLessThan(
      verifyProduct.indexOf('pnpm test:e2e:dashboard'),
    );
  });

  it('test:run remains an unfiltered vitest gate', () => {
    const scripts = loadScripts();
    expect(scripts['test:run']).toBe('vitest run');
  });

  it('dashboard e2e gate includes runner, live, and health adversarial surfaces', () => {
    const scripts = loadScripts();
    const dashboardGate = scripts['test:e2e:dashboard'] ?? '';

    expect(dashboardGate).toContain('tests/e2e/dashboard-runner.test.ts');
    expect(dashboardGate).toContain('tests/e2e/dashboard-live.test.ts');
    expect(dashboardGate).toContain('tests/e2e/dashboard-health.test.ts');
  });

  it('vitest include/exclude patterns keep v5 adversarial tests in scope', () => {
    const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');

    expect(config).toContain("include: ['tests/**/*.test.ts'");
    expect(config).toContain("exclude: ['tests/e2e/**/*.test.ts'");
    expect(config).not.toContain('tests/v5/**/*.test.ts');
    expect(config).not.toContain('tests/v5/adversarial.test.ts');
  });
});
