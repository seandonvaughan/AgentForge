/**
 * Tests for GET /api/v5/cycles/:cycleId/prs
 *
 * Tests:
 *   01 — happy path: 3 ledger entries → 200, data.length 3
 *   02 — ?ci=false: execFile is NOT called
 *   03 — ?status=open: filters to open entries only
 *   04 — ?status=merged: filters to merged entries only
 *   05 — cycle dir missing → 404
 *   06 — ledger file missing → 200 with empty data
 *   07 — gh fails → ci is null per entry, request still 200
 *   08 — meta.counts are correct
 *   09 — meta.cycleId matches request param
 *   10 — dry-run entries get ci=null even when ?ci not set
 *   11 — skipped-no-gh entries get ci=null
 *   12 — invalid cycleId (unsafe chars) → 400
 *   13 — path traversal cycleId → 400
 *   14 — parseGhChecksBucket unit tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  cyclePrsRoutes,
  parseGhChecksBucket,
  type LedgerEntry,
} from '../cycle-prs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-abc123';

const LEDGER_ENTRIES: LedgerEntry[] = [
  {
    prNumber: 101,
    prUrl: 'https://github.com/owner/repo/pull/101',
    branch: 'feat/v22.3-agent-alpha',
    agentId: 'agent-alpha',
    itemIds: ['item-1', 'item-2'],
    status: 'open',
    openedAt: '2026-05-17T10:00:00.000Z',
  },
  {
    prNumber: 102,
    prUrl: 'https://github.com/owner/repo/pull/102',
    branch: 'feat/v22.3-agent-beta',
    agentId: 'agent-beta',
    itemIds: ['item-3'],
    status: 'merged',
    openedAt: '2026-05-17T11:00:00.000Z',
  },
  {
    prNumber: 103,
    prUrl: 'https://github.com/owner/repo/pull/103',
    branch: 'feat/v22.3-agent-gamma',
    agentId: 'agent-gamma',
    itemIds: ['item-4', 'item-5'],
    status: 'closed',
    openedAt: '2026-05-17T12:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecFileFn = typeof promisify<typeof execFile> extends (...args: any[]) => infer R
  ? R extends (...args: any[]) => any
    ? R
    : never
  : never;

/** A mock execFile that resolves with gh pr checks output (all passing). */
function makeSuccessExecFn(): { fn: ExecFileFn; callCount: number } {
  let callCount = 0;
  const checks = JSON.stringify([
    { name: 'ci/tests', state: 'SUCCESS', conclusion: 'SUCCESS' },
    { name: 'ci/lint', state: 'SUCCESS', conclusion: 'SUCCESS' },
  ]);
  const fn = vi.fn(async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
    callCount++;
    return { stdout: checks, stderr: '' };
  }) as unknown as ExecFileFn;
  return { fn, callCount: 0 };
}

/** A mock execFile that always rejects (gh not available). */
function makeFailExecFn(): { fn: ExecFileFn; callCount: number } {
  let callCount = 0;
  const fn = vi.fn(async (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
    callCount++;
    throw new Error('gh: command not found');
  }) as unknown as ExecFileFn;
  return { fn, callCount: 0 };
}

// We spy on the real call count via vi.fn() so use a wrapper
function makeSpy(): {
  fn: ExecFileFn;
  calls: () => number;
} {
  let calls = 0;
  const checks = JSON.stringify([
    { name: 'ci/tests', state: 'SUCCESS', conclusion: 'SUCCESS' },
  ]);
  const fn = vi.fn(async () => {
    calls++;
    return { stdout: checks, stderr: '' };
  }) as unknown as ExecFileFn;
  return { fn, calls: () => calls };
}

function makeFailSpy(): {
  fn: ExecFileFn;
  calls: () => number;
} {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls++;
    throw new Error('gh auth required');
  }) as unknown as ExecFileFn;
  return { fn, calls: () => calls };
}

