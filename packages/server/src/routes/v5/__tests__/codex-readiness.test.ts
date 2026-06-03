import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { codexReadinessRoutes } from '../codex-readiness.js';

const tempRoots: string[] = [];

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentforge-readiness-'));
  tempRoots.push(root);
  mkdirSync(join(root, '.agentforge', 'agents'), { recursive: true });
  mkdirSync(join(root, 'packages', 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(root, 'packages', 'mcp-server', 'dist', 'index.js'), 'export {};');
  writeFileSync(join(root, '.agentforge', 'agents', 'coder.yaml'), [
    'name: Coder',
    'model: sonnet',
    'effort: high',
    '',
  ].join('\n'));
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GET /api/v5/codex/readiness', () => {
  it('returns a stable dashboard readiness shape and honors skipLogin', async () => {
    const projectRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    await codexReadinessRoutes(app, { projectRoot });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/codex/readiness?skipLogin=true&projectRoot=${encodeURIComponent(projectRoot)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        projectRoot: string;
        ready: boolean;
        status: string;
        summary: {
          agentCount: number;
          warningCount: number;
          codexCliAvailable: boolean;
          mcpServerAvailable: boolean;
          codexLoginChecked: boolean;
          codexLoginOk: boolean | null;
        };
        checks: Record<string, { ok: boolean | null; label: string; detail?: string }>;
        agents: Array<{ agentId: string; codexModel: string; codexEffort: string; valid: boolean }>;
        warnings: string[];
      };
      meta: { timestamp: string };
    }>();

    expect(body.data.projectRoot).toBe(projectRoot);
    expect(body.data.status).toMatch(/^(ready|degraded)$/);
    expect(body.data.summary.agentCount).toBe(1);
    expect(body.data.summary.codexLoginChecked).toBe(false);
    expect(body.data.summary.codexLoginOk).toBeNull();
    const loginCheck = body.data.checks.login;
    expect(loginCheck).toBeDefined();
    expect(loginCheck?.ok).toBeNull();
    expect(body.data.agents[0]).toMatchObject({
      agentId: 'coder',
      codexModel: 'gpt-5.5',
      codexEffort: 'high',
      valid: true,
    });
    expect(typeof body.meta.timestamp).toBe('string');

    await app.close();
  });

  it('rejects projectRoot values outside the server-configured root', async () => {
    const projectRoot = makeProjectRoot();
    const otherRoot = makeProjectRoot();
    const app = Fastify({ logger: false });
    await codexReadinessRoutes(app, { projectRoot });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/api/v5/codex/readiness?skipLogin=true&projectRoot=${encodeURIComponent(otherRoot)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty('code', 'PROJECT_ROOT_NOT_ALLOWED');

    await app.close();
  });
});
