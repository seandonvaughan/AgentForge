/**
 * Tests for GET /api/v5/memory — JSONL-based memory entry reading.
 *
 * Verifies that the endpoint correctly reads .jsonl files written by
 * writeMemoryEntry(), maps CycleMemoryEntry fields to DashboardMemoryEntry
 * shape, returns entries newest-first, and populates the agents array.
 *
 * Also verifies backward-compat: legacy .json and .md files are still served.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dashboardStubRoutes } from '../dashboard-stubs.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-memory-'));
  app = Fastify({ logger: false });
  await dashboardStubRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function memoryDir() {
  return join(tmpRoot, '.agentforge', 'memory');
}

function ensureMemoryDir() {
  mkdirSync(memoryDir(), { recursive: true });
}

/** Append one JSONL line (mimics writeMemoryEntry behaviour). */
function appendJsonlEntry(
  type: string,
  entry: Record<string, unknown>,
) {
  ensureMemoryDir();
  const line = JSON.stringify({ id: `id-${Math.random()}`, type, createdAt: new Date().toISOString(), ...entry });
  const filePath = join(memoryDir(), `${type}.jsonl`);
  // Use appendFileSync behaviour via a try-catch write to keep tests self-contained.
  const existing = (() => {
    try { return require('node:fs').readFileSync(filePath, 'utf-8'); } catch { return ''; }
  })();
  writeFileSync(filePath, existing + line + '\n', 'utf-8');
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/v5/memory', () => {
  it('returns 200 with empty data when memory directory does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('reads entries from a .jsonl file and maps fields correctly', async () => {
    appendJsonlEntry('cycle-outcome', {
      id: 'entry-001',
      value: 'Cycle completed successfully',
      source: 'cycle-abc123',
      tags: ['cycle', 'success'],
      createdAt: '2026-04-08T10:00:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; agents: string[]; meta: { total: number } };

    expect(body.meta.total).toBe(1);
    const entry = body.data[0]!;
    expect(entry.id).toBe('entry-001');
    expect(entry.type).toBe('cycle-outcome');
    // key should be the type, not a UUID
    expect(entry.key).toBe('cycle-outcome');
    expect(entry.value).toBe('Cycle completed successfully');
    expect(entry.createdAt).toBe('2026-04-08T10:00:00.000Z');
    expect(entry.agentId).toBe('cycle-abc123');
    expect(entry.tags).toEqual(['cycle', 'success']);
  });

  it('reads multiple entries from multiple .jsonl files', async () => {
    appendJsonlEntry('gate-verdict', { id: 'gv-1', value: 'approved', createdAt: '2026-04-08T09:00:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'gv-2', value: 'rejected', createdAt: '2026-04-08T09:30:00.000Z' });
    appendJsonlEntry('review-finding', { id: 'rf-1', value: 'MAJOR: missing tests', createdAt: '2026-04-08T08:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(3);
  });

  it('sorts entries newest-first', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'old', value: 'old', createdAt: '2026-04-01T00:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'new', value: 'new', createdAt: '2026-04-08T00:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data[0]!.id).toBe('new');
    expect(body.data[1]!.id).toBe('old');
  });

  it('populates agents array with unique source IDs', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'e1', value: 'v1', source: 'agent-alice' });
    appendJsonlEntry('gate-verdict', { id: 'e2', value: 'v2', source: 'agent-bob' });
    appendJsonlEntry('review-finding', { id: 'e3', value: 'v3', source: 'agent-alice' }); // duplicate

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = JSON.parse(res.body) as { agents: string[] };
    expect(body.agents).toHaveLength(2);
    expect(body.agents).toContain('agent-alice');
    expect(body.agents).toContain('agent-bob');
  });

  it('skips malformed JSONL lines without crashing', async () => {
    ensureMemoryDir();
    writeFileSync(join(memoryDir(), 'cycle-outcome.jsonl'), [
      JSON.stringify({ id: 'good', type: 'cycle-outcome', value: 'ok', createdAt: new Date().toISOString() }),
      'this is not valid JSON }{',
      JSON.stringify({ id: 'also-good', type: 'cycle-outcome', value: 'also ok', createdAt: new Date().toISOString() }),
    ].join('\n') + '\n');

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; meta: { total: number } };
    // Only the 2 valid lines should be returned, malformed line skipped.
    expect(body.meta.total).toBe(2);
  });

  it('also serves legacy .json files for backward compatibility', async () => {
    ensureMemoryDir();
    writeFileSync(join(memoryDir(), 'legacy-data.json'), JSON.stringify({ foo: 'bar' }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.key).toBe('legacy-data');
    expect(body.data[0]!.type).toBe('json');
  });

  it('also serves legacy .md files for backward compatibility', async () => {
    ensureMemoryDir();
    writeFileSync(join(memoryDir(), 'notes.md'), '# Memory Notes\nSome text here.');

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.key).toBe('notes');
    expect(body.data[0]!.type).toBe('text');
  });

  it('response always includes agents array even when no sources present', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'e1', value: 'no source here' }); // no source field

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = JSON.parse(res.body) as { agents: string[] };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(0);
  });

  it('meta includes limit field', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    const body = JSON.parse(res.body) as { meta: { total: number; limit: number } };
    expect(body.meta).toHaveProperty('limit');
    expect(typeof body.meta.limit).toBe('number');
  });

  // ── ?search filter ───────────────────────────────────────────────────────

  it('?search filters entries by substring match on value', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'needle-entry', value: 'contains-needle-here', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'haystack-entry', value: 'nothing-useful', createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=needle' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('needle-entry');
  });

  it('?search is case-insensitive', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'upper-entry', value: 'UPPERCASE-TERM', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=uppercase-term' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('upper-entry');
  });

  it('?search with no matches returns empty data array', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'something', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?search=zzz-not-found' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  // ── ?type filter ──────────────────────────────────────────────────────────

  it('?type filters entries by exact type match', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'outcome', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'gv-1', value: 'verdict', createdAt: '2026-04-08T10:01:00.000Z' });
    appendJsonlEntry('review-finding', { id: 'rf-1', value: 'finding', createdAt: '2026-04-08T10:02:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=gate-verdict' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string; type: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('gv-1');
    expect(body.data[0]!.type).toBe('gate-verdict');
  });

  it('?type with no matches returns empty data array', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'x', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=nonexistent-type' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('types array in response lists all unique types from recent window regardless of ?type filter', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'x', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'gv-1', value: 'y', createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=cycle-outcome' });
    const body = JSON.parse(res.body) as { types: string[] };
    // types should include both even though only cycle-outcome is in data
    expect(body.types).toContain('cycle-outcome');
    expect(body.types).toContain('gate-verdict');
  });

  // ── ?agentId filter ───────────────────────────────────────────────────────

  it('?agentId filters entries by exact agentId (source) match', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'a', source: 'agent-alpha', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'co-2', value: 'b', source: 'agent-beta', createdAt: '2026-04-08T10:01:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'gv-1', value: 'c', source: 'agent-alpha', createdAt: '2026-04-08T10:02:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agentId=agent-alpha' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(2);
    const ids = body.data.map(e => e.id);
    expect(ids).toContain('co-1');
    expect(ids).toContain('gv-1');
    expect(ids).not.toContain('co-2');
  });

  it('?agentId with no matches returns empty data array', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'x', source: 'agent-alpha', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agentId=agent-unknown' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  // ── ?since filter ─────────────────────────────────────────────────────────

  it('?since filters entries to those with createdAt >= since', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'old', value: 'old', createdAt: '2026-04-01T00:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'new', value: 'new', createdAt: '2026-04-08T00:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'exact', value: 'exact', createdAt: '2026-04-05T00:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?since=2026-04-05T00:00:00.000Z' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(2);
    const ids = body.data.map(e => e.id);
    expect(ids).toContain('new');
    expect(ids).toContain('exact'); // exact match on since boundary is included
    expect(ids).not.toContain('old');
  });

  it('?since with future timestamp returns empty data array', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'x', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?since=2099-01-01T00:00:00.000Z' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
  });

  it('?since with invalid date string is ignored (returns all entries)', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-1', value: 'x', createdAt: '2026-04-08T10:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?since=not-a-date' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number } };
    // Invalid since should be ignored — all entries returned
    expect(body.meta.total).toBe(1);
  });

  // ── combined filters ──────────────────────────────────────────────────────

  it('?type and ?agentId can be combined', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'co-alpha', value: 'x', source: 'agent-alpha', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('gate-verdict', { id: 'gv-alpha', value: 'y', source: 'agent-alpha', createdAt: '2026-04-08T10:01:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'co-beta', value: 'z', source: 'agent-beta', createdAt: '2026-04-08T10:02:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?type=cycle-outcome&agentId=agent-alpha' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('co-alpha');
  });

  // ── ?agent legacy alias ───────────────────────────────────────────────────

  it('?agent (legacy alias) filters the same as ?agentId', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'e1', value: 'a', source: 'agent-legacy', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'e2', value: 'b', source: 'agent-other',  createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory?agent=agent-legacy' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('e1');
  });

  // ── memories.json always-merge behaviour ────────────────────────────────
  // Previously memories.json was a "fallback when empty" — curated entries
  // disappeared as soon as any JSONL entry existed (the root cause of the
  // "static content" bug).  The fixed behaviour merges both sources always.

  it('memories.json entries are merged alongside JSONL entries (not just when JSONL is empty)', async () => {
    // Write a real JSONL entry so entries is non-empty before the merge step.
    appendJsonlEntry('cycle-outcome', { id: 'jsonl-1', value: 'live cycle', createdAt: '2026-04-08T10:00:00.000Z' });

    // Write a memories.json with a curated entry that has a different id.
    mkdirSync(join(tmpRoot, '.agentforge', 'data'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.agentforge', 'data', 'memories.json'),
      JSON.stringify({
        entries: [
          {
            id: 'curated-1',
            filename: 'lesson-one.md',
            category: 'lesson',
            summary: 'Always use deduplication.',
            createdAt: '2026-04-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };

    // Both the JSONL entry and the curated memory must be present.
    expect(body.meta.total).toBe(2);
    const ids = body.data.map(e => e.id);
    expect(ids).toContain('jsonl-1');
    expect(ids).toContain('curated-1');
  });

  it('memories.json entries are deduplicated when id matches a JSONL entry', async () => {
    // Same id in both JSONL and memories.json — should appear once.
    appendJsonlEntry('cycle-outcome', { id: 'shared-id', value: 'from jsonl', createdAt: '2026-04-08T10:00:00.000Z' });

    mkdirSync(join(tmpRoot, '.agentforge', 'data'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.agentforge', 'data', 'memories.json'),
      JSON.stringify({
        entries: [
          {
            id: 'shared-id',    // same id as the JSONL entry above
            filename: 'dup.md',
            summary: 'This should be deduped away.',
            createdAt: '2026-04-01T00:00:00.000Z',
          },
        ],
      }),
      'utf-8',
    );

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };

    // Only one entry — the JSONL entry wins; memories.json duplicate is skipped.
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.id).toBe('shared-id');
  });
});

// ── GET /api/v5/memory/stream ─────────────────────────────────────────────────
//
// Streaming NDJSON endpoint — returns one JSON object per line without
// buffering the full corpus.  Filters are applied inline during the read.

describe('GET /api/v5/memory/stream', () => {
  /** Parse an NDJSON response body into an array of parsed objects. */
  function parseNdjson(body: string): Array<Record<string, unknown>> {
    return body
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => JSON.parse(l) as Record<string, unknown>);
  }

  it('returns 200 with empty body when memory directory does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.body.trim()).toBe('');
  });

  it('does NOT set a wildcard Access-Control-Allow-Origin header (security: scoped to localhost)', async () => {
    // A wildcard CORS header on this endpoint would expose raw agent memory to
    // any origin.  The fix scopes the header to a specific localhost origin.
    // This test guards against regression to '*'.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/memory/stream',
      headers: { origin: 'http://localhost:4751' },
    });
    expect(res.statusCode).toBe(200);
    const corsHeader = res.headers['access-control-allow-origin'];
    expect(corsHeader).toBeDefined();
    expect(corsHeader).not.toBe('*');
    // Must be scoped to a specific localhost origin
    expect(typeof corsHeader).toBe('string');
    expect((corsHeader as string)).toMatch(/^https?:\/\/localhost(:\d+)?$/);
  });

  it('reflects the request localhost origin in Access-Control-Allow-Origin', async () => {
    // When the request comes from a localhost origin (e.g. Vite dev server on
    // port 4751), the response should reflect that exact origin back so the
    // browser treats it as a valid CORS response.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/memory/stream',
      headers: { origin: 'http://localhost:4751' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4751');
  });

  it('streams entries from .jsonl files as NDJSON', async () => {
    appendJsonlEntry('cycle-outcome', {
      id: 'stream-001',
      value: JSON.stringify({ sprintVersion: '10.0.0', stage: 'completed' }),
      source: 'cycle-abc',
      tags: ['cycle'],
      createdAt: '2026-04-08T10:00:00.000Z',
    });
    appendJsonlEntry('gate-verdict', {
      id: 'stream-002',
      value: 'APPROVE',
      source: 'cycle-abc',
      createdAt: '2026-04-08T10:01:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');

    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(2);

    const ids = entries.map(e => e['id']);
    expect(ids).toContain('stream-001');
    expect(ids).toContain('stream-002');
  });

  it('?type filter narrows the stream to matching entries only', async () => {
    appendJsonlEntry('cycle-outcome',  { id: 'co-1', value: 'x', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('gate-verdict',   { id: 'gv-1', value: 'y', createdAt: '2026-04-08T10:01:00.000Z' });
    appendJsonlEntry('review-finding', { id: 'rf-1', value: 'z', createdAt: '2026-04-08T10:02:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream?type=gate-verdict' });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!['id']).toBe('gv-1');
  });

  it('?search filter applies case-insensitive substring match', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'needle-match', value: 'contains-NEEDLE-word', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'no-match',     value: 'unrelated-content',   createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream?search=needle' });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!['id']).toBe('needle-match');
  });

  it('?agentId filters by source field', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'agent-a', value: 'x', source: 'agent-alpha', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'agent-b', value: 'y', source: 'agent-beta',  createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream?agentId=agent-alpha' });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!['id']).toBe('agent-a');
  });

  it('?agent (legacy alias) filters the same as ?agentId', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'legacy-match', value: 'x', source: 'agent-legacy', createdAt: '2026-04-08T10:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'other',        value: 'y', source: 'other',         createdAt: '2026-04-08T10:01:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream?agent=agent-legacy' });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!['id']).toBe('legacy-match');
  });

  it('?since filters entries by createdAt timestamp', async () => {
    appendJsonlEntry('cycle-outcome', { id: 'old', value: 'x', createdAt: '2026-04-01T00:00:00.000Z' });
    appendJsonlEntry('cycle-outcome', { id: 'new', value: 'y', createdAt: '2026-04-10T00:00:00.000Z' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/memory/stream?since=2026-04-05T00:00:00.000Z',
    });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);
    expect(entries[0]!['id']).toBe('new');
  });

  it('each streamed line is a valid JSON object with required fields', async () => {
    appendJsonlEntry('learned-fact', {
      id: 'lf-001',
      value: 'Test values always cover edge cases.',
      source: 'agent-reviewer',
      tags: ['lesson', 'testing'],
      createdAt: '2026-04-08T12:00:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: '/api/v5/memory/stream' });
    const entries = parseNdjson(res.body);
    expect(entries.length).toBe(1);

    const entry = entries[0]!;
    expect(typeof entry['id']).toBe('string');
    expect(typeof entry['key']).toBe('string');
    expect(typeof entry['type']).toBe('string');
    expect(typeof entry['createdAt']).toBe('string');
    // source and agentId must both be set when source is present
    expect(entry['source']).toBe('agent-reviewer');
    expect(entry['agentId']).toBe('agent-reviewer');
    // tags must be forwarded
    expect(entry['tags']).toEqual(['lesson', 'testing']);
  });
});
