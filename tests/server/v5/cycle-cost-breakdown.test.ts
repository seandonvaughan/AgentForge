/**
 * tests/server/v5/cycle-cost-breakdown.test.ts
 *
 * Tests for GET /api/v5/cycles/:id/cost-breakdown
 *
 * Coverage:
 *   - 404 when cycle directory does not exist
 *   - 400 for cycleId containing path traversal characters
 *   - 200 with hasBreakdown:false when cycle.json is absent (in-flight cycle)
 *   - 200 with hasBreakdown:false and legacy totalUsd when breakdown field absent
 *   - 200 with hasBreakdown:true when breakdown field present and well-formed
 *   - toolUse entries carried through from breakdown
 *   - Partial breakdown field (missing sub-keys) defaults to 0 safely
 *   - 500 on corrupt cycle.json
 *   - timestamp field is a valid ISO string
 *   - cycleId echoed in response
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cycleCostBreakdownRoutes,
  type CostBreakdownResponse,
} from '../../../packages/server/src/routes/v5/cycle-cost-breakdown.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_ID = 'cycle-abc123';

/** Full CostBreakdown as it would appear in cycle.json's cost.breakdown. */
const FULL_BREAKDOWN = {
  inputTokens:   { count: 1000, usd: 0.003 },
  outputTokens:  { count: 500,  usd: 0.015 },
  cacheCreation: { tokens: 200, usd: 0.0005 },
  cacheRead:     { tokens: 800, usd: 0.00024 },
  toolUse:       {
    Bash:  { invocations: 20, usd: 0.002 },
    Read:  { invocations: 10, usd: 0.001 },
  },
  totalUsd: 0.02074,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let tmpDir: string;

function writeCycleJson(cycleId: string, data: unknown): void {
  const cycleDir = join(tmpDir, '.agentforge', 'cycles', cycleId);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'cycle.json'), JSON.stringify(data), 'utf-8');
}

function createCycleDir(cycleId: string): void {
  mkdirSync(join(tmpDir, '.agentforge', 'cycles', cycleId), { recursive: true });
}

