import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerV5 } from '../server.js';

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

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function headerValue(headers: Record<string, string | string[] | number | undefined>, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
}

function expectSecurityHeaders(headers: Record<string, string | string[] | number | undefined>): void {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(headerValue(headers, 'permissions-policy')).toContain('camera=()');
  expect(headerValue(headers, 'permissions-policy')).toContain('microphone=()');

  const csp = headerValue(headers, 'content-security-policy');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).toContain('http://localhost:*');
  expect(csp).toContain('ws://127.0.0.1:*');
}

describe('createServerV5 security headers', () => {
  it('sets safe defaults on health responses', async () => {
    const projectRoot = makeTmpDir('agentforge-sec-root-');
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v5/health' });

    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
  });

  it('sets safe defaults on API responses', async () => {
    const projectRoot = makeTmpDir('agentforge-sec-root-');
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/v6/openapi.json' });

    expect(res.statusCode).toBe(200);
    expectSecurityHeaders(res.headers);
  });

  it('sets safe defaults on static dashboard responses', async () => {
    const projectRoot = makeTmpDir('agentforge-sec-root-');
    const dashboardPath = makeTmpDir('agentforge-sec-dashboard-');
    writeFileSync(join(dashboardPath, 'index.html'), '<!doctype html><html><body>AgentForge</body></html>');

    const { app } = await createServerV5({ listen: false, projectRoot, dashboardPath });
    createdApps.push(app);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expectSecurityHeaders(res.headers);
  });
});
