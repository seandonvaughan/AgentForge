/**
 * tests/v5/search.test.ts — Integration tests for POST /api/v5/search
 *
 * Exercises the unified keyword search endpoint across all five indexed
 * document types: sessions (via adapter), agents (YAML), sprints (JSON),
 * cycles (cycle.json), and memory files (.json / .md / .jsonl).
 *
 * Each test suite uses a temporary project root so real workspace files
 * do not interfere with assertions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createServerV5 } from '../../packages/server/src/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentforge-search-test-'));
  // Create the skeleton .agentforge directory structure the search route reads.
  for (const dir of ['agents', 'sprints', 'cycles', 'memory']) {
    mkdirSync(join(root, '.agentforge', dir), { recursive: true });
  }
  return root;
}

async function buildServer(
  projectRoot: string,
  port: number,
): Promise<FastifyInstance> {
  const { app } = await createServerV5({ port, listen: false, projectRoot });
  await app.ready();
  return app;
}

async function post(app: FastifyInstance, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/v5/search',
    payload: body,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Suite 1: input validation
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — input validation', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();
    app = await buildServer(root, 4860);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 400 when query is absent', async () => {
    const res = await post(app, { limit: 5 });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error');
  });

  it('returns 400 when query is an empty string', async () => {
    const res = await post(app, { query: '   ' });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/query/i);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: response envelope shape
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — response envelope', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();
    app = await buildServer(root, 4861);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 200 for a valid query with no matches', async () => {
    const res = await post(app, { query: 'zzz-no-match-guaranteed' });
    expect(res.statusCode).toBe(200);
  });

  it('response has { data, meta } envelope', async () => {
    const res = await post(app, { query: 'anything' });
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('meta');
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('meta.total equals data.length', async () => {
    const res = await post(app, { query: 'anything' });
    const body = JSON.parse(res.body);
    expect(body.meta.total).toBe(body.data.length);
  });

  it('meta.query echoes the trimmed query string', async () => {
    const res = await post(app, { query: '  hello  ' });
    const body = JSON.parse(res.body);
    expect(body.meta.query).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Suite 3: agent search (reads .agentforge/agents/*.yaml)
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — agent indexing', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();

    // Write two fake agent YAML files
    writeFileSync(
      join(root, '.agentforge/agents/coder.yaml'),
      [
        'name: Coder',
        'role: implementation',
        'model: sonnet',
        'description: Writes and refactors TypeScript code',
      ].join('\n'),
    );

    writeFileSync(
      join(root, '.agentforge/agents/researcher.yaml'),
      [
        'name: Researcher',
        'role: research',
        'model: haiku',
        'description: Gathers information from external sources',
      ].join('\n'),
    );

    app = await buildServer(root, 4862);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds an agent by role keyword', async () => {
    const res = await post(app, { query: 'implementation' });
    const body = JSON.parse(res.body);
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.includes('coder'))).toBe(true);
  });

  it('finds an agent by description keyword', async () => {
    const res = await post(app, { query: 'TypeScript' });
    const body = JSON.parse(res.body);
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.includes('coder'))).toBe(true);
  });

  it('result items for agent type have type === "agent"', async () => {
    const res = await post(app, { query: 'TypeScript' });
    const body = JSON.parse(res.body);
    const agentResults = body.data.filter((r: { type: string }) => r.type === 'agent');
    expect(agentResults.length).toBeGreaterThan(0);
  });

  it('result items include source (agent id)', async () => {
    const res = await post(app, { query: 'TypeScript' });
    const body = JSON.parse(res.body);
    for (const item of body.data) {
      expect(typeof item.source).toBe('string');
      expect(item.source.length).toBeGreaterThan(0);
    }
  });

  it('type filter "agent" restricts results to agents only', async () => {
    const res = await post(app, { query: 'information', types: ['agent'] });
    const body = JSON.parse(res.body);
    for (const item of body.data) {
      expect(item.type).toBe('agent');
    }
  });

  it('type filter "session" returns no results when no sessions exist', async () => {
    const res = await post(app, { query: 'information', types: ['session'] });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBe(0);
  });

  it('score is a number in (0, 1]', async () => {
    const res = await post(app, { query: 'implementation' });
    const body = JSON.parse(res.body);
    for (const item of body.data) {
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });

  it('results are sorted by score descending', async () => {
    const res = await post(app, { query: 'coder implementation TypeScript' });
    const body = JSON.parse(res.body);
    const scores = body.data.map((r: { score: number }) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: sprint search — title must be indexed (regression for v9.0.1 bug)
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — sprint item title indexing', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();

    // Write a sprint file that matches the actual format used in .agentforge/sprints/
    // Items have both `title` and `description` — title was previously not indexed.
    const sprint = {
      sprints: [
        {
          version: '1.0.0',
          phase: 'planned',
          items: [
            {
              id: 'item-1',
              title: 'Fix authentication timeout regression',
              description: 'Session tokens expire too quickly after the v0.9 refactor.',
              status: 'planned',
              tags: ['auth', 'bug'],
            },
            {
              id: 'item-2',
              title: 'Add dark mode toggle to settings page',
              description: 'Users have requested a way to switch to light mode.',
              status: 'completed',
              tags: ['ui', 'settings'],
            },
          ],
        },
      ],
    };

    writeFileSync(
      join(root, '.agentforge/sprints/v1.0.0.json'),
      JSON.stringify(sprint),
    );

    app = await buildServer(root, 4863);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a sprint item by a word unique to its title', async () => {
    // "authentication" appears only in the title, not in description/tags/status.
    const res = await post(app, { query: 'authentication' });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.includes('item-1'))).toBe(true);
  });

  it('finds a sprint item by a word unique to its description', async () => {
    // "tokens" appears only in the description of item-1.
    const res = await post(app, { query: 'tokens' });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.includes('item-1'))).toBe(true);
  });

  it('content field uses title as the primary display text', async () => {
    const res = await post(app, { query: 'dark mode' });
    const body = JSON.parse(res.body);
    const sprintResult = body.data.find((r: { type: string }) => r.type === 'sprint');
    expect(sprintResult).toBeDefined();
    // content should surface the title, not the full search blob
    expect(sprintResult.content).toContain('dark mode');
  });

  it('finds by tag', async () => {
    const res = await post(app, { query: 'settings' });
    const body = JSON.parse(res.body);
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.some((id: string) => id.includes('item-2'))).toBe(true);
  });

  it('result items for sprint type have type === "sprint"', async () => {
    const res = await post(app, { query: 'authentication' });
    const body = JSON.parse(res.body);
    const sprintResults = body.data.filter((r: { type: string }) => r.type === 'sprint');
    expect(sprintResults.length).toBeGreaterThan(0);
  });

  it('metadata includes version and status', async () => {
    const res = await post(app, { query: 'authentication' });
    const body = JSON.parse(res.body);
    const sprintResult = body.data.find((r: { type: string }) => r.type === 'sprint');
    expect(sprintResult.metadata).toHaveProperty('version', '1.0.0');
    expect(sprintResult.metadata).toHaveProperty('status', 'planned');
  });
});

// ---------------------------------------------------------------------------
// Suite 5: memory search (.json, .md, .jsonl)
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — memory file indexing', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();

    writeFileSync(
      join(root, '.agentforge/memory/project-notes.md'),
      '# Project Notes\n\nThe deployment pipeline uses GitHub Actions.\n',
    );

    writeFileSync(
      join(root, '.agentforge/memory/decisions.json'),
      JSON.stringify({ decision: 'Use SQLite for the workspace adapter to minimize ops overhead.' }),
    );

    writeFileSync(
      join(root, '.agentforge/memory/cycle-outcomes.jsonl'),
      [
        JSON.stringify({ id: 'co-1', value: 'Cycle 42 completed with 97% test pass rate' }),
        JSON.stringify({ id: 'co-2', value: 'Gate verdict: approved for v9.0.0 release' }),
      ].join('\n'),
    );

    app = await buildServer(root, 4864);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a markdown memory file by keyword', async () => {
    const res = await post(app, { query: 'GitHub Actions' });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeGreaterThan(0);
    const memoryResult = body.data.find((r: { type: string }) => r.type === 'memory');
    expect(memoryResult).toBeDefined();
  });

  it('finds a JSON memory file by keyword', async () => {
    const res = await post(app, { query: 'SQLite' });
    const body = JSON.parse(res.body);
    const memoryResult = body.data.find((r: { type: string }) => r.type === 'memory');
    expect(memoryResult).toBeDefined();
  });

  it('finds individual .jsonl lines independently', async () => {
    // "approved" only appears in the second JSONL line
    const res = await post(app, { query: 'approved' });
    const body = JSON.parse(res.body);
    const memoryResult = body.data.find(
      (r: { type: string; id: string }) => r.type === 'memory' && r.id.includes('co-2'),
    );
    expect(memoryResult).toBeDefined();
  });

  it('type filter "memory" restricts to memory results', async () => {
    const res = await post(app, { query: 'cycle', types: ['memory'] });
    const body = JSON.parse(res.body);
    for (const item of body.data) {
      expect(item.type).toBe('memory');
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 6: cycle search (reads .agentforge/cycles/*/cycle.json)
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — cycle indexing', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();

    // Create a cycle directory with a cycle.json
    const cycleId = 'test-cycle-abc123';
    mkdirSync(join(root, '.agentforge/cycles', cycleId), { recursive: true });
    writeFileSync(
      join(root, '.agentforge/cycles', cycleId, 'cycle.json'),
      JSON.stringify({
        cycleId,
        sprintVersion: '2.0.0',
        stage: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        pr: { url: 'https://github.com/org/repo/pull/77', number: 77 },
      }),
    );

    app = await buildServer(root, 4865);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a cycle by its sprint version', async () => {
    const res = await post(app, { query: '2.0.0' });
    const body = JSON.parse(res.body);
    const cycleResult = body.data.find((r: { type: string }) => r.type === 'cycle');
    expect(cycleResult).toBeDefined();
  });

  it('finds a cycle by its stage', async () => {
    const res = await post(app, { query: 'completed' });
    const body = JSON.parse(res.body);
    const cycleResult = body.data.find((r: { type: string }) => r.type === 'cycle');
    expect(cycleResult).toBeDefined();
  });

  it('cycle result metadata includes stage and sprintVersion', async () => {
    const res = await post(app, { query: '2.0.0' });
    const body = JSON.parse(res.body);
    const cycleResult = body.data.find((r: { type: string }) => r.type === 'cycle');
    expect(cycleResult.metadata).toHaveProperty('stage', 'completed');
    expect(cycleResult.metadata).toHaveProperty('sprintVersion', '2.0.0');
  });

  it('type filter "cycle" restricts results to cycles only', async () => {
    const res = await post(app, { query: 'completed', types: ['cycle'] });
    const body = JSON.parse(res.body);
    for (const item of body.data) {
      expect(item.type).toBe('cycle');
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 7: limit parameter
// ---------------------------------------------------------------------------

describe('POST /api/v5/search — limit parameter', () => {
  let app: FastifyInstance;
  let root: string;

  beforeAll(async () => {
    root = makeTmpRoot();

    // Write 5 agents so we have plenty of results
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(root, `.agentforge/agents/worker-${i}.yaml`),
        `name: Worker ${i}\nrole: executor\nmodel: haiku\ndescription: Generic worker agent number ${i}`,
      );
    }

    app = await buildServer(root, 4866);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('honours limit=2 and returns at most 2 results', async () => {
    const res = await post(app, { query: 'executor', limit: 2 });
    const body = JSON.parse(res.body);
    expect(body.data.length).toBeLessThanOrEqual(2);
  });

  it('returns all results when limit is larger than result count', async () => {
    const res = await post(app, { query: 'executor', limit: 100 });
    const body = JSON.parse(res.body);
    // 5 agents match "executor"
    expect(body.data.length).toBe(5);
  });
});
