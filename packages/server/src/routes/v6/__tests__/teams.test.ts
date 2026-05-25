import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerV6Routes } from '../index.js';

describe('v6 teams loader', () => {
  let app: ReturnType<typeof Fastify> | null = null;
  let tmpRoot = '';

  afterEach(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // ignore
      }
      app = null;
    }
    if (tmpRoot) {
      try {
        rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tmpRoot = '';
    }
  });

  it('returns an empty list when team.yaml is malformed', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-v6-teams-'));
    mkdirSync(join(tmpRoot, '.agentforge'), { recursive: true });
    writeFileSync(join(tmpRoot, '.agentforge', 'team.yaml'), '[]\n');

    app = Fastify();
    await app.register(import('@fastify/websocket'));
    await registerV6Routes(app, {
      adapter: {} as never,
      registry: {} as never,
      projectRoot: tmpRoot,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v6/teams' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });
});
