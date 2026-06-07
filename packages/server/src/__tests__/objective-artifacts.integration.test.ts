import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServerV5 } from '../server.js';

const cycleId = 'cycle-objective-artifacts';

const artifactCases = [
  {
    name: 'decomposition',
    url: `/api/v5/cycles/${cycleId}/decomposition`,
    relativePath: ['decomposition.json'],
    body: {
      mode: 'epic-decomposition',
      epicId: 'epic-objective',
      children: [{ id: 'item-1', title: 'Ship the route guard', wave: 0 }],
    },
  },
  {
    name: 'epic-review',
    url: `/api/v5/cycles/${cycleId}/epic-review`,
    relativePath: ['phases', 'epic-review.json'],
    body: {
      mode: 'epic-review',
      verdict: 'PASS',
      faultedItems: [],
    },
  },
  {
    name: 'spend-report',
    url: `/api/v5/cycles/${cycleId}/spend-report`,
    relativePath: ['spend-report.json'],
    body: {
      totalUsd: 0.42,
      budgetUsd: 10,
      perItem: [{ itemId: 'item-1', actualUsd: 0.42 }],
    },
  },
] as const;

let app: FastifyInstance | null = null;
let projectRoot: string | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }

  if (projectRoot) {
    rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  }
});

async function bootServer(root: string): Promise<void> {
  const server = await createServerV5({ listen: false, projectRoot: root });
  app = server.app;
  await app.ready();
}

function makeProjectRoot(): string {
  const root = join(tmpdir(), `agentforge-objective-artifacts-${randomUUID()}`);
  projectRoot = root;
  mkdirSync(join(root, '.agentforge', 'cycles', cycleId), { recursive: true });
  return root;
}

function writeArtifact(root: string, relativePath: readonly string[], body: unknown): void {
  const file = join(root, '.agentforge', 'cycles', cycleId, ...relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body), 'utf8');
}

describe('objective cycle artifact endpoints', () => {
  it('boots the registered app and returns decomposition, epic-review, and spend-report artifacts', async () => {
    const root = makeProjectRoot();
    for (const fixture of artifactCases) {
      writeArtifact(root, fixture.relativePath, fixture.body);
    }
    await bootServer(root);

    for (const fixture of artifactCases) {
      const response = await app!.inject({ method: 'GET', url: fixture.url });

      expect(response.statusCode, fixture.url).toBe(200);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.json()).toMatchObject({
        data: fixture.body,
        meta: {
          cycleId,
          artifact: fixture.name,
          workspaceId: 'default',
        },
      });
      expect(new Date(response.json().meta.timestamp).toString()).not.toBe('Invalid Date');
    }
  });

  it('returns 404 JSON for each objective artifact when its file is absent', async () => {
    const root = makeProjectRoot();
    await bootServer(root);

    for (const fixture of artifactCases) {
      const response = await app!.inject({ method: 'GET', url: fixture.url });

      expect(response.statusCode, fixture.url).toBe(404);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.json()).toEqual({
        error: 'Cycle artifact not found',
        code: 'CYCLE_ARTIFACT_NOT_FOUND',
        details: {
          cycleId,
          artifact: fixture.name,
        },
      });
    }
  });
});
