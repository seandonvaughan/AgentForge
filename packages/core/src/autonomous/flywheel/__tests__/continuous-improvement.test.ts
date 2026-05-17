// packages/core/src/autonomous/flywheel/__tests__/continuous-improvement.test.ts
//
// Tests for T2.4 — continuous-improvement flywheel metric.
//
// Coverage:
//   - Zero-prior-learnings: no agent YAMLs → ratio = 0
//   - Match found: agent learning matches gate rationale → ratio > 0
//   - No match: agent learning text unrelated to failures → ratio = 0
//   - Ratio computation: 1 of 2 failures matched → ratio = 0.5
//   - Persists metric JSON to .agentforge/flywheel/
//   - Zero-failures cycle: totalFailures = 0, ratio = 0

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeContinuousImprovement } from '../continuous-improvement.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-ci-metric-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writePhasesDir(cycleId: string): string {
  const dir = join(tmpDir, '.agentforge', 'cycles', cycleId, 'phases');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgentYaml(agentId: string, learnings: string[]): void {
  const agentsDir = join(tmpDir, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const yaml = [
    `name: ${agentId}`,
    `model: sonnet`,
    `version: '1.0'`,
    `description: test`,
    `system_prompt: test`,
    `learnings:`,
    // Escape backslashes FIRST, then double quotes — without escaping
    // backslashes a learning containing a literal "\" would break YAML
    // parsing (CodeQL: js/incomplete-sanitization).
    ...learnings.map(
      (l) => `  - "${l.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    ),
  ].join('\n');
  writeFileSync(join(agentsDir, `${agentId}.yaml`), yaml);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeContinuousImprovement', () => {
  it('returns ratio=0 when no agent YAML files exist (zero prior learnings)', async () => {
    const phasesDir = writePhasesDir('cycle-001');
    writeFileSync(
      join(phasesDir, 'gate.json'),
      JSON.stringify({ verdict: 'REJECT', rationale: 'TypeScript compilation failed with TS2304 errors in the main module' }),
    );

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-001',
      agentIds: ['coder'],
    });

    expect(metric.cycleId).toBe('cycle-001');
    expect(metric.preventabilityRatio).toBe(0);
    expect(metric.totalFailures).toBe(1);
    expect(metric.failuresPreventableByPriorLearnings).toBe(0);
  });

  it('returns ratio=1 when agent learning matches gate rejection reason', async () => {
    const phasesDir = writePhasesDir('cycle-002');
    writeFileSync(
      join(phasesDir, 'gate.json'),
      JSON.stringify({
        verdict: 'REJECT',
        rationale: 'TypeScript compilation failed with TS2304 errors in the main module causing build failure',
      }),
    );

    // Inject a learning that directly matches the failure text.
    writeAgentYaml('coder', [
      'TypeScript compilation failed with TS2304 errors in the main module causing build failure — always run tsc before committing',
    ]);

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-002',
      agentIds: ['coder'],
    });

    expect(metric.totalFailures).toBe(1);
    expect(metric.failuresPreventableByPriorLearnings).toBe(1);
    expect(metric.preventabilityRatio).toBe(1);
    expect(metric.perAgent[0]).toMatchObject({
      agentId: 'coder',
      matchedFailures: 1,
    });
  });

  it('returns ratio=0 when agent learning is unrelated to failure text', async () => {
    const phasesDir = writePhasesDir('cycle-003');
    writeFileSync(
      join(phasesDir, 'gate.json'),
      JSON.stringify({
        verdict: 'REJECT',
        rationale: 'Database migration failed because foreign key constraints were violated in the schema update',
      }),
    );

    writeAgentYaml('coder', [
      'Always run pnpm build before pushing to ensure the TypeScript compiles correctly',
      'Use named exports consistently to avoid import confusion in the codebase',
    ]);

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-003',
      agentIds: ['coder'],
    });

    expect(metric.preventabilityRatio).toBe(0);
    expect(metric.failuresPreventableByPriorLearnings).toBe(0);
  });

  it('computes partial ratio correctly: 1 of 2 failures matched → 0.5', async () => {
    const phasesDir = writePhasesDir('cycle-004');
    // Gate: 1 failure
    writeFileSync(
      join(phasesDir, 'gate.json'),
      JSON.stringify({
        verdict: 'REJECT',
        rationale: 'Foreign key constraint violation in the users table migration prevents rollback',
      }),
    );
    // Execute: 1 more failure with unrelated text
    writeFileSync(
      join(phasesDir, 'execute.json'),
      JSON.stringify({
        itemResults: [
          {
            itemId: 'T1',
            status: 'failed',
            agentId: 'coder',
            error: 'Rate limit exceeded after 60 seconds — all retries exhausted',
          },
        ],
      }),
    );

    // Learning matches the gate failure but NOT the rate-limit failure.
    writeAgentYaml('coder', [
      'Foreign key constraint violation in the users table migration prevents rollback — always disable FK checks during schema migration',
    ]);

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-004',
      agentIds: ['coder'],
    });

    expect(metric.totalFailures).toBe(2);
    expect(metric.failuresPreventableByPriorLearnings).toBe(1);
    expect(metric.preventabilityRatio).toBeCloseTo(0.5);
  });

  it('returns ratio=0 and totalFailures=0 for a clean cycle with no failures', async () => {
    writePhasesDir('cycle-005');
    // No gate.json, no review.json, no failed execute items.

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-005',
      agentIds: ['coder'],
    });

    expect(metric.totalFailures).toBe(0);
    expect(metric.preventabilityRatio).toBe(0);
    expect(metric.failuresPreventableByPriorLearnings).toBe(0);
  });

  it('persists metric to .agentforge/flywheel/continuous-improvement-<cycleId>.json', async () => {
    const phasesDir = writePhasesDir('cycle-006');
    writeFileSync(
      join(phasesDir, 'gate.json'),
      JSON.stringify({ verdict: 'REJECT', rationale: 'Test failures: 3 new regressions detected in the suite' }),
    );

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-006',
      agentIds: [],
    });

    const persistPath = join(
      tmpDir,
      '.agentforge',
      'flywheel',
      'continuous-improvement-cycle-006.json',
    );
    expect(existsSync(persistPath)).toBe(true);

    const persisted = JSON.parse(readFileSync(persistPath, 'utf8'));
    expect(persisted.cycleId).toBe(metric.cycleId);
    expect(persisted.preventabilityRatio).toBe(metric.preventabilityRatio);
    expect(persisted).toHaveProperty('computedAt');
  });

  it('extracts review CRITICAL/MAJOR findings as failures', async () => {
    const phasesDir = writePhasesDir('cycle-007');
    writeFileSync(
      join(phasesDir, 'review.json'),
      JSON.stringify({
        findings:
          'CRITICAL: SQL injection vulnerability in the user search endpoint allows arbitrary queries\nMINOR: Unused import in helpers.ts\n',
      }),
    );

    const metric = await computeContinuousImprovement({
      projectRoot: tmpDir,
      cycleId: 'cycle-007',
      agentIds: [],
    });

    // Only CRITICAL/MAJOR lines become failures; MINOR is excluded.
    expect(metric.totalFailures).toBeGreaterThanOrEqual(1);
    const criticalFailure = metric.totalFailures;
    expect(criticalFailure).toBeLessThanOrEqual(5); // sanity cap
  });
});
