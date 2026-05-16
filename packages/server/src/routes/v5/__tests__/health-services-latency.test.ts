/**
 * Fix 2: GET /api/v5/health/services — latencyHistory[] extension
 *
 * Tests:
 *   - latencyHistory is present in each service object in the response
 *   - latencyHistory starts empty (no samples yet)
 *   - recordLatencySample adds entries to the buffer
 *   - buffer is capped at 60 samples (doesn't grow unbounded)
 *   - samples are returned in insertion order
 *   - getLatencyHistory returns a copy (not the internal array)
 *   - multiple services have independent buffers
 *   - _resetLatencyBuffers clears all buffers
 *   - response shape is correct (status, healthyCount, degradedCount, services, timestamp)
 *   - KNOWN_SERVICES appear even before any calls recorded
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerHealthServicesRoutes,
  recordLatencySample,
  getLatencyHistory,
  _resetLatencyBuffers,
  _latencyBuffers,
  healthMonitor,
} from '../health-services.js';

let app: FastifyInstance;

beforeEach(async () => {
  _resetLatencyBuffers();
  healthMonitor.resetAll();
  app = Fastify({ logger: false });
  registerHealthServicesRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  _resetLatencyBuffers();
  healthMonitor.resetAll();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/health/services — latencyHistory', () => {
  it('response includes latencyHistory for each service', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/services' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ services: Array<{ service: string; latencyHistory: unknown }> }>();
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services.length).toBeGreaterThan(0);
    for (const svc of body.services) {
      expect(Array.isArray(svc.latencyHistory)).toBe(true);
    }
  });

  it('latencyHistory is empty when no samples recorded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/services' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ services: Array<{ service: string; latencyHistory: number[] }> }>();
    const anthSvc = body.services.find(s => s.service === 'anthropic');
    expect(anthSvc).toBeDefined();
    expect(anthSvc!.latencyHistory).toEqual([]);
  });

  it('recordLatencySample adds entries to the buffer', () => {
    recordLatencySample('anthropic', 42);
    recordLatencySample('anthropic', 87);
    const hist = getLatencyHistory('anthropic');
    expect(hist).toHaveLength(2);
    expect(hist[0]).toBe(42);
    expect(hist[1]).toBe(87);
  });

  it('latencyHistory samples appear in response after recording', async () => {
    recordLatencySample('anthropic', 100);
    recordLatencySample('anthropic', 200);

    const res = await app.inject({ method: 'GET', url: '/api/v5/health/services' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ services: Array<{ service: string; latencyHistory: number[] }> }>();
    const anthSvc = body.services.find(s => s.service === 'anthropic');
    expect(anthSvc).toBeDefined();
    expect(anthSvc!.latencyHistory).toEqual([100, 200]);
  });

  it('buffer is capped at 60 samples and does not grow unbounded', () => {
    for (let i = 0; i < 80; i++) {
      recordLatencySample('database', i * 10);
    }
    const hist = getLatencyHistory('database');
    expect(hist).toHaveLength(60);
    // Should keep the LAST 60 samples (newest)
    expect(hist[0]).toBe(20 * 10); // 21st sample (0-indexed 20) = 200
    expect(hist[59]).toBe(79 * 10); // last sample = 790
  });

  it('samples are returned in insertion order', () => {
    recordLatencySample('embeddings', 5);
    recordLatencySample('embeddings', 15);
    recordLatencySample('embeddings', 25);
    const hist = getLatencyHistory('embeddings');
    expect(hist).toEqual([5, 15, 25]);
  });

  it('getLatencyHistory returns a copy, not the internal array', () => {
    recordLatencySample('git', 100);
    const hist = getLatencyHistory('git');
    hist.push(999); // mutate the copy
    const hist2 = getLatencyHistory('git');
    expect(hist2).toHaveLength(1); // internal not mutated
    expect(hist2[0]).toBe(100);
  });

  it('multiple services have independent buffers', () => {
    recordLatencySample('anthropic', 10);
    recordLatencySample('anthropic', 20);
    recordLatencySample('database', 50);

    expect(getLatencyHistory('anthropic')).toEqual([10, 20]);
    expect(getLatencyHistory('database')).toEqual([50]);
    expect(getLatencyHistory('embeddings')).toEqual([]);
  });

  it('_resetLatencyBuffers clears all buffers', () => {
    recordLatencySample('anthropic', 100);
    recordLatencySample('database', 200);
    _resetLatencyBuffers();
    expect(_latencyBuffers.size).toBe(0);
    expect(getLatencyHistory('anthropic')).toEqual([]);
    expect(getLatencyHistory('database')).toEqual([]);
  });

  it('KNOWN_SERVICES appear in response even with no calls recorded', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/services' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ services: Array<{ service: string }> }>();
    const names = body.services.map(s => s.service);
    expect(names).toContain('anthropic');
    expect(names).toContain('database');
    expect(names).toContain('embeddings');
    expect(names).toContain('git');
    expect(names).toContain('federation');
  });

  it('response has correct top-level shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/health/services' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      status: string;
      healthyCount: number;
      degradedCount: number;
      services: unknown[];
      timestamp: string;
    }>();
    expect(typeof body.status).toBe('string');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
    expect(typeof body.healthyCount).toBe('number');
    expect(typeof body.degradedCount).toBe('number');
    expect(Array.isArray(body.services)).toBe(true);
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp)).not.toThrow();
  });
});
