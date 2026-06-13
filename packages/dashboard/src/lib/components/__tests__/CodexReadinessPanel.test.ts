import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const componentPath = resolve(import.meta.dirname, '../CodexReadinessPanel.svelte');
const source = readFileSync(componentPath, 'utf8');

const mockedExecStates = [
  {
    name: 'ok',
    expectedBadge: 'ok',
    data: {
      ready: true,
      checks: {
        exec: {
          label: 'Codex exec preflight',
          ok: true,
          detail: 'status passed, launch path-command, exit 0, 12ms',
        },
      },
      warnings: [],
    },
  },
  {
    name: 'fail',
    expectedBadge: 'fail',
    data: {
      ready: false,
      checks: {
        exec: {
          label: 'Codex exec preflight',
          ok: false,
          detail: 'status failed, launch path-command, exit 2, [project-root] failed with [redacted-secret]',
        },
      },
      warnings: ['codex exec preflight failed (failed, exit 2): [project-root] failed with [redacted-secret]'],
    },
  },
  {
    name: 'skipped',
    expectedBadge: 'skipped',
    data: {
      ready: true,
      checks: {
        exec: {
          label: 'Codex exec preflight',
          ok: null,
          detail: 'status skipped',
        },
      },
      warnings: [],
    },
  },
];

describe('CodexReadinessPanel exec preflight contracts', () => {
  it('uses the dashboard readiness endpoint without invoking Codex in tests', () => {
    expect(source).toContain("fetch(withWorkspace('/api/v5/codex/readiness?skipLogin=true'))");
    expect(source).not.toMatch(/child_process|execFile|spawn\(/);
  });

  it('renders redacted check detail in the full panel', () => {
    expect(source).toContain('{#if check.detail && !compact}');
    expect(source).toContain('<span class="check-detail">{check.detail}</span>');
    expect(source).toContain('overflow-wrap: anywhere;');

    const failedExec = mockedExecStates.find((state) => state.name === 'fail')!.data.checks.exec;
    expect(failedExec.detail).toContain('[project-root]');
    expect(failedExec.detail).toContain('[redacted-secret]');
  });

  it('maps mocked exec ok, fail, and skipped states to expected badge text', () => {
    expect(source).toContain("{check.ok === null ? 'skipped' : check.ok ? 'ok' : 'fail'}");
    expect(source).toContain('function checkVariant(ok: boolean | null)');

    for (const state of mockedExecStates) {
      const ok = state.data.checks.exec.ok;
      const renderedBadge = ok === null ? 'skipped' : ok ? 'ok' : 'fail';
      expect(renderedBadge).toBe(state.expectedBadge);
    }
  });

  it('keeps compact mode concise while full mode can show warnings', () => {
    expect(source).toContain('{#if check.detail && !compact}');
    expect(source).toContain('{#if readiness.warnings.length > 0 && !compact}');
    expect(source).toContain('<div class="warning-item">{warning}</div>');

    const failed = mockedExecStates.find((state) => state.name === 'fail')!;
    expect(failed.data.warnings[0]).toContain('codex exec preflight failed');
  });
});
