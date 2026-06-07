import Fastify, { type FastifyInstance } from 'fastify';
import { WorkspaceAdapter } from '@agentforge/db';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cycleEpicReviewRoutes } from '../cycle-epic-review.js';
import type { EpicReviewArtifact } from '../cycle-epic-review.js';

let app: FastifyInstance;
let adapter: WorkspaceAdapter;
let projectRoot: string;

const cycleId = 'cycle-abc123';

function artifact(overrides: Partial<EpicReviewArtifact> = {}): EpicReviewArtifact {
  return {
    phase: 'gate',
    mode: 'epic-review',
    cycleId,
    attempt: 1,
    verdict: 'APPROVE',
    rationale: 'Ready to release.',
    faultedItems: [],
    schemaValidationOk: true,
    triageUsed: false,
    costUsd: 0.03,
    durationMs: 1200,
    completedAt: '2026-06-06T18:00:00.000Z',
    ...overrides,
  };
}

function writeEpicReviewArtifact(value: EpicReviewArtifact): void {
  const phasesDir = join(projectRoot, '.agentforge', 'cycles', value.cycleId, 'phases');
  mkdirSync(phasesDir, { recursive: true });
  writeFileSync(join(phasesDir, 'epic-review.json'), JSON.stringify(value), 'utf8');
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycle-epic-review-'));
  adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-workspace' });
  app = Fastify();
  await cycleEpicReviewRoutes(app, { adapter, projectRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  adapter.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('GET /api/v5/cycles/:id/epic-review', () => {
  it('returns the persisted epic review artifact when present', async () => {
    const persisted = artifact({
      verdict: 'REQUEST_CHANGES',
      faultedItems: [
        {
          itemId: 'item-1',
          reason: 'Missing endpoint coverage.',
          files: ['packages/server/src/lib/routes/cycle-epic-review.ts'],
        },
      ],
    });
    writeEpicReviewArtifact(persisted);

    const response = await app.inject({ method: 'GET', url: `/api/v5/cycles/${cycleId}/epic-review` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: persisted,
      meta: {
        cycleId,
        workspaceId: 'test-workspace',
        timestamp: expect.any(String),
      },
    });
  });

  it('returns a JSON 404 when the epic review artifact is absent', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v5/cycles/${cycleId}/epic-review` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      data: null,
      meta: {
        cycleId,
        workspaceId: 'test-workspace',
        timestamp: expect.any(String),
      },
      error: {
        code: 'EPIC_REVIEW_NOT_FOUND',
        message: 'Epic review artifact not found',
      },
    });
  });
});
