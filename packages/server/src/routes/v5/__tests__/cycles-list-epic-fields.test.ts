import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../lib/cycle-sessions.js', () => ({
  get: () => null,
  list: () => [],
  reap: () => ({ reaped: 0, stillRunning: 0 }),
  startReaper: () => ({ stop: () => {} }),
  register: () => {},
  markTerminal: () => {},
  stop: async () => ({ ok: true, status: 'killed', message: 'mocked' }),
  isPidAlive: () => false,
}));

import { cyclesRoutes } from '../cycles.js';

let tmpRoot: string;
let app: FastifyInstance;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-cycles-list-epic-fields-'));
  mkdirSync(join(tmpRoot, '.agentforge/cycles'), { recursive: true });
  app = Fastify({ logger: false });
  await cyclesRoutes(app, { projectRoot: tmpRoot });
});

afterEach(async () => {
  await app.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeCycleDir(id: string): string {
  const dir = join(tmpRoot, '.agentforge/cycles', id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('GET /api/v5/cycles epic list fields', () => {
  it('includes isEpic and childCount on epic and non-epic rows', async () => {
    const epicId = 'cccccccc-0000-0000-0000-000000000001';
    const nonEpicId = 'cccccccc-0000-0000-0000-000000000002';
    const epicDir = makeCycleDir(epicId);
    const nonEpicDir = makeCycleDir(nonEpicId);

    writeFileSync(
      join(epicDir, 'cycle-config.json'),
      JSON.stringify({ objective: 'Ship the objective-mode cycle list badge' }),
    );
    writeFileSync(
      join(epicDir, 'decomposition.json'),
      JSON.stringify({
        epicId: 'epic-cccccccc',
        children: [
          { id: 'child-1', title: 'API fields' },
          { id: 'child-2', title: 'Dashboard badge' },
        ],
      }),
    );
    writeFileSync(join(nonEpicDir, 'cycle-config.json'), JSON.stringify({ objective: null }));

    const res = await app.inject({ method: 'GET', url: '/api/v5/cycles' });

    expect(res.statusCode).toBe(200);
    const rows = res.json().cycles as Array<Record<string, unknown>>;
    expect(rows.find((row) => row['cycleId'] === epicId)).toMatchObject({
      isEpic: true,
      childCount: 2,
    });
    expect(rows.find((row) => row['cycleId'] === nonEpicId)).toMatchObject({
      isEpic: false,
      childCount: 0,
    });
  });
});
