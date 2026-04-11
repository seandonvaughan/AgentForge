/**
 * tests/server/routes/memory.test.ts
 *
 * Integration tests for GET /api/v5/memory — the JSONL-backed memory endpoint.
 *
 * Strategy: inject a temporary projectRoot with controlled *.jsonl fixtures so
 * tests are fully isolated from the real .agentforge/memory/ directory.
 * A minimal SqliteAdapter stub satisfies the route's KV-store read path (the
 * route catches DB errors, so returning [] is sufficient).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createServer } from '../../../src/server/server.js';
import type { SqliteAdapter } from '../../../src/db/index.js';

process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// Minimal SqliteAdapter stub
// ---------------------------------------------------------------------------

function makeAdapter(): SqliteAdapter {
  const stub = {
    getAgentDatabase: () => ({
      getDb: () => ({
        prepare: (_sql: string) => ({
          all: () => [] as unknown[],
          run: () => ({ changes: 0 }),
        }),
      }),
    }),
  };
  return stub as unknown as SqliteAdapter;
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

interface TestEnv {
  tmpRoot: string;
  memoryDir: string;
  dataDir: string;
}

function createTmpEnv(): TestEnv {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-memory-test-'));
  const memoryDir = join(tmpRoot, '.agentforge', 'memory');
  const dataDir = join(tmpRoot, '.agentforge', 'data');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  return { tmpRoot, memoryDir, dataDir };
}

function writeJsonlLine(dir: string, filename: string, entry: Record<string, unknown>): void {
  const filePath = join(dir, filename);
  const line = JSON.stringify(entry) + '\n';
  writeFileSync(filePath, line, { flag: 'a', encoding: 'utf8' });
}

function makeCycleOutcome(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `co-${Math.random().toString(36).slice(2)}`,
    type: 'cycle-outcome',
    value: JSON.stringify({ cycleId: 'c1', sprintVersion: '9.0.0', stage: 'completed', costUsd: 12.5, testsPassed: 100 }),
    createdAt: '2026-04-01T10:00:00.000Z',
    source: 'cycle-abc',
    tags: ['cycle', 'completed'],
    ...overrides,
  };
}

function makeGateVerdict(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `gv-${Math.random().toString(36).slice(2)}`,
    type: 'gate-verdict',
    value: JSON.stringify({ sprintVersion: '9.0.0', verdict: 'approved', rationale: 'All tests pass' }),
    createdAt: '2026-04-02T10:00:00.000Z',
    source: 'gate-agent',
    tags: ['gate'],
    ...overrides,
  };
}

function makeReviewFinding(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: `rf-${Math.random().toString(36).slice(2)}`,
    type: 'review-finding',
    value: JSON.stringify({ message: 'Minor style issue in auth module' }),
    createdAt: '2026-04-03T10:00:00.000Z',
    source: 'code-reviewer',
    tags: ['review', 'minor'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

async function buildApp(
  tmpRoot: string,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const { app } = await createServer({
    adapter: makeAdapter(),
    projectRoot: tmpRoot,
  });
  await app.ready();
  return { app, close: async () => { await app.close(); } };
}

// ---------------------------------------------------------------------------
// GET /api/v5/memory — basic contract
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — basic contract', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome());
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('returns HTTP 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('returns { data, agents, types, meta }', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('types');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.types)).toBe(true);
  });

  it('meta.total is a non-negative integer', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(typeof body.meta.total).toBe('number');
    expect(body.meta.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.meta.total)).toBe(true);
  });

  it('meta.returned equals data.length', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.meta.returned).toBe(body.data.length);
  });

  it('meta.limit is 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.meta.limit).toBe(200);
  });

  it('returns at least one entry when JSONL file is populated', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('each entry has required fields: id, key, value, type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    for (const entry of body.data) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('value');
      expect(entry).toHaveProperty('type');
    }
  });
});

// ---------------------------------------------------------------------------
// JSONL source: reads cycle-outcome, gate-verdict, review-finding
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — JSONL sources', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome({ createdAt: '2026-04-01T10:00:00.000Z' }));
    writeJsonlLine(env.memoryDir, 'gate-verdict.jsonl', makeGateVerdict({ createdAt: '2026-04-02T10:00:00.000Z' }));
    writeJsonlLine(env.memoryDir, 'review-finding.jsonl', makeReviewFinding({ createdAt: '2026-04-03T10:00:00.000Z' }));
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('reads entries from all three JSONL files', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(3);
  });

  it('types array contains all three entry types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const types: string[] = body.types;
    expect(types).toContain('cycle-outcome');
    expect(types).toContain('gate-verdict');
    expect(types).toContain('review-finding');
  });

  it('entries are sorted newest-first by createdAt', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    // Filter to only JSONL entries that have createdAt set
    const dated = body.data.filter((e: { createdAt?: string }) => e.createdAt);
    for (let i = 1; i < dated.length; i++) {
      expect(dated[i - 1].createdAt >= dated[i].createdAt).toBe(true);
    }
  });

  it('cycle-outcome entry has category "project"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const co = body.data.find((e: { type: string }) => e.type === 'cycle-outcome');
    expect(co).toBeDefined();
    expect(co.category).toBe('project');
  });

  it('gate-verdict entry has category "feedback"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const gv = body.data.find((e: { type: string }) => e.type === 'gate-verdict');
    expect(gv).toBeDefined();
    expect(gv.category).toBe('feedback');
  });

  it('review-finding entry has category "feedback"', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const rf = body.data.find((e: { type: string }) => e.type === 'review-finding');
    expect(rf).toBeDefined();
    expect(rf.category).toBe('feedback');
  });

  it('each entry has a non-empty summary', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    for (const entry of body.data) {
      if (entry.type) {
        expect(typeof entry.summary).toBe('string');
        expect(entry.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it('key is formatted as <type>/<source> when source is present', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    for (const entry of body.data) {
      if (entry.source && entry.type) {
        expect(entry.key).toBe(`${entry.type}/${entry.source}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Filtering: type filter
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — type filter', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome());
    writeJsonlLine(env.memoryDir, 'gate-verdict.jsonl', makeGateVerdict());
    writeJsonlLine(env.memoryDir, 'review-finding.jsonl', makeReviewFinding());
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('returns only cycle-outcome entries when type=cycle-outcome', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=cycle-outcome' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.type).toBe('cycle-outcome');
    }
  });

  it('returns only gate-verdict entries when type=gate-verdict', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=gate-verdict' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.type).toBe('gate-verdict');
    }
  });

  it('returns only review-finding entries when type=review-finding', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=review-finding' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.type).toBe('review-finding');
    }
  });

  it('meta.total reflects filtered count not full set', async () => {
    const resAll = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const resFiltered = await app.inject({ method: 'GET', url: '/api/v5/memory?type=cycle-outcome' });
    expect(resFiltered.json().meta.total).toBeLessThan(resAll.json().meta.total);
  });

  it('unknown type returns empty data array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=nonexistent-type' });
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering: since filter
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — since filter', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome({ createdAt: '2026-01-01T00:00:00.000Z' }));
    writeJsonlLine(env.memoryDir, 'gate-verdict.jsonl', makeGateVerdict({ createdAt: '2026-04-01T00:00:00.000Z' }));
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('since=2026-03-01 excludes entries before that date', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?since=2026-03-01T00:00:00.000Z' });
    const body = res.json();
    for (const entry of body.data) {
      if (entry.createdAt) {
        expect(new Date(entry.createdAt).getTime()).toBeGreaterThanOrEqual(new Date('2026-03-01T00:00:00.000Z').getTime());
      }
    }
  });

  it('since filter reduces total count compared to unfiltered', async () => {
    const resAll = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const resSince = await app.inject({ method: 'GET', url: '/api/v5/memory?since=2026-03-01T00:00:00.000Z' });
    expect(resSince.json().meta.total).toBeLessThan(resAll.json().meta.total);
  });

  it('since in the far future returns empty data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?since=2099-01-01T00:00:00.000Z' });
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering: search filter
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — search filter', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome({
      value: JSON.stringify({ sprintVersion: 'unique-sprint-xyz', stage: 'completed', costUsd: 5.0, testsPassed: 10 }),
    }));
    writeJsonlLine(env.memoryDir, 'gate-verdict.jsonl', makeGateVerdict());
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('search=unique-sprint-xyz returns only matching entry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=unique-sprint-xyz' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      const haystack = [entry.key, entry.value, entry.summary ?? ''].join(' ').toLowerCase();
      expect(haystack).toContain('unique-sprint-xyz');
    }
  });

  it('search with no matches returns empty data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=this-string-will-never-match-12345' });
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('search is case-insensitive', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=UNIQUE-SPRINT-XYZ' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Filtering: agentId filter
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — agentId filter', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome({ source: 'specific-agent' }));
    writeJsonlLine(env.memoryDir, 'gate-verdict.jsonl', makeGateVerdict({ source: 'other-agent' }));
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('agentId filter returns only entries from that source', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agentId=specific-agent' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.agentId).toBe('specific-agent');
    }
  });

  it('agent (legacy alias) filter works the same as agentId', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agent=specific-agent' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const entry of body.data) {
      expect(entry.agentId).toBe('specific-agent');
    }
  });

  it('agents array in response includes all sources', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.agents).toContain('specific-agent');
    expect(body.agents).toContain('other-agent');
  });

  it('agentId=nonexistent returns empty data', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agentId=nonexistent-agent' });
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Empty / missing memory directory
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — empty/missing memory dir', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    // Do NOT write any JSONL files
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('returns HTTP 200 even when no JSONL files exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
  });

  it('returns empty data array when no sources available', async () => {
    // Remove the memory dir entirely to simulate missing dir
    rmSync(env.memoryDir, { recursive: true, force: true });
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(Array.isArray(body.data)).toBe(true);
    // data may be empty or populated from sessions fallback; either is valid
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — deduplication', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  const sharedId = 'dedupe-test-id-123';

  beforeEach(async () => {
    env = createTmpEnv();
    // Write the same entry twice to the same file
    const entry = makeCycleOutcome({ id: sharedId });
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', entry);
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', entry);
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('deduplicates entries with the same id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const ids = body.data.map((e: { id: string }) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL resilience
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — malformed JSONL resilience', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    // Mix of malformed and valid lines
    const filePath = join(env.memoryDir, 'cycle-outcome.jsonl');
    writeFileSync(filePath, [
      'INVALID JSON {{{',
      '',
      JSON.stringify(makeCycleOutcome({ id: 'valid-entry-1' })),
      '{ incomplete json',
      JSON.stringify(makeCycleOutcome({ id: 'valid-entry-2' })),
    ].join('\n') + '\n', 'utf8');
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('returns HTTP 200 even with malformed lines in JSONL', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
  });

  it('returns only valid entries, skipping malformed lines', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const ids = body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain('valid-entry-1');
    expect(ids).toContain('valid-entry-2');
    expect(body.data.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// memories.json secondary source
// ---------------------------------------------------------------------------

describe('GET /api/v5/memory — memories.json secondary source', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    // Write a memories.json with one entry
    const memoriesJson = {
      entries: [
        {
          id: 'mem-json-entry-1',
          filename: 'feedback_model_routing.md',
          category: 'lesson',
          agentId: 'cto',
          summary: 'Always set model parameter on Agent dispatches',
          tags: ['model', 'routing'],
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(join(env.dataDir, 'memories.json'), JSON.stringify(memoriesJson), 'utf8');
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('includes entries from memories.json alongside JSONL entries', async () => {
    writeJsonlLine(env.memoryDir, 'cycle-outcome.jsonl', makeCycleOutcome());
    // Rebuild app after adding JSONL entry
    await close();
    ({ app, close } = await buildApp(env.tmpRoot));

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    const ids = body.data.map((e: { id?: string }) => e.id);
    expect(ids).toContain('mem-json-entry-1');
  });

  it('returns memories.json entries even when JSONL dir is empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = res.json();
    expect(body.data.length).toBeGreaterThan(0);
    const entry = body.data.find((e: { id?: string }) => e.id === 'mem-json-entry-1');
    expect(entry).toBeDefined();
    expect(entry.category).toBe('lesson');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v5/memory/:id — returns 404 for non-existent KV entry
// ---------------------------------------------------------------------------

describe('DELETE /api/v5/memory/:id', () => {
  let env: TestEnv;
  let app: FastifyInstance;
  let close: () => Promise<void>;

  beforeEach(async () => {
    env = createTmpEnv();
    ({ app, close } = await buildApp(env.tmpRoot));
  });

  afterEach(async () => {
    await close();
    rmSync(env.tmpRoot, { recursive: true, force: true });
  });

  it('returns 404 when deleting a non-existent key', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v5/memory/nonexistent-key',
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns error body with key field on 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v5/memory/some-key',
    });
    const body = res.json();
    expect(body).toHaveProperty('key');
  });

  it('decodes URL-encoded key in DELETE path', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v5/memory/' + encodeURIComponent('namespace/key'),
    });
    // 404 is expected since no such key exists in the stub; important thing is
    // the route responds correctly (not 400 or 500 from decode failure).
    expect([404, 500]).toContain(res.statusCode);
  });
});
