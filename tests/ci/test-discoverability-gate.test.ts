import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

const APPROVED_VERIFY_SCRIPT = 'scripts/run-verify-tests.mjs';
const VERIFY_PLANNER = 'scripts/verify-test-planner.mjs';
const DASHBOARD_READINESS_SPECS = [
  'packages/dashboard/src/lib/components/__tests__/CodexReadinessPanel.test.ts',
  'packages/server/src/routes/v5/__tests__/codex-readiness.test.ts',
] as const;
const DASHBOARD_E2E_SPECS = [
  'tests/e2e/dashboard-agents.test.ts',
  'tests/e2e/dashboard-runner.test.ts',
  'tests/e2e/dashboard-live.test.ts',
  'tests/e2e/dashboard-health.test.ts',
  'tests/e2e/dashboard-org.test.ts',
  'tests/e2e/dashboard-cycle-launch.test.ts',
  'tests/e2e/dashboard-cycle-detail.test.ts',
] as const;

function repoPath(path: string): string {
  return resolve(ROOT, path);
}

function readRequiredFile(path: string, remediation: string): string {
  if (!existsSync(repoPath(path))) {
    throw new Error(`Missing required CI-discoverability file: ${path}. ${remediation}`);
  }
  return readFileSync(repoPath(path), 'utf8');
}

function requireText(source: string, path: string, expected: string, remediation: string): void {
  if (!source.includes(expected)) {
    throw new Error(
      `Missing required CI-discoverability marker in ${path}: ${expected}. ${remediation}`,
    );
  }
}

function loadRootScripts(): Record<string, string> {
  const packageJson = JSON.parse(
    readRequiredFile(
      'package.json',
      'Restore package.json so verify:product can be checked by the static CI guard.',
    ),
  ) as { scripts?: unknown };

  if (!packageJson.scripts || typeof packageJson.scripts !== 'object') {
    throw new Error('package.json must define scripts so verify:product cannot drop tests silently.');
  }

  return packageJson.scripts as Record<string, string>;
}

function assertScriptEquals(
  scripts: Record<string, string>,
  name: string,
  expected: string,
  remediation: string,
): void {
  if (scripts[name] !== expected) {
    throw new Error(
      `package.json script "${name}" must be "${expected}" so product verification keeps test discoverability. ${remediation}`,
    );
  }
}

describe('test discoverability CI gate', () => {
  it('keeps verify:product on the named Gatekeeper/Canary verifier path', () => {
    const scripts = loadRootScripts();

    assertScriptEquals(
      scripts,
      'test:run',
      'vitest run',
      'Do not narrow test:run; this guard is discovered only by the full Vitest suite.',
    );
    assertScriptEquals(
      scripts,
      'verify:gatekeeper-canary',
      'node scripts/run-pnpm.mjs -- test:run && node scripts/run-pnpm.mjs -- test:e2e:dashboard:canary',
      'Restore the named Gatekeeper/Canary verifier before changing product verification.',
    );
    assertScriptEquals(
      scripts,
      'test:e2e:dashboard:canary',
      `playwright test --workers=1 ${DASHBOARD_E2E_SPECS.join(' ')}`,
      'Keep the release dashboard canary serialized while preserving the full approved selector.',
    );
    assertScriptEquals(
      scripts,
      'verify:product',
      'node scripts/run-pnpm.mjs -- check:types && node scripts/run-pnpm.mjs -- verify:gatekeeper-canary',
      'Restore the check:types -> verify:gatekeeper-canary chain before changing product verification.',
    );
  });

  it('keeps the approved autonomous verifier script and planner inventory checks discoverable', () => {
    const runner = readRequiredFile(
      APPROVED_VERIFY_SCRIPT,
      'Restore the approved VERIFY entrypoint referenced by .agentforge/autonomous.yaml testing.command.',
    );
    const planner = readRequiredFile(
      VERIFY_PLANNER,
      'Restore the VERIFY planner that classifies affected package/dashboard tests.',
    );

    requireText(
      runner,
      APPROVED_VERIFY_SCRIPT,
      "from './verify-test-planner.mjs'",
      'The runner must keep delegating test-file classification to the shared planner.',
    );
    requireText(
      runner,
      APPROVED_VERIFY_SCRIPT,
      'function collectTestInventory()',
      'The runner must inventory package/dashboard tests before running an affected gate.',
    );
    requireText(
      runner,
      APPROVED_VERIFY_SCRIPT,
      "file.startsWith('packages/') && isTestFile(file)",
      'Package and dashboard tests under packages/* must remain eligible for inventory collection.',
    );
    requireText(
      runner,
      APPROVED_VERIFY_SCRIPT,
      '[verify-gate] uncollected package/dashboard tests detected',
      'Keep the failure actionable when affected selection misses a colocated test.',
    );

    requireText(
      planner,
      VERIFY_PLANNER,
      'export function findUncollectedTests',
      'Keep the pure planner coverage for package/dashboard test discoverability.',
    );
    requireText(
      planner,
      VERIFY_PLANNER,
      "return file.startsWith('packages/');",
      'The planner must continue treating packages/dashboard paths as inventory-protected.',
    );
    requireText(
      planner,
      VERIFY_PLANNER,
      'export function formatUncollectedTestsError',
      'The planner must keep an actionable formatter for missed test inventory entries.',
    );
  });

  it('keeps dashboard readiness specs present and inside the discoverable test inventory', () => {
    const runner = readRequiredFile(
      APPROVED_VERIFY_SCRIPT,
      'Restore the approved VERIFY entrypoint before changing readiness coverage.',
    );

    for (const specPath of DASHBOARD_READINESS_SPECS) {
      const source = readRequiredFile(
        specPath,
        `Restore ${specPath} or update this guard with the replacement readiness spec before removing it.`,
      );

      expect(specPath.startsWith('packages/')).toBe(true);
      expect(specPath.endsWith('.test.ts') || specPath.endsWith('.spec.ts')).toBe(true);
      requireText(
        source,
        specPath,
        '/api/v5/codex/readiness',
        'Dashboard readiness coverage must continue to exercise the readiness endpoint contract.',
      );
    }

    requireText(
      runner,
      APPROVED_VERIFY_SCRIPT,
      "SKIPPED_INVENTORY_DIRS",
      'Keep inventory walking explicit so dashboard readiness specs cannot disappear behind ignored directories.',
    );
    for (const skippedDir of ['node_modules', 'dist', '.svelte-kit']) {
      requireText(
        runner,
        APPROVED_VERIFY_SCRIPT,
        `'${skippedDir}'`,
        `The inventory walker should skip generated ${skippedDir} content, not package/dashboard specs.`,
      );
    }
  });
});
