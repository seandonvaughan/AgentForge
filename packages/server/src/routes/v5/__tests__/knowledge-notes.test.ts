/**
 * Tests for GET /api/v5/knowledge/notes — v25 paginated full-text note feed.
 *
 * Notes (entities with properties.kind === 'note') are the useful knowledge
 * artifacts written by epic reviews, agent LEARNED notes, and legacy
 * audit/review phases. The route must:
 *   - return ONLY note entities (term-entity soup is excluded)
 *   - sort newest first
 *   - paginate via ?limit= / ?offset= (default 50)
 *   - shape rows as { id, content, source, tags, createdAt }
 *   - re-read entities.jsonl per request (cycles write from another process)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knowledgeRoutes } from '../knowledge.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-kn-notes-'));
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function buildApp(withProjectRoot = true): Promise<void> {
  app = Fastify({ logger: false });
  await knowledgeRoutes(app, withProjectRoot ? { projectRoot: tmpRoot } : {});
  await app.ready();
}

function entitiesFile(): string {
  return join(tmpRoot, '.agentforge', 'knowledge', 'entities.jsonl');
}

function writeEntityLine(entity: Record<string, unknown>): void {
  mkdirSync(join(tmpRoot, '.agentforge', 'knowledge'), { recursive: true });
  appendFileSync(entitiesFile(), JSON.stringify(entity) + '\n', 'utf8');
}

function noteEntity(
  id: string,
  description: string,
  createdAt: string,
  source = 'epic-review',
  tags: string[] = [],
): Record<string, unknown> {
  return {
    id,
    name: description.split(' ').slice(0, 8).join(' '),
    type: 'concept',
    description,
    properties: { kind: 'note', source, tags },
    createdAt,
    updatedAt: createdAt,
  };
}

function termEntity(id: string, name: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    name,
    type: 'module',
    properties: { source: 'audit' },
    createdAt,
    updatedAt: createdAt,
  };
}

describe('GET /api/v5/knowledge/notes', () => {
  it('returns an empty page when no entities exist', async () => {
    await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { total: number; limit: number; offset: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
    expect(body.meta.limit).toBe(50);
    expect(body.meta.offset).toBe(0);
  });

  it('returns ONLY kind:note entities — term entities are excluded', async () => {
    writeEntityLine(noteEntity('n1', 'The epic satisfies the operator objective.', '2026-06-01T00:00:00Z'));
    writeEntityLine(termEntity('t1', 'KnowledgeGraph', '2026-06-02T00:00:00Z'));
    writeEntityLine(termEntity('t2', 'EntityExtractor', '2026-06-03T00:00:00Z'));
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data.map(n => n.id)).toEqual(['n1']);
  });

  it('shapes rows as {id, content, source, tags, createdAt} with content from description', async () => {
    writeEntityLine(noteEntity(
      'n1',
      'Use conditional spreads under exactOptionalPropertyTypes.',
      '2026-06-01T00:00:00Z',
      'agent-learned',
      ['coder', 'cycle-1'],
    ));
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toEqual({
      id: 'n1',
      content: 'Use conditional spreads under exactOptionalPropertyTypes.',
      source: 'agent-learned',
      tags: ['coder', 'cycle-1'],
      createdAt: '2026-06-01T00:00:00Z',
    });
  });

  it('sorts notes newest first', async () => {
    writeEntityLine(noteEntity('old', 'An older epic review rationale here.', '2026-05-01T00:00:00Z'));
    writeEntityLine(noteEntity('new', 'A newer epic review rationale here.', '2026-06-01T00:00:00Z'));
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map(n => n.id)).toEqual(['new', 'old']);
  });

  it('paginates with limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      writeEntityLine(noteEntity(
        `n${i}`,
        `Note number ${i} with enough text to matter.`,
        `2026-06-0${i + 1}T00:00:00Z`,
      ));
    }
    await buildApp();

    const page1 = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes?limit=2&offset=0' });
    const body1 = JSON.parse(page1.body) as { data: Array<{ id: string }>; meta: { total: number; limit: number; offset: number } };
    expect(body1.data.map(n => n.id)).toEqual(['n4', 'n3']);
    expect(body1.meta.total).toBe(5);
    expect(body1.meta.limit).toBe(2);

    const page2 = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes?limit=2&offset=2' });
    const body2 = JSON.parse(page2.body) as { data: Array<{ id: string }>; meta: { offset: number } };
    expect(body2.data.map(n => n.id)).toEqual(['n2', 'n1']);
    expect(body2.meta.offset).toBe(2);
  });

  it('falls back to defaults for invalid limit/offset values', async () => {
    writeEntityLine(noteEntity('n1', 'A note with enough text in the body.', '2026-06-01T00:00:00Z'));
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes?limit=banana&offset=-3' });
    const body = JSON.parse(res.body) as { data: unknown[]; meta: { limit: number; offset: number } };
    expect(body.meta.limit).toBe(50);
    expect(body.meta.offset).toBe(0);
  });

  it('reflects notes appended AFTER server startup (fresh disk read per request)', async () => {
    writeEntityLine(noteEntity('n1', 'Present at startup with enough text.', '2026-06-01T00:00:00Z'));
    await buildApp();

    // A cycle process appends a note while the server is running.
    writeEntityLine(noteEntity('n2', 'Appended after startup with enough text.', '2026-06-02T00:00:00Z'));

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map(n => n.id)).toEqual(['n2', 'n1']);
  });

  it('serves notes from the in-memory graph when no projectRoot is configured', async () => {
    await buildApp(false);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v5/knowledge/entities',
      payload: {
        name: 'manual note',
        type: 'concept',
        description: 'A manually added note with enough body text.',
        properties: { kind: 'note', source: 'dashboard-user', tags: ['manual'] },
      },
    });
    expect(created.statusCode).toBe(201);

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    const body = JSON.parse(res.body) as { data: Array<Record<string, unknown>>; meta: { total: number } };
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!['content']).toBe('A manually added note with enough body text.');
    expect(body.data[0]!['source']).toBe('dashboard-user');
  });

  it('skips malformed entities.jsonl lines without failing the request', async () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'knowledge'), { recursive: true });
    writeFileSync(
      entitiesFile(),
      'NOT JSON\n' + JSON.stringify(noteEntity('ok', 'Valid note with enough body text.', '2026-06-01T00:00:00Z')) + '\n',
      'utf8',
    );
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/api/v5/knowledge/notes' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map(n => n.id)).toEqual(['ok']);
  });
});
