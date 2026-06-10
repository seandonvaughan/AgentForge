/**
 * Integration tests for GET /api/v5/agents/:id/memory.
 *
 * The route serves ONLY the agent's personal W2 memory from
 * `.agentforge/memory/agents/<id>.jsonl` (newest first). Uses a temporary
 * project root so tests are hermetic and CI-safe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../../../server.js';

let createdApps: Array<{ close: () => Promise<void> }> = [];
let tmpDirs: string[] = [];

afterEach(async () => {
  for (const app of createdApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  createdApps = [];
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-agent-memory-'));
  tmpDirs.push(dir);
  return dir;
}

async function makeApp(projectRoot: string) {
  const { app } = await createServerV5({ listen: false, projectRoot });
  createdApps.push(app);
  return app;
}

interface MemoryEntry {
  id: string;
  createdAt: string;
  kind: string;
  value: string;
  cycleId?: string;
  itemId?: string;
  outcome?: string;
  costUsd?: number;
  tags?: string[];
}

function writeAgentMemoryFixture(projectRoot: string, agentId: string, entries: MemoryEntry[]): void {
  const agentsMemDir = join(projectRoot, '.agentforge', 'memory', 'agents');
  mkdirSync(agentsMemDir, { recursive: true });
  writeFileSync(
    join(agentsMemDir, `${agentId}.jsonl`),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

describe('GET /api/v5/agents/:id/memory', () => {
  it('returns the agent personal W2 memory entries newest-first with all fields', async () => {
    const projectRoot = makeTmpRoot();
    writeAgentMemoryFixture(projectRoot, 'coder', [
      {
        id: 'm1',
        createdAt: '2026-06-01T00:00:00.000Z',
        kind: 'item-outcome',
        value: 'Completed item alpha',
        cycleId: 'cyc-1',
        itemId: 'item-1',
        outcome: 'completed',
        costUsd: 0.42,
        tags: ['execute'],
      },
      {
        id: 'm2',
        createdAt: '2026-06-02T00:00:00.000Z',
        kind: 'self-note',
        value: 'Always run the scoped suite before reporting',
      },
    ]);

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/coder/memory' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: MemoryEntry[]; meta: { total: number } }>();
    expect(body.meta.total).toBe(2);

    // Newest entry (last JSONL line) first.
    expect(body.data[0]).toMatchObject({
      id: 'm2',
      kind: 'self-note',
      value: 'Always run the scoped suite before reporting',
    });
    expect(body.data[1]).toMatchObject({
      id: 'm1',
      createdAt: '2026-06-01T00:00:00.000Z',
      kind: 'item-outcome',
      value: 'Completed item alpha',
      cycleId: 'cyc-1',
      itemId: 'item-1',
      outcome: 'completed',
      costUsd: 0.42,
      tags: ['execute'],
    });
  });

  it('respects the ?limit query (clamped to the store cap)', async () => {
    const projectRoot = makeTmpRoot();
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 5; i++) {
      entries.push({
        id: `m${i}`,
        createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
        kind: 'self-note',
        value: `note ${i}`,
      });
    }
    writeAgentMemoryFixture(projectRoot, 'coder', entries);

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/coder/memory?limit=2' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: MemoryEntry[]; meta: { total: number } }>();
    expect(body.meta.total).toBe(2);
    expect(body.data.map((e) => e.id)).toEqual(['m4', 'm3']);
  });

  it('returns 200 with an empty list when the agent has no memory file', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'memory', 'agents'), { recursive: true });

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/ghost/memory' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: MemoryEntry[]; meta: { total: number } }>();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('rejects invalid agent ids (path traversal attempts) without serving files', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/..%2F..%2Fetc/memory' });
    // 400 (invalid id) or 404 acceptable; must NOT be 200 with data.
    expect([400, 404]).toContain(res.statusCode);
  });

  it('skips corrupt JSONL lines instead of failing the request', async () => {
    const projectRoot = makeTmpRoot();
    const agentsMemDir = join(projectRoot, '.agentforge', 'memory', 'agents');
    mkdirSync(agentsMemDir, { recursive: true });
    writeFileSync(
      join(agentsMemDir, 'coder.jsonl'),
      '{ not json at all\n' +
        JSON.stringify({ id: 'ok-1', createdAt: '2026-06-01T00:00:00.000Z', kind: 'self-note', value: 'survived' }) +
        '\n',
    );

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/coder/memory' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: MemoryEntry[]; meta: { total: number } }>();
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.value).toBe('survived');
  });
});
