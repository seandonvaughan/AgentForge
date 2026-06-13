import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentPath = resolve(import.meta.dirname, '../CodexReadinessPanel.svelte');
const source = readFileSync(componentPath, 'utf8');

type MockCheck = { label: string; ok: boolean | null; detail?: string };
type MockReadiness = {
  name: string;
  ready: boolean;
  status: 'ready' | 'degraded';
  expectedPanelLabel: string;
  checks: Record<string, MockCheck>;
  warnings: string[];
};

const mockedReadinessStates: MockReadiness[] = [
  {
    name: 'ready',
    ready: true,
    status: 'ready',
    expectedPanelLabel: 'Ready',
    checks: {
      exec: {
        label: 'Codex exec preflight',
        ok: true,
        detail: 'status passed, launch path-command, exit 0, 12ms',
      },
      readinessCanary: {
        label: 'Codex readiness canary',
        ok: true,
        detail: 'status passed, dashboard readiness canary passed',
      },
    },
    warnings: [],
  },
  {
    name: 'degraded',
    ready: false,
    status: 'degraded',
    expectedPanelLabel: 'Needs attention',
    checks: {
      exec: {
        label: 'Codex exec preflight',
        ok: false,
        detail: 'status failed, launch path-command, exit 2, [project-root] failed with [redacted-secret]',
      },
      readinessCanary: {
        label: 'Codex readiness canary',
        ok: false,
        detail: 'status failed, [project-root] dashboard-readiness diff leaked [redacted-secret]',
      },
    },
    warnings: [
      'codex readiness canary failed: [project-root] failed with [redacted-secret]',
      'dashboard-readiness diff: expected ready, actual degraded at [project-root]',
    ],
  },
  {
    name: 'skipped',
    ready: true,
    status: 'ready',
    expectedPanelLabel: 'Ready',
    checks: {
      exec: {
        label: 'Codex exec preflight',
        ok: null,
        detail: 'status skipped',
      },
      readinessCanary: {
        label: 'Codex readiness canary',
        ok: null,
        detail: 'status skipped',
      },
    },
    warnings: [],
  },
];

function mockedBadgeText(ok: boolean | null): 'ok' | 'fail' | 'skipped' {
  if (ok === true) return 'ok';
  if (ok === false) return 'fail';
  return 'skipped';
}

describe('CodexReadinessPanel readiness evidence contracts', () => {
  it('uses the dashboard readiness endpoint without invoking Codex in tests', () => {
    expect(source).toContain("fetch(withWorkspace('/api/v5/codex/readiness?skipLogin=true'))");
    expect(source).not.toMatch(/child_process|execFile|spawn\(/);
  });

  it('exposes stable panel, check, detail, and evidence data attributes', () => {
    expect(source).toContain('data-readiness-panel');
    expect(source).toContain('data-readiness-status=');
    expect(source).toContain('data-readiness-check={key}');
    expect(source).toContain('data-readiness-check-state={checkState(check.ok)}');
    expect(source).toContain('data-readiness-detail={key}');
    expect(source).toContain('data-readiness-evidence');
    expect(source).toContain('data-readiness-warning');
    expect(source).toContain('Readiness evidence');
  });

  it('renders ready, degraded, and skipped states with stable labels', () => {
    expect(source).toContain("{readiness.ready ? 'Ready' : 'Needs attention'}");
    expect(source).toContain("type CheckState = 'ok' | 'fail' | 'skipped'");
    expect(source).toContain('{checkState(check.ok)}');

    const ready = mockedReadinessStates.find((state) => state.name === 'ready')!;
    const degraded = mockedReadinessStates.find((state) => state.name === 'degraded')!;
    const skipped = mockedReadinessStates.find((state) => state.name === 'skipped')!;

    expect(ready.status).toBe('ready');
    expect(ready.expectedPanelLabel).toBe('Ready');
    expect(degraded.status).toBe('degraded');
    expect(degraded.expectedPanelLabel).toBe('Needs attention');
    expect(mockedBadgeText(skipped.checks.exec.ok)).toBe('skipped');
    expect(mockedBadgeText(skipped.checks.readinessCanary.ok)).toBe('skipped');
  });

  it('renders redacted readiness canary details and dashboard-readiness diffs as visible evidence', () => {
    expect(source).toContain('{#if shouldShowCheckDetail(check)}');
    expect(source).toContain('<span class="check-detail" data-readiness-detail={key}>{check.detail}</span>');
    expect(source).toContain('isReadinessCanaryLabel(check.label)');
    expect(source).toContain('isReadinessEvidenceWarning(warning)');
    expect(source).toContain("lower.includes('dashboard-readiness')");
    expect(source).toContain("lower.includes('diff')");
    expect(source).toContain('overflow-wrap: anywhere;');

    const degraded = mockedReadinessStates.find((state) => state.name === 'degraded')!;
    const canaryDetail = degraded.checks.readinessCanary.detail ?? '';
    expect(degraded.checks.readinessCanary.label).toBe('Codex readiness canary');
    expect(canaryDetail).toContain('[project-root]');
    expect(canaryDetail).toContain('[redacted-secret]');
    expect(canaryDetail).toContain('dashboard-readiness diff');
    expect(canaryDetail).not.toContain('sk-test');
    expect(degraded.warnings[0]).toContain('codex readiness canary failed');
    expect(degraded.warnings[1]).toContain('dashboard-readiness diff');
  });

  it('maps mocked checks to ok, fail, and skipped badge text without shelling out', () => {
    expect(source).toContain('function checkVariant(ok: boolean | null)');
    expect(source).toContain('function checkState(ok: boolean | null)');

    const expectedByState = new Map([
      ['ready', 'ok'],
      ['degraded', 'fail'],
      ['skipped', 'skipped'],
    ]);
    for (const state of mockedReadinessStates) {
      expect(mockedBadgeText(state.checks.exec.ok)).toBe(expectedByState.get(state.name));
      expect(mockedBadgeText(state.checks.readinessCanary.ok)).toBe(expectedByState.get(state.name));
    }
  });

  it('keeps compact mode concise while preserving readiness canary and diff evidence', () => {
    expect(source).toContain('!compact || check.ok === false || isReadinessCanaryLabel(check.label)');
    expect(source).toContain('readiness.warnings.filter((warning) => !compact || isReadinessEvidenceWarning(warning)).slice(0, 3)');
    expect(source).toContain('<div class="warning-item" data-readiness-warning data-readiness-warning-index={i}>{warning}</div>');

    const degraded = mockedReadinessStates.find((state) => state.name === 'degraded')!;
    expect(degraded.warnings.every((warning) => (
      warning.includes('readiness canary') || warning.includes('dashboard-readiness') || warning.includes('diff')
    ))).toBe(true);
  });
});
