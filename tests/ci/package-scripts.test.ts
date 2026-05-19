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

  it('keeps verify:dashboard wired to adversarial dashboard guards', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    const verifyDashboard = pkg.scripts?.['verify:dashboard'] ?? '';
    expect(verifyDashboard).toContain('dashboard:check');
    expect(verifyDashboard).toContain('test:ci:dashboard-adversarial');
    expect(verifyDashboard).toContain('dashboard:build');
    expect(verifyDashboard.indexOf('dashboard:check')).toBeLessThan(
      verifyDashboard.indexOf('test:ci:dashboard-adversarial'),
    );
    expect(verifyDashboard.indexOf('test:ci:dashboard-adversarial')).toBeLessThan(
      verifyDashboard.indexOf('dashboard:build'),
    );
  });
});
