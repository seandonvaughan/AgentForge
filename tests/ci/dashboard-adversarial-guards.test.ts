import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('dashboard adversarial CI guards', () => {
  it('verify:dashboard runs adversarial guard checks before build', () => {
    const pkg = JSON.parse(readRepoFile('package.json')) as {
      scripts?: Record<string, string>;
    };

    const verifyDashboard = pkg.scripts?.['verify:dashboard'] ?? '';
    expect(verifyDashboard).toContain('dashboard:check');
    expect(verifyDashboard).toContain('test:ci:dashboard-adversarial');
    expect(verifyDashboard).toContain('dashboard:build');
  });

  it('critical dashboard e2e suites do not swallow load failures or no-op navigation guards', () => {
    const files = [
      'tests/e2e/dashboard-runner.test.ts',
      'tests/e2e/dashboard-live.test.ts',
      'tests/e2e/dashboard-health.test.ts',
      'tests/e2e/dashboard-cycle-detail.test.ts',
    ];

    for (const file of files) {
      const source = readRepoFile(file);
      expect(source).not.toMatch(/catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
      expect(source).not.toMatch(/if\s*\(\s*await\s+[^)]*\.isVisible\(/);
      expect(source).not.toMatch(/\bif\s*\(\s*href\s*\)/);
    }
  });

  it('critical suites keep explicit adversarial-path assertions', () => {
    const runner = readRepoFile('tests/e2e/dashboard-runner.test.ts');
    expect(runner).toContain('status: 404');
    expect(runner).toContain('Execution API not available');

    const live = readRepoFile('tests/e2e/dashboard-live.test.ts');
    expect(live).toContain('ignores malformed stream payloads without crashing the page');
    expect(live).toContain('shows reconnecting status and banner after stream failure');

    const health = readRepoFile('tests/e2e/dashboard-health.test.ts');
    expect(health).toContain('servicesStatus: 503');
    expect(health).toContain('healthStatus: 503');
  });
});