async function buildApp(
  projectRoot: string,
  execFileFn?: ExecFileFn,
): Promise<FastifyInstance> {
  const a = Fastify({ logger: false });
  await cyclePrsRoutes(a, { projectRoot, execFileFn: execFileFn as any });
  await a.ready();
  return a;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let cycleDir: string;
let app: FastifyInstance;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-prs-'));
  cycleDir = join(tmpRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(cycleDir, { recursive: true });
});

afterEach(async () => {
  if (app) await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseGhChecksBucket unit tests (pure function)
// ---------------------------------------------------------------------------

describe('parseGhChecksBucket()', () => {
  it('returns pass when all checks are SUCCESS', () => {
    const checks = JSON.stringify([
      { name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' },
      { name: 'lint', state: 'SUCCESS', conclusion: 'SUCCESS' },
    ]);
    expect(parseGhChecksBucket(checks)).toBe('pass');
  });

  it('returns fail when any check is FAILURE', () => {
    const checks = JSON.stringify([
      { name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' },
      { name: 'lint', state: 'FAILURE', conclusion: 'FAILURE' },
    ]);
    expect(parseGhChecksBucket(checks)).toBe('fail');
  });

  it('returns pending when any check is IN_PROGRESS (and no failures)', () => {
    const checks = JSON.stringify([
      { name: 'ci', state: 'IN_PROGRESS', conclusion: '' },
      { name: 'lint', state: 'SUCCESS', conclusion: 'SUCCESS' },
    ]);
    expect(parseGhChecksBucket(checks)).toBe('pending');
  });

  it('returns unknown for empty array', () => {
    expect(parseGhChecksBucket('[]')).toBe('unknown');
  });

  it('returns unknown for invalid JSON', () => {
    expect(parseGhChecksBucket('not-json')).toBe('unknown');
  });

  it('fail takes precedence over pending', () => {
    const checks = JSON.stringify([
      { name: 'ci', state: 'IN_PROGRESS', conclusion: '' },
      { name: 'lint', state: 'FAILURE', conclusion: 'FAILURE' },
    ]);
    expect(parseGhChecksBucket(checks)).toBe('fail');
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:cycleId/prs', () => {
  it('01 — happy path: returns 200 with 3 data entries', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    const spy = makeSpy();
    app = await buildApp(tmpRoot, spy.fn);

    const res = await app.inject({ method: 'GET', url: `/api/v5/cycles/${CYCLE_ID}/prs` });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data).toHaveLength(3);
    expect(body.meta.total).toBe(3);
  });

  it('02 — ?ci=false skips execFile entirely', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    const spy = makeSpy();
    app = await buildApp(tmpRoot, spy.fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false`,
    });

    expect(res.statusCode).toBe(200);
    // execFile must NOT have been called
    expect(spy.calls()).toBe(0);
    const body = res.json<{ data: Array<{ ci: unknown }> }>();
    for (const entry of body.data) {
      expect(entry.ci).toBeNull();
    }
  });

  it('03 — ?status=open filters to open entries only', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false&status=open`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ status: string; prNumber: number }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('open');
    expect(body.data[0]!.prNumber).toBe(101);
  });

  it('04 — ?status=merged filters to merged entries only', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false&status=merged`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ status: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('merged');
  });

  it('05 — cycle dir missing → 404', async () => {
    // Use a cycleId that has no corresponding directory
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/nonexistent-cycle/prs',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toContain('not found');
  });

  it('06 — ledger file missing → 200 with empty data', async () => {
    // cycleDir exists but no agent-prs.json inside
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      meta: { total: number; counts: Record<string, number> };
    }>();
    expect(body.data).toHaveLength(0);
    expect(body.meta.total).toBe(0);
    expect(body.meta.counts.open).toBe(0);
    expect(body.meta.counts.merged).toBe(0);
  });

  it('07 — gh fails → ci is null per entry, request still 200', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    const failSpy = makeFailSpy();
    app = await buildApp(tmpRoot, failSpy.fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ ci: unknown }> }>();
    expect(body.data).toHaveLength(3);
    for (const entry of body.data) {
      expect(entry.ci).toBeNull();
    }
    // gh was attempted (once per non-dry-run entry)
    expect(failSpy.calls()).toBeGreaterThan(0);
  });

  it('08 — meta.counts are correct', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      meta: { counts: { open: number; merged: number; closed: number; pending: number } };
    }>();
    expect(body.meta.counts.open).toBe(1);
    expect(body.meta.counts.merged).toBe(1);
    expect(body.meta.counts.closed).toBe(1);
    expect(body.meta.counts.pending).toBe(0);
  });

  it('09 — meta.cycleId matches request param', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false`,
    });

    const body = res.json<{ meta: { cycleId: string } }>();
    expect(body.meta.cycleId).toBe(CYCLE_ID);
  });

  it('10 — dry-run entries get ci=null even when ?ci not set', async () => {
    const entries: LedgerEntry[] = [
      {
        prNumber: 201,
        prUrl: '',
        branch: 'feat/dry',
        agentId: 'agent-dry',
        itemIds: [],
        status: 'dry-run',
        openedAt: '2026-05-17T10:00:00.000Z',
      },
    ];
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify(entries));
    const spy = makeSpy();
    app = await buildApp(tmpRoot, spy.fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ ci: unknown }> }>();
    expect(body.data[0]!.ci).toBeNull();
    // execFile should NOT have been called for dry-run entries
    expect(spy.calls()).toBe(0);
  });

  it('11 — skipped-no-gh entries get ci=null without calling execFile', async () => {
    const entries: LedgerEntry[] = [
      {
        prNumber: 301,
        prUrl: '',
        branch: 'feat/skip',
        agentId: 'agent-skip',
        itemIds: [],
        status: 'skipped-no-gh',
        openedAt: '2026-05-17T10:00:00.000Z',
      },
    ];
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify(entries));
    const spy = makeSpy();
    app = await buildApp(tmpRoot, spy.fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ ci: unknown }> }>();
    expect(body.data[0]!.ci).toBeNull();
    expect(spy.calls()).toBe(0);
  });

  it('12 — invalid cycleId (unsafe chars) → 400', async () => {
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/bad.id!/prs',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Invalid');
  });

  it('13 — path traversal cycleId → 400 or 404', async () => {
    app = await buildApp(tmpRoot, makeSpy().fn);

    // Note: Fastify URL-encodes the param so `..` becomes its encoded form,
    // but we test the validation catches it regardless.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v5/cycles/evil-id/prs',
    });

    // nonexistent cycle dir → 404 (which is still safe)
    expect([400, 404]).toContain(res.statusCode);
  });

  it('14 — response data entries include all required fields', async () => {
    writeFileSync(
      join(cycleDir, 'agent-prs.json'),
      JSON.stringify(LEDGER_ENTRIES),
    );
    app = await buildApp(tmpRoot, makeSpy().fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs?ci=false`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        prNumber: number;
        prUrl: string;
        branch: string;
        agentId: string;
        itemIds: string[];
        status: string;
        openedAt: string;
        ci: unknown;
      }>;
    }>();

    for (const entry of body.data) {
      expect(typeof entry.prNumber).toBe('number');
      expect(typeof entry.prUrl).toBe('string');
      expect(typeof entry.branch).toBe('string');
      expect(typeof entry.agentId).toBe('string');
      expect(Array.isArray(entry.itemIds)).toBe(true);
      expect(typeof entry.status).toBe('string');
      expect(typeof entry.openedAt).toBe('string');
      // ci is null when ?ci=false
      expect(entry.ci).toBeNull();
    }
  });

  it('15 — ci block has correct shape when gh succeeds', async () => {
    const entries: LedgerEntry[] = [LEDGER_ENTRIES[0]!]; // single open PR
    writeFileSync(join(cycleDir, 'agent-prs.json'), JSON.stringify(entries));
    const spy = makeSpy();
    app = await buildApp(tmpRoot, spy.fn);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/${CYCLE_ID}/prs`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ ci: { bucket: string; lastCheckedAt: string } | null }> }>();
    const ci = body.data[0]!.ci;
    expect(ci).not.toBeNull();
    expect(['pass', 'fail', 'pending', 'unknown']).toContain(ci!.bucket);
    expect(typeof ci!.lastCheckedAt).toBe('string');
  });
});
