import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProposalToBacklog } from '../../../packages/core/src/autonomous/proposal-to-backlog.js';
import { DEFAULT_CYCLE_CONFIG } from '../../../packages/core/src/autonomous/config-loader.js';

describe('ProposalToBacklog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-p2b-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockAdapter(overrides: any = {}) {
    return {
      getRecentFailedSessions: overrides.getRecentFailedSessions ?? (async () => []),
      getCostAnomalies: overrides.getCostAnomalies ?? (async () => []),
      getFailedTaskOutcomes: overrides.getFailedTaskOutcomes ?? (async () => []),
      getFlakingTests: overrides.getFlakingTests ?? (async () => []),
    };
  }

  it('returns empty backlog when no data sources have items', async () => {
    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items).toEqual([]);
  });

  it('converts failed sessions into backlog items with confidence filter', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'TypeError: undefined', confidence: 0.8 },
        { id: 's2', agent: 'debugger', error: 'race', confidence: 0.4 }, // below default 0.6
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every(i => !i.title.includes('race'))).toBe(true); // filtered
  });

  it('scans for TODO(autonomous) markers in the codebase', async () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'src/foo.ts'),
      `// TODO(autonomous): migrate workspace-adapter to postgres\nexport const x = 1;`,
    );
    writeFileSync(
      join(tmpDir, 'src/bar.ts'),
      `// TODO: regular human todo — should be ignored\nexport const y = 2;`,
    );
    writeFileSync(
      join(tmpDir, 'src/baz.ts'),
      `// FIXME(autonomous): broken parser\nexport const z = 3;`,
    );

    const bridge = new ProposalToBacklog(makeMockAdapter(), tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();

    expect(items.some(i => i.title.includes('migrate workspace-adapter'))).toBe(true);
    expect(items.some(i => i.title.includes('broken parser'))).toBe(true);
    expect(items.some(i => i.title.includes('regular human'))).toBe(false);
  });

  it('deduplicates items with same title', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'same error', confidence: 0.8 },
        { id: 's2', agent: 'coder', error: 'same error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    const titles = items.map(i => i.title);
    const uniqueTitles = new Set(titles);
    expect(titles.length).toBe(uniqueTitles.size);
  });

  it('assigns priority based on source type', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'crash', confidence: 0.9 },
      ],
      getCostAnomalies: async () => [
        { agent: 'runner', anomaly: 'cost spike', confidence: 0.9 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    expect(items.some(i => i.priority === 'P0')).toBe(true); // crashes = P0
    expect(items.some(i => i.priority === 'P1')).toBe(true); // cost = P1
  });

  it('every BacklogItem has required fields', async () => {
    const adapter = makeMockAdapter({
      getRecentFailedSessions: async () => [
        { id: 's1', agent: 'coder', error: 'error', confidence: 0.8 },
      ],
    });
    const bridge = new ProposalToBacklog(adapter, tmpDir, DEFAULT_CYCLE_CONFIG);
    const items = await bridge.build();
    for (const item of items) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('description');
      expect(item).toHaveProperty('priority');
      expect(item).toHaveProperty('tags');
      expect(item).toHaveProperty('source');
    }
  });
});
