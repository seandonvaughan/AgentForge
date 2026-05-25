import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

const SOURCE_FILES = [
  resolve(repoRoot, 'packages/server/src/routes/v5/dashboard-stubs.ts'),
  resolve(repoRoot, 'packages/dashboard/src/routes/flywheel/+page.server.ts'),
];

function readSource(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

describe('flywheel cycle-history consistency guards', () => {
  it('pins a single HISTORY_LIMIT=20 definition in both flywheel implementations', () => {
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      const matches = source.match(/const\s+HISTORY_LIMIT\s*=\s*20\s*;/g) ?? [];
      expect(matches, `Expected exactly one HISTORY_LIMIT=20 in ${file}`).toHaveLength(1);
    }
  });

  it('uses exactly one cycleHistory slice call tied to HISTORY_LIMIT in each implementation', () => {
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      const matches = source.match(/cycles\.slice\(-HISTORY_LIMIT\)/g) ?? [];
      expect(matches, `Expected a single cycles.slice(-HISTORY_LIMIT) in ${file}`).toHaveLength(1);
      expect(source).not.toContain('slice(-100)');
    }
  });

  it('uses epoch fallback for cycleHistory startedAt in both implementations', () => {
    for (const file of SOURCE_FILES) {
      const source = readSource(file);
      expect(source).toContain("startedAt: c.startedAt ?? '1970-01-01T00:00:00.000Z'");
    }
  });
});