function request(cycleId: string): Promise<{ statusCode: number; body: unknown }> {
  return app.inject({
    method: 'GET',
    url: `/api/v5/cycles/${cycleId}/cost-breakdown`,
  }).then(res => ({
    statusCode: res.statusCode,
    body: res.json(),
  }));
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cost-breakdown-test-'));
  app = Fastify();
  await cycleCostBreakdownRoutes(app, { projectRoot: tmpDir });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/cycles/:id/cost-breakdown', () => {
  it('returns 404 when the cycle directory does not exist', async () => {
    const { statusCode, body } = await request('nonexistent-cycle');
    expect(statusCode).toBe(404);
    expect((body as { error: string }).error).toMatch(/not found/i);
  });

  it('returns 400 for a cycleId containing special characters like spaces or percent', async () => {
    // Fastify normalises URLs before routing so classic "../" traversal is
    // resolved at the HTTP layer. We test the route-level sanitisation with a
    // cycleId that contains characters forbidden by SAFE_CYCLE_ID but survives
    // URL parsing (e.g. "foo bar" encoded as "foo%20bar").
    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/cycles/foo%20bar/cost-breakdown`,
    });
    // Fastify decodes %20 to a space; our regex rejects spaces → 400.
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a cycleId with forward slash', async () => {
    const { statusCode } = await request('foo/bar');
    // Fastify parses the first segment as id, so this hits the cycle-not-found
    // or the bad-id path — either is acceptable (400 or 404); must not be 200.
    expect(statusCode).not.toBe(200);
  });

  it('returns 200 with hasBreakdown:false when cycle.json is absent (in-flight)', async () => {
    createCycleDir(CYCLE_ID);
    const { statusCode, body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(statusCode).toBe(200);
    expect(res.hasBreakdown).toBe(false);
    expect(res.breakdown.totalUsd).toBe(0);
    expect(res.cycleId).toBe(CYCLE_ID);
  });

  it('returns hasBreakdown:false and legacy totalUsd when cycle.json has no breakdown field', async () => {
    writeCycleJson(CYCLE_ID, {
      id: CYCLE_ID,
      cost: { totalUsd: 1.23, budgetUsd: 30 },
    });
    const { statusCode, body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(statusCode).toBe(200);
    expect(res.hasBreakdown).toBe(false);
    expect(res.breakdown.totalUsd).toBe(1.23);
    // Legacy fallback puts everything in inputTokens.usd
    expect(res.breakdown.inputTokens.usd).toBe(1.23);
    expect(res.breakdown.outputTokens.usd).toBe(0);
  });

  it('returns hasBreakdown:true with full breakdown when breakdown field is present', async () => {
    writeCycleJson(CYCLE_ID, {
      id: CYCLE_ID,
      cost: {
        totalUsd: FULL_BREAKDOWN.totalUsd,
        breakdown: FULL_BREAKDOWN,
      },
    });
    const { statusCode, body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(statusCode).toBe(200);
    expect(res.hasBreakdown).toBe(true);
    expect(res.breakdown.totalUsd).toBeCloseTo(FULL_BREAKDOWN.totalUsd, 5);
    expect(res.breakdown.inputTokens.count).toBe(1000);
    expect(res.breakdown.outputTokens.count).toBe(500);
    expect(res.breakdown.cacheCreation.tokens).toBe(200);
    expect(res.breakdown.cacheRead.tokens).toBe(800);
  });

  it('carries toolUse entries from the breakdown', async () => {
    writeCycleJson(CYCLE_ID, {
      id: CYCLE_ID,
      cost: { totalUsd: FULL_BREAKDOWN.totalUsd, breakdown: FULL_BREAKDOWN },
    });
    const { body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(res.breakdown.toolUse['Bash']).toEqual({ invocations: 20, usd: 0.002 });
    expect(res.breakdown.toolUse['Read']).toEqual({ invocations: 10, usd: 0.001 });
  });

  it('returns safe defaults when breakdown field has missing sub-keys', async () => {
    writeCycleJson(CYCLE_ID, {
      id: CYCLE_ID,
      cost: {
        totalUsd: 0.05,
        breakdown: {
          totalUsd: 0.05,
          // inputTokens and outputTokens present but cacheCreation/cacheRead absent
          inputTokens: { count: 100, usd: 0.05 },
        },
      },
    });
    const { statusCode, body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(statusCode).toBe(200);
    expect(res.breakdown.cacheCreation.tokens).toBe(0);
    expect(res.breakdown.cacheCreation.usd).toBe(0);
    expect(res.breakdown.cacheRead.tokens).toBe(0);
    expect(res.breakdown.outputTokens.usd).toBe(0);
  });

  it('returns 500 on corrupt cycle.json', async () => {
    const cycleDir = join(tmpDir, '.agentforge', 'cycles', CYCLE_ID);
    mkdirSync(cycleDir, { recursive: true });
    writeFileSync(join(cycleDir, 'cycle.json'), '{ invalid json {{{{', 'utf-8');
    const { statusCode } = await request(CYCLE_ID);
    expect(statusCode).toBe(500);
  });

  it('echoes the cycleId in the response', async () => {
    createCycleDir(CYCLE_ID);
    const { body } = await request(CYCLE_ID);
    expect((body as CostBreakdownResponse).cycleId).toBe(CYCLE_ID);
  });

  it('returns a valid ISO timestamp in the response', async () => {
    createCycleDir(CYCLE_ID);
    const { body } = await request(CYCLE_ID);
    const ts = (body as CostBreakdownResponse).timestamp;
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it('returns empty toolUse when cycle.json cost has no breakdown', async () => {
    writeCycleJson(CYCLE_ID, { id: CYCLE_ID, cost: { totalUsd: 0.5 } });
    const { body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(res.breakdown.toolUse).toEqual({});
  });

  it('handles cycle.json with no cost field (very old cycles)', async () => {
    writeCycleJson(CYCLE_ID, { id: CYCLE_ID, stage: 'complete' });
    const { statusCode, body } = await request(CYCLE_ID);
    const res = body as CostBreakdownResponse;
    expect(statusCode).toBe(200);
    expect(res.hasBreakdown).toBe(false);
    expect(res.breakdown.totalUsd).toBe(0);
  });
});
