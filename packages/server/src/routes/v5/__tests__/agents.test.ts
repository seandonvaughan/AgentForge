/**
 * Integration tests for GET /api/v5/agents.
 *
 * Verifies that the route reads real YAML files from
 * <projectRoot>/.agentforge/agents/*.yaml and returns structured agent data.
 * Uses a temporary project root so tests are hermetic and CI-safe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-agents-'));
  tmpDirs.push(dir);
  return dir;
}

describe('GET /api/v5/agents', () => {
  it('returns an empty list when .agentforge/agents/ does not exist', async () => {
    const projectRoot = makeTmpRoot(); // no agents dir created
    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; meta: { total: number } }>();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  it('returns agents parsed from YAML files in .agentforge/agents/', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(join(agentsDir, 'architect.yaml'), [
      'name: Architect',
      'model: opus',
      'description: Designs the system.',
      'role: lead',
    ].join('\n'));

    writeFileSync(join(agentsDir, 'coder.yaml'), [
      'name: Coder',
      'model: sonnet',
      'description: Writes the code.',
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: Array<{ agentId: string; name: string; model: string; description: string | null; role: string | null }>; meta: { total: number } }>();
    expect(body.meta.total).toBe(2);

    // Results are sorted alphabetically by agentId
    expect(body.data[0]).toMatchObject({
      agentId: 'architect',
      name: 'Architect',
      model: 'opus',
      description: 'Designs the system.',
      role: 'lead',
    });
    expect(body.data[1]).toMatchObject({
      agentId: 'coder',
      name: 'Coder',
      model: 'sonnet',
      description: 'Writes the code.',
      role: null,
    });
  });

  it('defaults unknown model values to "sonnet"', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(join(agentsDir, 'unknown-model.yaml'), [
      'name: Mystery Agent',
      'model: gpt-4', // not a valid AgentForge tier
    ].join('\n'));

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: Array<{ model: string }> }>();
    expect(body.data[0]!.model).toBe('sonnet');
  });

  it('skips malformed YAML files without crashing', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });

    writeFileSync(join(agentsDir, 'good.yaml'), 'name: Good\nmodel: haiku\n');
    writeFileSync(join(agentsDir, 'bad.yaml'), '{ invalid: yaml: [[[');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents' });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ data: Array<{ agentId: string }>; meta: { total: number } }>();
    // Only the good file should appear
    expect(body.meta.total).toBe(1);
    expect(body.data[0]!.agentId).toBe('good');
  });

  it('uses the projectRoot from createServerV5, not process.cwd()', async () => {
    // Regression guard: the adapter-mode path previously omitted projectRoot
    // when calling registerV5Routes, falling back to process.cwd(). This test
    // places agents in a temp dir that is NOT process.cwd() and verifies they
    // are found, confirming the path is threaded correctly.
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'sentinel.yaml'), 'name: Sentinel\nmodel: opus\n');

    const { app } = await createServerV5({ listen: false, projectRoot });
    createdApps.push(app);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents' });
    const body = res.json<{ data: Array<{ agentId: string }> }>();

    // Must find the agent in the temp dir — NOT in process.cwd()/.agentforge/agents/
    expect(body.data.some(a => a.agentId === 'sentinel')).toBe(true);
  });
});
