import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package scripts', () => {
  it('keeps verify:product type-safe before product tests run', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const verifyProduct = pkg.scripts?.['verify:product'] ?? '';
    expect(verifyProduct).toContain('check:types');
    expect(verifyProduct.indexOf('check:types')).toBeLessThan(
      verifyProduct.indexOf('test:run'),
    );
  });

  it('keeps a dedicated dashboard adversarial e2e command wired into verify:dashboard', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const adversarial = pkg.scripts?.['test:e2e:dashboard:adversarial'] ?? '';
    expect(adversarial).toContain('dashboard-runner.test.ts');
    expect(adversarial).toContain('dashboard-live.test.ts');
    expect(adversarial).toContain('dashboard-health.test.ts');

    const verifyDashboard = pkg.scripts?.['verify:dashboard'] ?? '';
    expect(verifyDashboard).toContain('dashboard:check');
    expect(verifyDashboard).toContain('dashboard:build');
    expect(verifyDashboard).toContain('test:e2e:dashboard:adversarial');
  });
});
