import { describe, expect, it } from 'vitest';
import {
  classifyChangedFiles,
  evaluateGatekeeperPolicy,
  identifyReadinessClaims,
  isVerifierDiscoverableTestPath,
} from '../gatekeeper.js';

describe('gatekeeper policy', () => {
  it('returns an actionable finding for package source-only changes', () => {
    const result = evaluateGatekeeperPolicy({
      itemText: 'Create package readiness policy for the autonomous package.',
      changedFiles: ['packages/core/src/autonomous/gatekeeper.ts'],
    });

    expect(result.ok).toBe(false);
    expect(result.claims.package).toBe(true);
    expect(result.classification.packageFiles).toEqual(['packages/core/src/autonomous/gatekeeper.ts']);
    expect(result.findings).toEqual([
      {
        code: 'missing-verifier-test',
        severity: 'failure',
        message:
          'Package or dashboard changes must include at least one verifier-discoverable test file (*.test.* or *.spec.*) before the child can be accepted.',
        affectedFiles: ['packages/core/src/autonomous/gatekeeper.ts'],
      },
    ]);
  });

  it('accepts package changes when a verifier-discoverable test changed', () => {
    const result = evaluateGatekeeperPolicy({
      itemText: 'Create package readiness policy for the autonomous package.',
      changedFiles: [
        'packages/core/src/autonomous/gatekeeper.ts',
        'packages/core/src/autonomous/__tests__/gatekeeper.test.ts',
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.classification.verifierDiscoverableTests).toEqual([
      'packages/core/src/autonomous/__tests__/gatekeeper.test.ts',
    ]);
  });

  it('classifies dashboard UI readiness claims and requires verifier-discoverable tests', () => {
    const result = evaluateGatekeeperPolicy({
      itemText: 'Make the dashboard cycle page UI readiness state visible.',
      changedFiles: ['packages/dashboard/src/routes/cycles/+page.svelte'],
    });

    expect(result.ok).toBe(false);
    expect(result.claims).toEqual({ package: false, dashboard: true, ui: true });
    expect(result.classification.dashboardFiles).toEqual(['packages/dashboard/src/routes/cycles/+page.svelte']);
    expect(result.classification.uiFiles).toEqual(['packages/dashboard/src/routes/cycles/+page.svelte']);
    expect(result.findings[0]?.affectedFiles).toEqual(['packages/dashboard/src/routes/cycles/+page.svelte']);
  });

  it('does not infer readiness claims or test requirements for unrelated changes', () => {
    const result = evaluateGatekeeperPolicy({
      itemText: 'Refresh the operator notes.',
      changedFiles: ['docs/operator-notes.md'],
    });

    expect(result.ok).toBe(true);
    expect(result.claims).toEqual({ package: false, dashboard: false, ui: false });
    expect(result.classification.files[0]).toEqual({
      path: 'docs/operator-notes.md',
      surfaces: ['other'],
      isVerifierDiscoverableTest: false,
    });
    expect(result.findings).toEqual([]);
  });
});

describe('gatekeeper helpers', () => {
  it('normalizes changed files before classification', () => {
    expect(classifyChangedFiles(['.\\packages\\core\\src\\foo.spec.ts']).verifierDiscoverableTests).toEqual([
      'packages/core/src/foo.spec.ts',
    ]);
  });

  it('recognizes only verifier-discoverable test file names', () => {
    expect(isVerifierDiscoverableTestPath('packages/core/src/foo.test.ts')).toBe(true);
    expect(isVerifierDiscoverableTestPath('packages/core/src/test-helper.ts')).toBe(false);
  });

  it('identifies readiness claims without changed files', () => {
    expect(identifyReadinessClaims('Update the package dashboard UI readiness contract.')).toEqual({
      package: true,
      dashboard: true,
      ui: true,
    });
  });
});
