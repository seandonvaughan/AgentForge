import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceAdapter, WorkspaceRegistry } from '@agentforge/db';
import { createServerV5 } from '../server.js';
import { registerV5Routes } from '../index.js';

const artifactUrls = [
  '/api/v5/cycles/cycle-objective/decomposition',
  '/api/v5/cycles/cycle-objective/epic-review',
  '/api/v5/cycles/cycle-objective/spend-report',
] as const;

let apps: FastifyInstance[] = [];
let roots: string[] = [];

afterEach(async () => {
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      // ignore cleanup errors
    }
  }
  apps = [];

  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
  roots = [];
});

function makeProjectRoot(): string {
  const root = join(tmpdir(), `agentforge-objective-routes-${randomUUID()}`);
  roots.push(root);
  const cycleDir = join(root, '.agentforge', 'cycles', 'cycle-objective');
  const phasesDir = join(cycleDir, 'phases');
  mkdirSync(phasesDir, { recursive: true });
  writeFileSync(join(cycleDir, 'decomposition.json'), JSON.stringify({ mode: 'epic-decomposition' }));
  writeFileSync(join(phasesDir, 'epic-review.json'), JSON.stringify({ mode: 'epic-review' }));
  writeFileSync(join(cycleDir, 'spend-report.json'), JSON.stringify({ totalUsd: 0.42 }));
  return root;
}

async function expectArtifactsResolve(app: FastifyInstance): Promise<void> {
  await app.ready();

  for (const url of artifactUrls) {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode, `${url} should resolve`).toBe(200);
    expect(response.json()).toHaveProperty('data');
    expect(response.json()).toHaveProperty('meta.timestamp');
  }
}

describe('objective cycle artifact route registration', () => {
  it('resolves decomposition, epic-review, and spend-report in the no-adapter server path', async () => {
    const projectRoot = makeProjectRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    apps.push(app);

    await expectArtifactsResolve(app);
  });

  it('resolves decomposition, epic-review, and spend-report in the adapter index path', async () => {
    const projectRoot = makeProjectRoot();
    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
    const registryRoot = join(projectRoot, '.agentforge', 'registry');
    const registry = new WorkspaceRegistry({ dataDir: registryRoot });
    const app = Fastify({ logger: false });
    apps.push(app);

    await registerV5Routes(app, { adapter, registry, projectRoot });

    await expectArtifactsResolve(app);
    expect(existsSync(registryRoot)).toBe(true);
  });
});
