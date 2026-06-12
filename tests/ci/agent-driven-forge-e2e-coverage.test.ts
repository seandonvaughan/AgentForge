/**
 * tests/ci/agent-driven-forge-e2e-coverage.test.ts
 *
 * Static-analysis tests that verify the CI workflow correctly wires the
 * agent-driven forge e2e integration test into the pipeline.
 *
 * These tests:
 *   1. Confirm that the vitest include pattern would pick up the e2e test file.
 *   2. Confirm that the Test job runs vitest (not a filtered subset that
 *      excludes tests/integration/).
 *   3. Confirm that the "Forge Pipeline Stats" summary job exists in ci.yml.
 *   4. Confirm that the ci-verify-forge-e2e-ran.mjs assertion script exists
 *      and is referenced inside the Test job.
 *   5. Confirm the ci.yml parses as valid YAML.
 *
 * No network calls. No file mutations. Read-only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../');

// ── helpers ──────────────────────────────────────────────────────────────────

function readRepo(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

function loadCiYaml(): Record<string, unknown> {
  const raw = readRepo('.github/workflows/ci.yml');
  return yaml.load(raw) as Record<string, unknown>;
}

function loadWorkflowYaml(rel: string): Record<string, unknown> {
  const raw = readRepo(rel);
  return yaml.load(raw) as Record<string, unknown>;
}

function expectPlaywrightInstallBeforeVerifyGates(workflowRel: string, jobName: string): void {
  const workflow = loadWorkflowYaml(workflowRel);
  const jobs = workflow['jobs'] as Record<string, unknown>;
  const job = jobs[jobName] as { steps?: Array<Record<string, unknown>> } | undefined;
  expect(job).toBeDefined();
  const steps = job?.steps ?? [];
  const installIndex = steps.findIndex((step) => step['run'] === 'pnpm exec playwright install --with-deps chromium');
  const verifyIndex = steps.findIndex((step) => step['run'] === 'pnpm verify:gates');
  expect(installIndex, `${workflowRel} ${jobName} must install Playwright browsers`).toBeGreaterThanOrEqual(0);
  expect(verifyIndex, `${workflowRel} ${jobName} must run verify:gates`).toBeGreaterThanOrEqual(0);
  expect(installIndex, `${workflowRel} ${jobName} installs Playwright before verify:gates`).toBeLessThan(verifyIndex);
}

// ── Test 1: the e2e test file exists and is in the right location ────────────

describe('agent-driven-forge-e2e file presence', () => {
  it('the integration test file exists at the expected path', () => {
    const testPath = resolve(
      repoRoot,
      'tests/integration/agent-driven-forge-e2e.test.ts'
    );
    expect(existsSync(testPath)).toBe(true);
  });
});

// ── Test 2: vitest include pattern covers the integration test ───────────────

describe('vitest config coverage', () => {
  it('vitest.config.ts include patterns cover tests/integration/', () => {
    const vitestConfig = readRepo('vitest.config.ts');

    // The include array must contain a glob that matches tests/**/*.test.ts
    // (which is how vitest.config.ts is currently authored).
    expect(vitestConfig).toContain("'tests/**/*.test.ts'");
    // Child verification can directly invoke changed .test.mjs files, so the
    // root Vitest config must collect those too.
    expect(vitestConfig).toContain("'tests/**/*.test.mjs'");
  });

  it('vitest.config.ts exclude patterns do NOT exclude tests/integration/', () => {
    const vitestConfig = readRepo('vitest.config.ts');

    // The only excluded subtree should be tests/e2e — integration/ must not
    // appear in the exclude list.
    const excludeBlockMatch = vitestConfig.match(/exclude\s*:\s*\[([^\]]*)\]/s);
    if (excludeBlockMatch) {
      expect(excludeBlockMatch[1]).not.toContain('tests/integration');
    }
    // If no exclude block, that is also fine.
  });
});

// ── Test 3: ci.yml is valid YAML ─────────────────────────────────────────────

describe('ci.yml YAML validity', () => {
  it('ci.yml parses as valid YAML without throwing', () => {
    expect(() => loadCiYaml()).not.toThrow();
  });

  it('ci.yml parsed object has a jobs key at the top level', () => {
    const ci = loadCiYaml();
    expect(ci).toHaveProperty('jobs');
    expect(typeof ci['jobs']).toBe('object');
  });
});

// ── Test 4: forge-pipeline-stats job is present ──────────────────────────────

describe('Forge Pipeline Stats job', () => {
  it('ci.yml contains a "forge-pipeline-stats" job', () => {
    const ci = loadCiYaml();
    const jobs = ci['jobs'] as Record<string, unknown>;
    expect(jobs).toHaveProperty('forge-pipeline-stats');
  });

  it('forge-pipeline-stats job runs after the test job via needs', () => {
    const ci = loadCiYaml();
    const jobs = ci['jobs'] as Record<string, unknown>;
    const statsJob = jobs['forge-pipeline-stats'] as Record<string, unknown> | undefined;
    expect(statsJob).toBeDefined();

    const needs = statsJob!['needs'];
    // needs may be a string or an array
    if (Array.isArray(needs)) {
      expect(needs).toContain('test');
    } else {
      expect(needs).toBe('test');
    }
  });

  it('forge-pipeline-stats job writes to GITHUB_STEP_SUMMARY', () => {
    const raw = readRepo('.github/workflows/ci.yml');
    // The summary job must reference $GITHUB_STEP_SUMMARY
    expect(raw).toContain('GITHUB_STEP_SUMMARY');
  });

  it('forge-pipeline-stats job downloads the test-results artifact', () => {
    const raw = readRepo('.github/workflows/ci.yml');
    // Must use actions/download-artifact to get the JUnit XML
    expect(raw).toContain('download-artifact');
  });
});

// ── Test 5: assertion script is wired into the Test job ──────────────────────

describe('ci-verify-forge-e2e-ran.mjs wiring', () => {
  it('the assertion script file exists at scripts/ci-verify-forge-e2e-ran.mjs', () => {
    const scriptPath = resolve(repoRoot, 'scripts/ci-verify-forge-e2e-ran.mjs');
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('ci.yml references ci-verify-forge-e2e-ran.mjs in the workflow', () => {
    const raw = readRepo('.github/workflows/ci.yml');
    expect(raw).toContain('ci-verify-forge-e2e-ran.mjs');
  });

  it('the assertion script reads the JUnit XML path from argv or a default', () => {
    const script = readRepo('scripts/ci-verify-forge-e2e-ran.mjs');
    // It must reference process.argv to accept an override path
    expect(script).toContain('process.argv');
    // And it must reference junit.xml as the default artifact location
    expect(script).toContain('junit.xml');
  });
});

describe('Playwright browser install ordering', () => {
  it('ci release-gates installs Playwright before verify:gates', () => {
    expectPlaywrightInstallBeforeVerifyGates('.github/workflows/ci.yml', 'release-gates');
  });

  it('release test suite installs Playwright before verify:gates', () => {
    expectPlaywrightInstallBeforeVerifyGates('.github/workflows/release.yml', 'test');
  });
});
