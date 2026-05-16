/**
 * Fix 3: GET /api/v5/health/dependencies
 *
 * Tests:
 *   - Happy path: all deps up → response shape correct
 *   - Check function: 401 from Anthropic → status=up
 *   - Check function: connection failure → status=down with error
 *   - Check function: timeout → status=down with timeout error
 *   - Check function: unexpected status code → status=degraded
 *   - Cache: second call within 30s returns same result (no new probes)
 *   - Cache: cache metadata (cached:true/false, cacheAgeMs) correct
 *   - Response data array has correct items (Anthropic, GitHub, npm, Files)
 *   - Each item has required fields: name, url, status, lastCheckTs, latencyMs
 *   - error field present only when not 'up'
 *   - _resetDependencyCache clears cache correctly
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerHealthDependenciesRoutes,
  probeDependency,
  _resetDependencyCache,
  _dependencyCache,
  type FetchFn,
  type DependencyDefinition,
} from '../health-dependencies.js';

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function makeMockFetch(statusCode: number): FetchFn {
  return async (_url, _init) => {
    return { status: statusCode } as Response;
  };
}

function makeFailingFetch(errorMsg: string): FetchFn {
  return async (_url, _init) => {
    throw new Error(errorMsg);
  };
}

function makeAbortingFetch(): FetchFn {
  return async (_url, init) => {
    // Simulate a timeout by waiting for the abort signal
    await new Promise<void>((_resolve, reject) => {
      const err = new DOMException('The operation was aborted.', 'AbortError');
      // Immediately abort to simulate timeout
      reject(err);
    });
    // unreachable but needed for types
    return { status: 200 } as Response;
  };
}

const ANTHROPIC_DEF: DependencyDefinition = {
  name: 'Anthropic API',
  url: 'https://api.anthropic.com/v1/messages',
  method: 'HEAD',
  upStatusCodes: new Set([200, 401, 403, 405]),
};

const GITHUB_DEF: DependencyDefinition = {
  name: 'GitHub API',
  url: 'https://api.github.com',
  method: 'HEAD',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let capturedProbes: string[] = [];

beforeEach(async () => {
  _resetDependencyCache();
  capturedProbes = [];
});

afterEach(async () => {
  if (app) await app.close();
  _resetDependencyCache();
});

async function buildApp(fetchFn: FetchFn): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  registerHealthDependenciesRoutes(a, { fetchFn });
  await a.ready();
  return a;
}

// ---------------------------------------------------------------------------
// probeDependency unit tests (pure function, no Fastify needed)
// ---------------------------------------------------------------------------

describe('probeDependency()', () => {
  it('returns status=up when HTTP 401 from Anthropic (unauthenticated probe)', async () => {
    const result = await probeDependency(ANTHROPIC_DEF, makeMockFetch(401));
    expect(result.status).toBe('up');
    expect(result.name).toBe('Anthropic API');
    expect(result.url).toBe('https://api.anthropic.com/v1/messages');
    expect(result.error).toBeUndefined();
  });

  it('returns status=up when HTTP 200 from GitHub', async () => {
    const result = await probeDependency(GITHUB_DEF, makeMockFetch(200));
    expect(result.status).toBe('up');
    expect(result.error).toBeUndefined();
  });

  it('returns status=down when connection fails with error message', async () => {
    const result = await probeDependency(GITHUB_DEF, makeFailingFetch('ECONNREFUSED'));
    expect(result.status).toBe('down');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns status=down on AbortError (timeout)', async () => {
    const result = await probeDependency(GITHUB_DEF, makeAbortingFetch());
    expect(result.status).toBe('down');
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('returns status=degraded when HTTP response is unexpected (e.g. 500)', async () => {
    const result = await probeDependency(ANTHROPIC_DEF, makeMockFetch(500));
    expect(result.status).toBe('degraded');
    expect(result.error).toContain('500');
  });

  it('result includes required fields: name, url, status, lastCheckTs, latencyMs', async () => {
    const result = await probeDependency(GITHUB_DEF, makeMockFetch(200));
    expect(typeof result.name).toBe('string');
    expect(typeof result.url).toBe('string');
    expect(['up', 'degraded', 'down']).toContain(result.status);
    expect(typeof result.lastCheckTs).toBe('string');
    expect(() => new Date(result.lastCheckTs)).not.toThrow();
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/health/dependencies — route', () => {
  it('returns 200 with data array and meta', async () => {
    app = await buildApp(makeMockFetch(200));
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{ name: string; url: string; status: string; lastCheckTs: string; latencyMs: number }>;
      meta: { cached: boolean; cacheAgeMs: number; timestamp: string };
    }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(typeof body.meta.cached).toBe('boolean');
    expect(typeof body.meta.cacheAgeMs).toBe('number');
    expect(typeof body.meta.timestamp).toBe('string');
  });

  it('response includes expected dependency names', async () => {
    app = await buildApp(makeMockFetch(200));
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string }> }>();
    const names = body.data.map(d => d.name);
    expect(names).toContain('Anthropic API');
    expect(names).toContain('GitHub API');
    expect(names).toContain('npm Registry');
    expect(names).toContain('Anthropic Files API');
  });

  it('second call within 30s returns cached result (meta.cached=true)', async () => {
    let callCount = 0;
    const countingFetch: FetchFn = async (url, init) => {
      callCount++;
      return { status: 200 } as Response;
    };

    app = await buildApp(countingFetch);
    await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    const callsAfterFirst = callCount;

    const res2 = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res2.statusCode).toBe(200);
    const body = res2.json<{ meta: { cached: boolean; cacheAgeMs: number } }>();
    expect(body.meta.cached).toBe(true);
    // No additional fetches should have been made
    expect(callCount).toBe(callsAfterFirst);
  });

  it('first call has meta.cached=false', async () => {
    app = await buildApp(makeMockFetch(200));
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ meta: { cached: boolean } }>().meta.cached).toBe(false);
  });

  it('_resetDependencyCache clears cache so next call re-fetches', async () => {
    let callCount = 0;
    const countingFetch: FetchFn = async () => {
      callCount++;
      return { status: 200 } as Response;
    };

    app = await buildApp(countingFetch);
    await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    const after1 = callCount;

    _resetDependencyCache();
    await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    // After reset, should have made new fetch calls
    expect(callCount).toBeGreaterThan(after1);
  });

  it('error field is absent when status is up', async () => {
    app = await buildApp(makeMockFetch(401)); // 401 → up for Anthropic
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ name: string; status: string; error?: string }> }>();
    const anthropicDep = body.data.find(d => d.name === 'Anthropic API');
    expect(anthropicDep).toBeDefined();
    expect(anthropicDep!.status).toBe('up');
    expect(anthropicDep!.error).toBeUndefined();
  });

  it('error field is present when status is down', async () => {
    app = await buildApp(makeFailingFetch('network error'));
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/dependencies' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ status: string; error?: string }> }>();
    const downDeps = body.data.filter(d => d.status === 'down');
    expect(downDeps.length).toBeGreaterThan(0);
    for (const dep of downDeps) {
      expect(typeof dep.error).toBe('string');
    }
  });
});
