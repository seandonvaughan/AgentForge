/**
 * Tests for /api/v5/quality/* endpoints.
 *
 * Uses in-memory fixture data injected via a temp JSONL file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qualityRoutes } from '../../../packages/server/src/routes/v5/quality.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `quality-test-${process.pid}`);
const MEMORY_DIR = join(TMP_ROOT, '.agentforge', 'memory');
const STEP_SCORES_FILE = join(MEMORY_DIR, 'step-scores.jsonl');

function setupFixtures(rows: object[]): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(STEP_SCORES_FILE, rows.map(r => JSON.stringify(r)).join('\n'));
}

function teardownFixtures(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Sample rows
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

// Build ≥10 rows each for agent1 with-skill and without-skill for effectiveness test
const withSkillRows = Array.from({ length: 12 }, (_, i) => ({
  id: `ws-${i}`,
  cycle_id: 'cycle-abc',
  agent_id: 'agent1',
  skill_id: 'af-tdd',
  model: 'sonnet',
  quality_score: 0.9,
  cost_usd: 0.01,
  created_at: now,
}));

const withoutSkillRows = Array.from({ length: 12 }, (_, i) => ({
  id: `wo-${i}`,
  cycle_id: 'cycle-abc',
  agent_id: 'agent1',
  skill_id: 'other-skill',
  model: 'haiku',
  quality_score: 0.6,
  cost_usd: 0.005,
  created_at: now,
}));

const allFixtureRows = [
  ...withSkillRows,
  ...withoutSkillRows,
  // An old row outside 7d window
  {
    id: 'old-1',
    cycle_id: 'cycle-old',
    agent_id: 'agent2',
    skill_id: 'af-tdd',
    model: 'opus',
    quality_score: 0.7,
    cost_usd: 0.02,
    created_at: tenDaysAgo,
  },
  // A row from yesterday for the since filter test
  {
    id: 'yest-1',
    cycle_id: 'cycle-abc',
    agent_id: 'agent1',
    skill_id: 'af-tdd',
    model: 'sonnet',
    quality_score: 0.85,
    cost_usd: 0.01,
    created_at: yesterday,
  },
];

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('/api/v5/quality/*', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    setupFixtures(allFixtureRows);
    app = Fastify({ logger: false });
    await app.register(qualityRoutes, { projectRoot: TMP_ROOT });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    teardownFixtures();
  });

  // ── step-scores ──────────────────────────────────────────────────────────

  it('GET /api/v5/quality/step-scores returns data array and meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/step-scores' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number; truncated: boolean } }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.meta.total).toBe('number');
    expect(typeof body.meta.truncated).toBe('boolean');
    expect(body.meta.truncated).toBe(false);
  });

  it('GET /api/v5/quality/step-scores returns all rows', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/step-scores?limit=500' });
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.meta.total).toBe(allFixtureRows.length);
  });

  it('GET /api/v5/quality/step-scores filters by agent_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/step-scores?agent_id=agent2' });
    const body = res.json<{ data: Array<{ agent_id: string }> }>();
    expect(body.data.every(r => r.agent_id === 'agent2')).toBe(true);
  });

  it('GET /api/v5/quality/step-scores filters by skill_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/step-scores?skill_id=af-tdd' });
    const body = res.json<{ data: Array<{ skill_id: string }> }>();
    expect(body.data.every(r => r.skill_id.includes('af-tdd'))).toBe(true);
  });

  it('GET /api/v5/quality/step-scores filters by cycle_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/step-scores?cycle_id=cycle-abc' });
    const body = res.json<{ data: Array<{ cycle_id: string }> }>();
    expect(body.data.every(r => r.cycle_id === 'cycle-abc')).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('GET /api/v5/quality/step-scores filters by since', async () => {
    // since=now means only rows with created_at >= now
    const res = await app.inject({ method: 'GET', url: `/api/v5/quality/step-scores?since=${encodeURIComponent(now)}` });
    const body = res.json<{ data: Array<{ created_at: string }> }>();
    // Only the rows with created_at == now should be returned
    expect(body.data.every(r => r.created_at >= now)).toBe(true);
  });

  it('GET /api/v5/quality/step-scores skips malformed lines', async () => {
    // Append a bad line to the file and re-create server
    const app2 = Fastify({ logger: false });
    const tmpRoot2 = join(tmpdir(), `quality-test-malformed-${process.pid}`);
    const memDir2 = join(tmpRoot2, '.agentforge', 'memory');
    mkdirSync(memDir2, { recursive: true });
    writeFileSync(
      join(memDir2, 'step-scores.jsonl'),
      '{"id":"good","agent_id":"x","quality_score":0.8,"created_at":"2024-01-01T00:00:00.000Z"}\n{BADJSON\n',
    );
    await app2.register(qualityRoutes, { projectRoot: tmpRoot2 });
    await app2.ready();
    const res = await app2.inject({ method: 'GET', url: '/api/v5/quality/step-scores' });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBe(1);
    await app2.close();
    rmSync(tmpRoot2, { recursive: true, force: true });
  });

  it('GET /api/v5/quality/step-scores returns empty when file missing', async () => {
    const emptyRoot = join(tmpdir(), `quality-test-empty-${process.pid}`);
    mkdirSync(emptyRoot, { recursive: true });
    const app3 = Fastify({ logger: false });
    await app3.register(qualityRoutes, { projectRoot: emptyRoot });
    await app3.ready();
    const res = await app3.inject({ method: 'GET', url: '/api/v5/quality/step-scores' });
    const body = res.json<{ data: unknown[] }>();
    expect(body.data.length).toBe(0);
    await app3.close();
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  // ── aggregates ───────────────────────────────────────────────────────────

  it('GET /api/v5/quality/aggregates returns by_agent, by_skill, by_model', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/aggregates?window=7d' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      by_agent: unknown[];
      by_skill: unknown[];
      by_model: unknown[];
      meta: { window: string };
    }>();
    expect(Array.isArray(body.by_agent)).toBe(true);
    expect(Array.isArray(body.by_skill)).toBe(true);
    expect(Array.isArray(body.by_model)).toBe(true);
    expect(body.meta.window).toBe('7d');
  });

  it('GET /api/v5/quality/aggregates respects window filter (30d includes old rows)', async () => {
    const res7d = await app.inject({ method: 'GET', url: '/api/v5/quality/aggregates?window=7d' });
    const res30d = await app.inject({ method: 'GET', url: '/api/v5/quality/aggregates?window=30d' });
    const body7 = res7d.json<{ meta: { total_rows: number } }>();
    const body30 = res30d.json<{ meta: { total_rows: number } }>();
    // 30d window should include the 10-day-old row
    expect(body30.meta.total_rows).toBeGreaterThan(body7.meta.total_rows);
  });

  it('GET /api/v5/quality/aggregates defaults to 7d window', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/aggregates' });
    const body = res.json<{ meta: { window: string } }>();
    expect(body.meta.window).toBe('7d');
  });

  // ── skill-effectiveness ──────────────────────────────────────────────────

  it('GET /api/v5/quality/skill-effectiveness requires skill_id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/skill-effectiveness' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/v5/quality/skill-effectiveness returns paired comparison', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/skill-effectiveness?skill_id=af-tdd&window=30d' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      skill_id: string;
      agents: Array<{
        agent_id: string;
        mean_quality_with: number;
        mean_quality_without: number;
        delta: number;
      }>;
    }>();
    expect(body.skill_id).toBe('af-tdd');
    expect(Array.isArray(body.agents)).toBe(true);
    // agent1 has ≥10 with and ≥10 without in 30d window
    const agent1 = body.agents.find(a => a.agent_id === 'agent1');
    expect(agent1).toBeDefined();
    expect(agent1!.mean_quality_with).toBeCloseTo(0.9, 1);
    expect(agent1!.mean_quality_without).toBeCloseTo(0.6, 1);
    expect(agent1!.delta).toBeGreaterThan(0);
  });

  it('GET /api/v5/quality/skill-effectiveness excludes agents with <10 samples', async () => {
    // agent2 only has 1 old row — should not appear even in 30d window
    const res = await app.inject({ method: 'GET', url: '/api/v5/quality/skill-effectiveness?skill_id=af-tdd&window=30d' });
    const body = res.json<{ agents: Array<{ agent_id: string }> }>();
    const agent2 = body.agents.find(a => a.agent_id === 'agent2');
    expect(agent2).toBeUndefined();
  });
});
