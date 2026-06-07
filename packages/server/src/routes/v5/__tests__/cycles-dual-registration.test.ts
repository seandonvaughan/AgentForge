import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceAdapter, type WorkspaceRegistry } from '@agentforge/db';
import { createServerV5 } from '../../../server.js';
import { registerV5Routes } from '../index.js';

const CYCLE_ID = 'cycle-decomposition-parity';

let apps: FastifyInstance[] = [];
let adapters: WorkspaceAdapter[] = [];
let tmpRoots: string[] = [];

afterEach(async () => {
  for (const app of apps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  apps = [];

  for (const adapter of adapters) {
    try { adapter.close(); } catch { /* ignore */ }
  }
  adapters = [];

  for (const root of tmpRoots) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpRoots = [];
});

function makeProjectRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-dual-'));
  tmpRoots.push(projectRoot);

  const cycleDir = join(projectRoot, '.agentforge', 'cycles', CYCLE_ID);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(
    join(cycleDir, 'decomposition.json'),
    JSON.stringify({
      epicId: 'epic-parity',
      rationale: 'prove route registration parity',
      children: [
        {
          id: 'child-1',
          title: 'Implement parity',
          wave: 1,
          estimatedCostUsd: 1.25,
        },
      ],
    }),
    'utf8',
  );

  return projectRoot;
}

async function expectDecompositionEndpoint(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v5/cycles/${CYCLE_ID}/decomposition`,
  });

  expect(res.statusCode).toBe(200);
  const body = res.json<{
    data: {
      cycleId: string;
      summary: { childCount: number; estimatedCostUsd: number };
    };
    meta: { workspaceId: string; timestamp: string };
  }>();

  expect(body.data.cycleId).toBe(CYCLE_ID);
  expect(body.data.summary.childCount).toBe(1);
  expect(body.data.summary.estimatedCostUsd).toBe(1.25);
  expect(body.meta.workspaceId).toBe('default');
  expect(typeof body.meta.timestamp).toBe('string');
}

describe('cycles route registration parity', () => {
  it('serves decomposition through the no-adapter createServerV5 path', async () => {
    const projectRoot = makeProjectRoot();
    const { app } = await createServerV5({ listen: false, projectRoot });
    apps.push(app);
    await app.ready();

    await expectDecompositionEndpoint(app);
  });

  it('serves decomposition through registerV5Routes adapter path', async () => {
    const projectRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    apps.push(app);

    const adapter = new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
    adapters.push(adapter);

    const registry = {
      listWorkspaces: () => [],
      getWorkspace: () => undefined,
    } as unknown as WorkspaceRegistry;

    await registerV5Routes(app, { adapter, registry, projectRoot });
    await app.ready();

    await expectDecompositionEndpoint(app);
  });
});
