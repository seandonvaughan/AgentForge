/**
 * Integration tests for /api/v5/billing/* endpoints.
 *
 * Tests:
 *   GET  /api/v5/billing/plan      — defaults, settings persistence
 *   GET  /api/v5/billing/invoices  — empty list
 *   POST /api/v5/billing/invoices  — 501 + audit entry, schema validation
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { createServerV5 } from '../../../server.js';

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

function makeTmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-billing-'));
  tmpDirs.push(dir);
  return dir;
}

async function makeApp(projectRoot: string) {
  const { app } = await createServerV5({ listen: false, projectRoot });
  createdApps.push(app);
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/v5/billing/plan
// ---------------------------------------------------------------------------

describe('GET /api/v5/billing/plan', () => {
  it('returns default free plan when no settings file exists', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/plan' });
    expect(res.statusCode).toBe(200);

    interface PlanBody {
      data: {
        tier: string;
        name: string;
        monthlyBudgetUsd: number;
        perAgentCostMultiplier: number;
        features: string[];
      };
    }
    const body = res.json<PlanBody>();
    expect(body.data.tier).toBe('free');
    expect(body.data.name).toBe('Free');
    expect(typeof body.data.monthlyBudgetUsd).toBe('number');
    expect(typeof body.data.perAgentCostMultiplier).toBe('number');
    expect(Array.isArray(body.data.features)).toBe(true);
  });

  it('returns pro plan when settings.yaml billing block is set to pro', async () => {
    const projectRoot = makeTmpRoot();
    const cfgDir = join(projectRoot, '.agentforge', 'config');
    mkdirSync(cfgDir, { recursive: true });
    const billing = {
      tier: 'pro',
      name: 'Pro',
      monthlyBudgetUsd: 200,
      perAgentCostMultiplier: 1.5,
      features: ['Unlimited agents', 'Priority support'],
    };
    writeFileSync(join(cfgDir, 'settings.yaml'), yaml.dump({ billing }), 'utf-8');

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/plan' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: { tier: string; monthlyBudgetUsd: number } }>();
    expect(body.data.tier).toBe('pro');
    expect(body.data.monthlyBudgetUsd).toBe(200);
  });

  it('falls back to defaults when settings.yaml has no billing block', async () => {
    const projectRoot = makeTmpRoot();
    const cfgDir = join(projectRoot, '.agentforge', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'settings.yaml'), yaml.dump({ execution: { defaultModel: 'opus' } }));

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/plan' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { tier: string } }>();
    expect(body.data.tier).toBe('free');
  });

  it('falls back to free tier for an unknown tier value in settings', async () => {
    const projectRoot = makeTmpRoot();
    const cfgDir = join(projectRoot, '.agentforge', 'config');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'settings.yaml'), yaml.dump({ billing: { tier: 'ultra-mega' } }));

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/plan' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { tier: string } }>();
    expect(body.data.tier).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// GET /api/v5/billing/invoices
// ---------------------------------------------------------------------------

describe('GET /api/v5/billing/invoices', () => {
  it('returns an empty array', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/invoices' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[] }>();
    expect(body.data).toEqual([]);
  });

  it('response has the standard { data: [] } envelope', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({ method: 'GET', url: '/api/v5/billing/invoices' });
    const body = res.json<{ data: unknown[] }>();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v5/billing/invoices
// ---------------------------------------------------------------------------

describe('POST /api/v5/billing/invoices', () => {
  it('returns 501 Not Implemented for a valid payload', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const payload = {
      invoiceId: 'inv_test_001',
      amountUsd: 49.99,
      status: 'paid',
      issuedAt: new Date().toISOString(),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/billing/invoices',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; invoiceId: string }>();
    expect(body.error).toMatch(/not implemented/i);
    expect(body.invoiceId).toBe('inv_test_001');
  });

  it('writes an audit log entry for each received webhook', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const payload = {
      invoiceId: 'inv_audit_check',
      amountUsd: 99.00,
      status: 'open',
      issuedAt: new Date().toISOString(),
      customerId: 'cus_abc123',
    };

    await app.inject({
      method: 'POST',
      url: '/api/v5/billing/invoices',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    const auditRes = await app.inject({ method: 'GET', url: '/api/v5/audit?limit=20' });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = auditRes.json<{ data: Array<{ action: string; target: string }> }>();
    const entry = auditBody.data.find(
      e => e.action === 'billing.invoice.received' && e.target === 'inv_audit_check',
    );
    expect(entry).toBeDefined();
  });

  it('returns 400 for a payload missing required invoiceId field', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/billing/invoices',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amountUsd: 10, status: 'paid', issuedAt: new Date().toISOString() }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an invalid status value', async () => {
    const projectRoot = makeTmpRoot();
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/billing/invoices',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        invoiceId: 'inv_bad',
        amountUsd: 10,
        status: 'not-a-real-status',
        issuedAt: new Date().toISOString(),
      }),
    });

    expect(res.statusCode).toBe(400);
  });
});
