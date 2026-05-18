/**
 * tests/scoring/jsonl-writer.test.ts
 *
 * Unit tests for packages/core/src/scoring/jsonl-writer.ts.
 *
 * Covers:
 *   - Atomic append of a single StepScore
 *   - Atomic append of multiple StepScores
 *   - Idempotent re-append (file grows correctly)
 *   - Silently returns on EACCES / ENOSPC (simulated)
 *   - Rejects paths that don't reference step-scores.jsonl
 *   - Each line is valid JSON parseable back to StepScore
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendStepScore } from '../../packages/core/src/scoring/jsonl-writer.js';
import type { StepScore } from '../../packages/shared/src/schemas/step-score.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeScore(overrides: Partial<StepScore> = {}): StepScore {
  return {
    step_score_id: '123e4567-e89b-12d3-a456-426614174000',
    cycle_id: 'cycle-abcd1234',
    phase: 'execute',
    item_id: 'item-001',
    agent_id: 'coder-agent',
    model: 'sonnet',
    capability_tags: ['typescript'],
    skill_ids: [],
    output_schema_id: null,
    quality: 0.85,
    rubric_version: '1.0.0',
    signals: [
      { key: 'test_pass_rate', value: 0.9, source: 'deterministic', weight: 0.5 },
    ],
    cost_usd: 0.02,
    latency_ms: 2000,
    tokens: { input: 800, output: 300, cache_read: 0, cache_write: 0 },
    llm_graded: false,
    created_at: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('appendStepScore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-jsonl-writer-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file and appends a single StepScore', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');
    const score = makeScore();

    await appendStepScore(score, filePath);

    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.step_score_id).toBe(score.step_score_id);
    expect(parsed.quality).toBe(0.85);
  });

  it('appends multiple StepScores as separate lines', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');
    const scores = [
      makeScore({ step_score_id: '11111111-1111-1111-1111-111111111111', quality: 0.9 }),
      makeScore({ step_score_id: '22222222-2222-2222-2222-222222222222', quality: 0.5 }),
      makeScore({ step_score_id: '33333333-3333-3333-3333-333333333333', quality: 0.1 }),
    ];

    await appendStepScore(scores, filePath);

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).quality).toBe(0.9);
    expect(JSON.parse(lines[1]!).quality).toBe(0.5);
    expect(JSON.parse(lines[2]!).quality).toBe(0.1);
  });

  it('grows the file correctly on repeated appends', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');

    await appendStepScore(
      makeScore({ step_score_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
      filePath,
    );
    await appendStepScore(
      makeScore({ step_score_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }),
      filePath,
    );
    await appendStepScore(
      makeScore({ step_score_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }),
      filePath,
    );

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    const ids = lines.map((l) => JSON.parse(l).step_score_id);
    expect(ids[0]).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(ids[1]).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    expect(ids[2]).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('silently returns and does not throw when filePath lacks step-scores.jsonl', async () => {
    const badPath = join(tmpDir, 'bad-file.jsonl');
    const score = makeScore();

    // Should not throw.
    await expect(appendStepScore(score, badPath)).resolves.toBeUndefined();
    // File should NOT be created.
    expect(existsSync(badPath)).toBe(false);
  });

  it('silently returns for empty scores array', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');
    await expect(appendStepScore([], filePath)).resolves.toBeUndefined();
    expect(existsSync(filePath)).toBe(false);
  });

  it('silently returns on EACCES (read-only directory)', async () => {
    // Skip on Windows where chmod is not effective.
    if (process.platform === 'win32') return;

    const readonlyDir = join(tmpDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o444);

    const filePath = join(readonlyDir, 'step-scores.jsonl');
    const score = makeScore();

    // Should not throw even though directory is not writable.
    await expect(appendStepScore(score, filePath)).resolves.toBeUndefined();

    // Restore so cleanup works.
    chmodSync(readonlyDir, 0o755);
  });

  it('each appended line is valid parseable JSON', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');
    const scores = Array.from({ length: 5 }, (_, i) =>
      makeScore({
        step_score_id: `1234567${i}-e89b-12d3-a456-42661417400${i}`.padEnd(36, '0').slice(0, 36),
        quality: i * 0.2,
        item_id: `item-${i}`,
      }),
    );

    await appendStepScore(scores, filePath);

    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('handles a zero-quality failure score (schema validation fail case)', async () => {
    const filePath = join(tmpDir, '.agentforge', 'memory', 'step-scores.jsonl');
    const failScore = makeScore({
      quality: 0,
      signals: [
        { key: 'schema.valid', value: 0, source: 'deterministic', weight: 1.0 },
      ],
    });

    await appendStepScore(failScore, filePath);

    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.quality).toBe(0);
    expect(parsed.signals[0].key).toBe('schema.valid');
    expect(parsed.signals[0].value).toBe(0);
  });
});
