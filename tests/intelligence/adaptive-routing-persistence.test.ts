import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdaptiveRouter } from '../../packages/core/src/intelligence/adaptive-routing.js';

function makeTmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routing-feedback-'));
  return join(dir, 'routing-feedback.jsonl');
}

describe('AdaptiveRouter JSONL persistence', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = makeTmpFile();
  });

  it('appends one JSONL line per recordOutcome call', () => {
    const router = new AdaptiveRouter({ feedbackFilePath: filePath });
    router.recordOutcome('fastify-v5-engineer', 'sonnet', true, 12500, 0.84);
    router.recordOutcome('db-workspace-engineer', 'opus', false, 30000, 2.10);

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first['agentId']).toBe('fastify-v5-engineer');
    expect(first['model']).toBe('sonnet');
    expect(first['success']).toBe(true);
    expect(first['latencyMs']).toBe(12500);
    expect(first['costUsd']).toBe(0.84);
    expect(typeof first['ts']).toBe('string');

    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['agentId']).toBe('db-workspace-engineer');
    expect(second['success']).toBe(false);
  });

  it('replays persisted records on construction (cross-restart round-trip)', () => {
    // First instance — write 6 outcomes
    const router1 = new AdaptiveRouter({ feedbackFilePath: filePath });
    for (let i = 0; i < 6; i++) {
      router1.recordOutcome('cli-engineer', 'sonnet', true, 1000 * i, 0.1 * i);
    }

    // Second instance constructed from same file — should replay 6 entries
    const router2 = new AdaptiveRouter({ feedbackFilePath: filePath });
    // recommend() returns defaultModel when < 5 samples; with 6 replayed it should evaluate
    const result = router2.recommend('cli-engineer', 'haiku');
    // 6 entries, all success with sonnet → should recommend sonnet (cost-effective at >=70%)
    expect(result).toBe('sonnet');
  });

  it('does not write to JSONL when using legacy string-outcome signature', () => {
    const router = new AdaptiveRouter({ feedbackFilePath: filePath });
    router.recordOutcome('cli-engineer', 'haiku', 'success', 'low');

    // File should not exist or be empty since legacy path does not persist
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // file not created — that is fine
    }
    expect(content.trim()).toBe('');
  });

  it('starts empty and returns defaultModel when file does not exist', () => {
    const router = new AdaptiveRouter({ feedbackFilePath: join(tmpdir(), 'nonexistent-99999.jsonl') });
    expect(router.recommend('some-agent', 'opus')).toBe('opus');
  });

  it('skips malformed lines silently on load', async () => {
    const { writeFileSync } = await import('node:fs');
    const good = JSON.stringify({ ts: new Date().toISOString(), agentId: 'a1', model: 'sonnet', success: true, latencyMs: 100, costUsd: 0.5 });
    writeFileSync(filePath, 'not-json\n' + good + '\n{broken\n', 'utf8');

    // Should not throw; only the valid line is replayed
    const router = new AdaptiveRouter({ feedbackFilePath: filePath });
    const perf = router.getPerformance();
    const a1 = perf.find(p => p.agentId === 'a1');
    expect(a1).toBeDefined();
    expect(a1?.sampleCount).toBe(1);
  });
});
