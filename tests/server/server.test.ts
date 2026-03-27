import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/server/server.js';
import type { FastifyInstance } from 'fastify';

// Ensure logger is disabled during tests
process.env.NODE_ENV = 'test';

describe('Fastify Server', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const result = await createServer({ port: 4700 });
    app = result.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/health', () => {
    it('returns status ok', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
    });

    it('returns version field', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      const body = response.json();
      expect(body.version).toMatch(/\d+\.\d+\.\d+/);
    });

    it('returns timestamp field as ISO string', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      const body = response.json();
      expect(body.timestamp).toBeDefined();
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });

    it('returns content-type application/json', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
      });
      expect(response.headers['content-type']).toMatch(/application\/json/);
    });
  });

  describe('404 handling', () => {
    it('returns 404 JSON for unknown API routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/unknown-route',
      });
      expect(response.statusCode).toBe(404);
    });

    it('returns error JSON body for unknown API routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/unknown-route',
      });
      const body = response.json();
      expect(body.error).toBe('Not found');
      expect(body.path).toBe('/api/v1/unknown-route');
    });

    it('returns 404 with path in body for nested API routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v2/some/deep/route',
      });
      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.path).toBe('/api/v2/some/deep/route');
    });
  });

  describe('CORS', () => {
    it('includes CORS headers for allowed origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: {
          origin: 'http://localhost:4700',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4700');
    });

    it('includes CORS headers for 127.0.0.1 origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: {
          origin: 'http://127.0.0.1:4700',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:4700');
    });
  });

  describe('Server lifecycle', () => {
    it('server can be created and closed cleanly', async () => {
      const { app: testApp } = await createServer({ port: 4701 });
      await testApp.ready();
      await expect(testApp.close()).resolves.not.toThrow();
    });

    it('createServer returns port and host with defaults', async () => {
      const result = await createServer();
      expect(result.port).toBe(4700);
      expect(result.host).toBe('127.0.0.1');
      await result.app.close();
    });

    it('createServer respects custom port option', async () => {
      const result = await createServer({ port: 4702 });
      expect(result.port).toBe(4702);
      await result.app.close();
    });

    it('createServer respects custom host option', async () => {
      const result = await createServer({ host: '0.0.0.0' });
      expect(result.host).toBe('0.0.0.0');
      await result.app.close();
    });
  });

  describe('SPA catch-all', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'agentforge-test-'));
      writeFileSync(join(tmpDir, 'index.html'), '<html><body>AgentForge</body></html>');
    });

    it('returns 200 with HTML content for /', async () => {
      const { app: testApp } = await createServer({ dashboardPath: tmpDir });
      await testApp.ready();
      const res = await testApp.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('AgentForge');
      await testApp.close();
    });

    it('returns 200 with HTML content for /settings', async () => {
      const { app: testApp } = await createServer({ dashboardPath: tmpDir });
      await testApp.ready();
      const res = await testApp.inject({ method: 'GET', url: '/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('AgentForge');
      await testApp.close();
    });

    it('returns 200 with HTML content for /runs/:id', async () => {
      const { app: testApp } = await createServer({ dashboardPath: tmpDir });
      await testApp.ready();
      const res = await testApp.inject({ method: 'GET', url: '/runs/some-run-id' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('AgentForge');
      await testApp.close();
    });
  });
});
