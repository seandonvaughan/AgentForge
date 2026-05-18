// tests/core/skills/flywheel/cluster-low-quality.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { clusterLowQuality } from '../../../../packages/core/src/skills/flywheel/cluster-low-quality.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

let projectRoot: string;
let memoryDir: string;

beforeEach(() => {
  projectRoot = join(tmpdir(), `af-test-cluster-${randomUUID()}`);
  memoryDir = join(projectRoot, '.agentforge', 'memory');
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(projectRoot)) {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clusterLowQuality', () => {
  it('returns empty array when memory files are absent', () => {
    const result = clusterLowQuality({ projectRoot });
    expect(result).toEqual([]);
  });

  it('returns empty array when all clusters have scores >= threshold', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'e1', capability_tag: 'code-review', step_score: 0.8 },
      { id: 'e2', capability_tag: 'code-review', step_score: 0.9 },
      { id: 'e3', capability_tag: 'code-review', step_score: 0.75 },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toEqual([]);
  });

  it('returns empty array when cluster has fewer than minOccurrences', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'e1', capability_tag: 'deploy', step_score: 0.2 },
      { id: 'e2', capability_tag: 'deploy', step_score: 0.3 },
      // only 2 occurrences — below default minOccurrences=3
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toEqual([]);
  });

  it('returns qualifying clusters below threshold', () => {
    writeJsonl(join(memoryDir, 'self-eval.jsonl'), [
      { id: 'a1', capability_tag: 'test', step_score: 0.3, exemplar_prompt: 'Write a test' },
      { id: 'a2', capability_tag: 'test', step_score: 0.4 },
      { id: 'a3', capability_tag: 'test', step_score: 0.2 },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toHaveLength(1);
    const cluster = result[0]!;
    expect(cluster.capabilityTag).toBe('test');
    expect(cluster.occurrences).toBe(3);
    expect(cluster.meanStepScore).toBeCloseTo(0.3, 2);
    expect(cluster.exemplarPrompt).toBe('Write a test');
    expect(cluster.id).toBe('cluster-test');
    expect(cluster.memberIds).toHaveLength(3);
  });

  it('merges self-eval.jsonl and step-scores.jsonl into the same cluster', () => {
    writeJsonl(join(memoryDir, 'self-eval.jsonl'), [
      { id: 's1', capability_tag: 'git', step_score: 0.2 },
    ]);
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 's2', capability_tag: 'git', score: 0.3 },
      { id: 's3', capability_tag: 'git', step_score: 0.1 },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toHaveLength(1);
    expect(result[0]!.occurrences).toBe(3);
  });

  it('respects custom minOccurrences and maxMeanScore overrides', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'x1', capability_tag: 'web-search', step_score: 0.6 },
      { id: 'x2', capability_tag: 'web-search', step_score: 0.7 },
    ]);
    // Default: no match (< 3 occurrences, score >= 0.55)
    expect(clusterLowQuality({ projectRoot })).toHaveLength(0);
    // Override: minOccurrences=2, maxMeanScore=0.8 → should match
    const result = clusterLowQuality({ projectRoot, minOccurrences: 2, maxMeanScore: 0.8 });
    expect(result).toHaveLength(1);
    expect(result[0]!.capabilityTag).toBe('web-search');
  });

  it('sorts clusters by meanStepScore ascending (worst first)', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'b1', capability_tag: 'bash', step_score: 0.4 },
      { id: 'b2', capability_tag: 'bash', step_score: 0.4 },
      { id: 'b3', capability_tag: 'bash', step_score: 0.4 },
      { id: 'c1', capability_tag: 'code-review', step_score: 0.2 },
      { id: 'c2', capability_tag: 'code-review', step_score: 0.2 },
      { id: 'c3', capability_tag: 'code-review', step_score: 0.2 },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toHaveLength(2);
    // code-review (0.2) should come before bash (0.4)
    expect(result[0]!.capabilityTag).toBe('code-review');
    expect(result[1]!.capabilityTag).toBe('bash');
  });

  it('skips rows without a capability_tag', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'e1', step_score: 0.1 }, // no tag
      { id: 'e2', capability_tag: 'test', step_score: 0.2 },
      { id: 'e3', capability_tag: 'test', step_score: 0.3 },
      { id: 'e4', capability_tag: 'test', step_score: 0.4 },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toHaveLength(1);
    expect(result[0]!.occurrences).toBe(3);
  });

  it('treats missing score fields as 0', () => {
    writeJsonl(join(memoryDir, 'step-scores.jsonl'), [
      { id: 'n1', capability_tag: 'deploy' },
      { id: 'n2', capability_tag: 'deploy' },
      { id: 'n3', capability_tag: 'deploy' },
    ]);
    const result = clusterLowQuality({ projectRoot });
    expect(result).toHaveLength(1);
    expect(result[0]!.meanStepScore).toBe(0);
  });
});
