import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const specPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '2026-06-12-codex-gatekeeper-canary-v1.md',
);
const spec = readFileSync(specPath, 'utf8');

describe('Codex gatekeeper canary v1 spec', () => {
  it('names the current readiness consumers and mocked unit-test seams', () => {
    expect(spec).toContain('packages/core/src/runtime/codex-readiness.ts');
    expect(spec).toContain('packages/server/src/routes/v5/codex-readiness.ts');
    expect(spec).toContain('packages/server/src/routes/v5/index.ts');
    expect(spec).toContain('packages/server/src/server.ts');
    expect(spec).toContain('packages/dashboard/src/lib/components/CodexReadinessPanel.svelte');
    expect(spec).toContain('packages/dashboard/src/routes/health/+page.svelte');
    expect(spec).toContain('packages/dashboard/src/routes/runner/+page.svelte');
    expect(spec).toContain('packages/dashboard/src/routes/settings/forge/+page.svelte');
    expect(spec).toContain('packages/dashboard/src/routes/cycles/new/+page.svelte');
    expect(spec).toContain('Unit tests must use injected readiness builders/probes rather than real Codex.');
    expect(spec).toContain('runCodexExecProbe');
    expect(spec).toContain('readinessReportBuilder');
  });

  it('keeps the nonblocking hardening path separate from future service work', () => {
    expect(spec).toContain('v1 is a report contract and canary contract only');
    expect(spec).toContain('Nonblocking Service-Hardening Milestones');
    expect(spec).toContain('Rollout Gates');
    expect(spec).toContain('Future Readiness Service Work');
    expect(spec).toContain('must not block this epic');
    expect(spec).toContain('non-open readiness states');
  });
});
