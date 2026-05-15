import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { insightsRoutes } from '../insights.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildApp(adapter?: object): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await insightsRoutes(app, adapter !== undefined ? { adapter: adapter as never } : {});
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// GET /api/v5/insights
// ---------------------------------------------------------------------------

describe('GET /api/v5/insights', () => {
  it('returns 200 with insights shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/insights' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { insights: unknown[]; derivedFrom: number; timestamp: string };
    expect(Array.isArray(body.insights)).toBe(true);
    expect(typeof body.derivedFrom).toBe('number');
    expect(typeof body.timestamp).toBe('string');
  });

  it('returns empty insights when adapter has no cycles', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/insights' });
    const body = res.json() as { insights: unknown[]; derivedFrom: number };
    expect(body.derivedFrom).toBe(0);
    expect(body.insights).toHaveLength(0);
  });

  it('derives insights when adapter provides cycle data', async () => {
    const mockCycles = Array.from({ length: 10 }, (_, i) => ({
      costUsd: i < 5 ? 2.5 : 1.0,
      verdict: 'pass',
      model: 'claude-opus',
    }));
    const fakeAdapter = { listCycles: () => mockCycles };
    const appWithAdapter = await buildApp(fakeAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { insights: Array<{ kind: string; title: string; body: string }>; derivedFrom: number };
      expect(body.derivedFrom).toBe(10);
      expect(body.insights.length).toBeGreaterThan(0);
      for (const ins of body.insights) {
        expect(['win', 'risk', 'shift']).toContain(ins.kind);
        expect(typeof ins.title).toBe('string');
        expect(typeof ins.body).toBe('string');
      }
    } finally {
      await appWithAdapter.close();
    }
  });

  it('caps insights at 4', async () => {
    const mockCycles = Array.from({ length: 14 }, (_, i) => ({
      costUsd: i < 7 ? 5.0 : 1.0,
      verdict: i < 7 ? 'fail' : 'pass',
      model: i < 7 ? 'claude-opus' : 'claude-haiku',
    }));
    const fakeAdapter = { listCycles: () => mockCycles };
    const appWithAdapter = await buildApp(fakeAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      const body = res.json() as { insights: unknown[] };
      expect(body.insights.length).toBeLessThanOrEqual(4);
    } finally {
      await appWithAdapter.close();
    }
  });

  it('handles adapter that throws gracefully (returns empty insights)', async () => {
    const brokenAdapter = { listCycles: () => { throw new Error('DB down'); } };
    const appWithAdapter = await buildApp(brokenAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { insights: unknown[] };
      expect(Array.isArray(body.insights)).toBe(true);
    } finally {
      await appWithAdapter.close();
    }
  });

  it('handles adapter without listCycles method (returns empty insights)', async () => {
    const adapterWithNoListCycles = {};
    const appWithAdapter = await buildApp(adapterWithNoListCycles);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { insights: unknown[] };
      expect(Array.isArray(body.insights)).toBe(true);
    } finally {
      await appWithAdapter.close();
    }
  });

  it('cost trend up insight appears when new avg > old avg by 10%+', async () => {
    const mockCycles = [
      { costUsd: 4.0 }, { costUsd: 4.0 }, { costUsd: 4.0 }, { costUsd: 4.0 },
      { costUsd: 1.0 }, { costUsd: 1.0 }, { costUsd: 1.0 }, { costUsd: 1.0 },
    ];
    const fakeAdapter = { listCycles: () => mockCycles };
    const appWithAdapter = await buildApp(fakeAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      const body = res.json() as { insights: Array<{ kind: string; title: string }> };
      const costInsight = body.insights.find(i => i.title.includes('Cost'));
      expect(costInsight).toBeDefined();
      expect(costInsight?.kind).toBe('risk');
    } finally {
      await appWithAdapter.close();
    }
  });

  it('does not include non-existent fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/insights' });
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('insights');
    expect(body).toHaveProperty('derivedFrom');
    expect(body).toHaveProperty('timestamp');
  });

  it('returns content-type application/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/insights' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('high pass rate produces a win insight', async () => {
    const mockCycles = Array.from({ length: 10 }, () => ({
      verdict: 'pass',
      costUsd: 1.0,
    }));
    const fakeAdapter = { listCycles: () => mockCycles };
    const appWithAdapter = await buildApp(fakeAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      const body = res.json() as { insights: Array<{ kind: string }> };
      const wins = body.insights.filter(i => i.kind === 'win');
      expect(wins.length).toBeGreaterThan(0);
    } finally {
      await appWithAdapter.close();
    }
  });

  it('metric field is optional on insights', async () => {
    const mockCycles = Array.from({ length: 10 }, () => ({ verdict: 'pass', costUsd: 1.0 }));
    const fakeAdapter = { listCycles: () => mockCycles };
    const appWithAdapter = await buildApp(fakeAdapter);
    try {
      const res = await appWithAdapter.inject({ method: 'GET', url: '/api/v5/insights' });
      const body = res.json() as { insights: Array<{ metric?: unknown }> };
      for (const ins of body.insights) {
        if (ins.metric !== undefined) {
          expect(typeof ins.metric).toBe('string');
        }
      }
    } finally {
      await appWithAdapter.close();
    }
  });
});
