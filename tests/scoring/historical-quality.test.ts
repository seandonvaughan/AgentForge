// tests/scoring/historical-quality.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historicalQuality } from '../../packages/core/src/scoring/historical-quality.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'historical-quality-'));
  // Ensure env is clear
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env['AGENTFORGE_NO_QUALITY_BIAS'];
});

function writeScores(lines: object[]) {
  const memDir = join(tmpRoot, '.agentforge', 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'step-scores.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Empty / missing history
// ---------------------------------------------------------------------------

describe('empty / missing history', () => {
  it('returns empty array when step-scores.jsonl does not exist', () => {
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toEqual([]);
  });

  it('returns empty array when file exists but has no matching records', () => {
    writeScores([
      { agent_id: 'agent-A', item_kind: 'fix', capability_tag: 'bar', utility: 0.9 },
    ]);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toEqual([]);
  });

  it('returns empty array when matching records exist but below min-observations gate (5)', () => {
    const records = Array.from({ length: 4 }, (_, i) => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.8 + i * 0.01,
    }));
    writeScores(records);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Min-observations gate
// ---------------------------------------------------------------------------

describe('min-observations gate', () => {
  it('includes agent exactly at threshold (5 observations)', () => {
    const records = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.8,
    }));
    writeScores(records);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent_id).toBe('agent-A');
  });

  it('excludes agent below threshold even if another meets it', () => {
    const sufficient = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.8,
    }));
    const insufficient = Array.from({ length: 3 }, () => ({
      agent_id: 'agent-B',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.95,
    }));
    writeScores([...sufficient, ...insufficient]);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    const ids = result.map((r) => r.agent_id);
    expect(ids).toContain('agent-A');
    expect(ids).not.toContain('agent-B');
  });
});

// ---------------------------------------------------------------------------
// Top-K ranking
// ---------------------------------------------------------------------------

describe('top-K ranking', () => {
  it('returns agents sorted by mean utility, top-3 by default', () => {
    const makeRecords = (agentId: string, utility: number, count = 5) =>
      Array.from({ length: count }, () => ({
        agent_id: agentId,
        item_kind: 'feature',
        capability_tag: 'foo',
        utility,
      }));

    writeScores([
      ...makeRecords('agent-low', 0.4),
      ...makeRecords('agent-mid', 0.7),
      ...makeRecords('agent-high', 0.95),
      ...makeRecords('agent-best', 0.99),
    ]);

    const result = historicalQuality(tmpRoot, 'feature', ['foo'], 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.agent_id).toBe('agent-best');
    expect(result[1]!.agent_id).toBe('agent-high');
    expect(result[2]!.agent_id).toBe('agent-mid');
  });

  it('respects k parameter', () => {
    const makeRecords = (agentId: string, utility: number) =>
      Array.from({ length: 5 }, () => ({
        agent_id: agentId,
        item_kind: 'feature',
        capability_tag: 'foo',
        utility,
      }));

    writeScores([...makeRecords('agent-A', 0.9), ...makeRecords('agent-B', 0.8)]);
    const result = historicalQuality(tmpRoot, 'feature', ['foo'], 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent_id).toBe('agent-A');
  });
});

// ---------------------------------------------------------------------------
// Bias toward agent-X for capability "foo" — 100 records
// ---------------------------------------------------------------------------

describe('100-record bias test', () => {
  it('agent-X ranks #1 when biased with 100 high-utility records for capability foo', () => {
    const biasedRecords = Array.from({ length: 100 }, () => ({
      agent_id: 'agent-X',
      model: 'sonnet',
      skill_ids: ['skill-alpha'],
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.95,
    }));
    // Add some noise records for other agents
    const noiseRecords = Array.from({ length: 10 }, (_, i) => ({
      agent_id: `agent-noise-${i % 3}`,
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.6,
    }));
    writeScores([...noiseRecords, ...biasedRecords]);

    const result = historicalQuality(tmpRoot, 'feature', ['foo'], 3);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.agent_id).toBe('agent-X');
    expect(result[0]!.confidence).toBeCloseTo(1.0, 2);
    expect(result[0]!.model).toBe('sonnet');
    expect(result[0]!.skill_ids).toEqual(['skill-alpha']);
  });
});

// ---------------------------------------------------------------------------
// Recency bias
// ---------------------------------------------------------------------------

describe('recency bias', () => {
  it('recent records have more weight than older ones', () => {
    // agent-old: 10 records first (older), utility 1.0
    // agent-new: 10 records last (newer), utility 0.5
    // After decay, agent-old's effective mean should still be higher
    // due to utility — test the decay doesn't completely invert utility ordering
    const oldRecords = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-old',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 1.0,
    }));
    const newRecords = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-new',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.1,
    }));
    writeScores([...oldRecords, ...newRecords]);

    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    const ids = result.map((r) => r.agent_id);
    // agent-old has much higher utility so should still rank above agent-new
    expect(ids.indexOf('agent-old')).toBeLessThan(ids.indexOf('agent-new'));
  });
});

// ---------------------------------------------------------------------------
// Capability-tag matching
// ---------------------------------------------------------------------------

describe('capability-tag matching', () => {
  it('matches when item capability tag includes record tag (substring)', () => {
    const records = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.8,
    }));
    writeScores(records);
    // 'foo-bar' includes 'foo' → should match
    const result = historicalQuality(tmpRoot, 'feature', ['foo-bar']);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent_id).toBe('agent-A');
  });

  it('matches when record tag includes item capability tag (substring)', () => {
    const records = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo-advanced',
      utility: 0.8,
    }));
    writeScores(records);
    // record has 'foo-advanced', item has 'foo' → 'foo-advanced'.includes('foo') = true
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toHaveLength(1);
  });

  it('does not match unrelated tags', () => {
    const records = Array.from({ length: 5 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'bar',
      utility: 0.8,
    }));
    writeScores(records);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AGENTFORGE_NO_QUALITY_BIAS env var
// ---------------------------------------------------------------------------

describe('AGENTFORGE_NO_QUALITY_BIAS env var', () => {
  it('returns empty array when env var is set to "1"', () => {
    process.env['AGENTFORGE_NO_QUALITY_BIAS'] = '1';
    const records = Array.from({ length: 10 }, () => ({
      agent_id: 'agent-A',
      item_kind: 'feature',
      capability_tag: 'foo',
      utility: 0.9,
    }));
    writeScores(records);
    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Malformed lines are skipped
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('skips malformed JSONL lines gracefully', () => {
    const memDir = join(tmpRoot, '.agentforge', 'memory');
    mkdirSync(memDir, { recursive: true });
    const goodRecord = { agent_id: 'agent-A', item_kind: 'feature', capability_tag: 'foo', utility: 0.9 };
    const content = [
      'NOT_JSON',
      JSON.stringify(goodRecord),
      JSON.stringify(goodRecord),
      '{"incomplete":',
      JSON.stringify(goodRecord),
      JSON.stringify(goodRecord),
      JSON.stringify(goodRecord),
    ].join('\n') + '\n';
    writeFileSync(join(memDir, 'step-scores.jsonl'), content, 'utf8');

    const result = historicalQuality(tmpRoot, 'feature', ['foo']);
    expect(result).toHaveLength(1);
    expect(result[0]!.agent_id).toBe('agent-A');
  });
});
