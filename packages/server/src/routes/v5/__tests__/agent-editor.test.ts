/**
 * Integration tests for the agent-editor backend (agent-crud.ts):
 *
 *  - PATCH/POST accept `effort` and `tools` and persist them to the YAML
 *  - every CRUD mutation writes an audit entry (agent.patch/create/delete/fork/promote)
 *  - successful mutations regenerate the Claude Code mirror at .claude/agents/<id>.md
 *
 * Uses a temporary project root so tests are hermetic and CI-safe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
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
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-agent-editor-'));
  tmpDirs.push(dir);
  return dir;
}

async function makeApp(projectRoot: string) {
  const { app } = await createServerV5({ listen: false, projectRoot });
  createdApps.push(app);
  return app;
}

function seedAgent(projectRoot: string, id: string, overrides: Record<string, unknown> = {}): void {
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const doc = {
    name: 'Seed Agent',
    model: 'sonnet',
    version: '1.0',
    description: 'A seeded test agent.',
    system_prompt: 'You are a seeded test agent.',
    ...overrides,
  };
  writeFileSync(join(agentsDir, `${id}.yaml`), yaml.dump(doc));
}

interface AgentYamlOnDisk {
  name: string;
  model: string;
  effort?: string;
  skills?: string[];
  tools?: string[];
  description?: string;
  system_prompt?: string;
  seniority?: string;
}

function readAgentYaml(projectRoot: string, id: string): AgentYamlOnDisk {
  const raw = readFileSync(join(projectRoot, '.agentforge', 'agents', `${id}.yaml`), 'utf-8');
  return yaml.load(raw) as AgentYamlOnDisk;
}

async function findAuditEntry(
  app: { inject: (opts: { method: 'GET'; url: string }) => Promise<{ json: <T>() => T; statusCode: number }> },
  action: string,
  target: string,
): Promise<{ action: string; target: string } | undefined> {
  const res = await app.inject({ method: 'GET', url: '/api/v5/audit?limit=50' });
  expect(res.statusCode).toBe(200);
  const body = res.json<{ data: Array<{ action: string; target: string }> }>();
  return body.data.find((e) => e.action === action && e.target === target);
}

// ---------------------------------------------------------------------------
// PATCH — effort + tools persistence, audit, mirror
// ---------------------------------------------------------------------------

describe('PATCH /api/v5/agents/:id (editor backend)', () => {
  it('accepts effort and tools and persists both into the YAML', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'editor-target');
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/agents/editor-target',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ effort: 'xhigh', tools: ['Read', 'Grep'] }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { effort?: string; tools?: string[] } }>();
    expect(body.data.effort).toBe('xhigh');
    expect(body.data.tools).toEqual(['Read', 'Grep']);

    const onDisk = readAgentYaml(projectRoot, 'editor-target');
    expect(onDisk.effort).toBe('xhigh');
    expect(onDisk.tools).toEqual(['Read', 'Grep']);
    // Untouched fields survive the patch.
    expect(onDisk.name).toBe('Seed Agent');
  });

  it('rejects an invalid effort value with 400', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'bad-effort');
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/agents/bad-effort',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ effort: 'turbo' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/effort/i);
  });

  it('writes an agent.patch audit entry', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'audited-patch');
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/agents/audited-patch',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ description: 'Updated description.' }),
    });
    expect(res.statusCode).toBe(200);

    const entry = await findAuditEntry(app, 'agent.patch', 'audited-patch');
    expect(entry).toBeDefined();
  });

  it('regenerates the .claude/agents/<id>.md mirror after a successful PATCH', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'mirror-patch', { model: 'fable' });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v5/agents/mirror-patch',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ system_prompt: 'You are the refreshed mirror prompt.' }),
    });
    expect(res.statusCode).toBe(200);

    const mirrorPath = join(projectRoot, '.claude', 'agents', 'mirror-patch.md');
    expect(existsSync(mirrorPath)).toBe(true);
    const mirror = readFileSync(mirrorPath, 'utf-8');
    expect(mirror).toContain('name: mirror-patch');
    // fable tier has no Claude Code alias — the emitter writes the full id.
    expect(mirror).toContain('claude-fable-5');
    expect(mirror).toContain('You are the refreshed mirror prompt.');
  });
});

// ---------------------------------------------------------------------------
// POST create — effort + tools persistence, audit, mirror
// ---------------------------------------------------------------------------

describe('POST /api/v5/agents (editor backend)', () => {
  it('accepts effort and tools on create and persists them to the YAML', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/agents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'created-agent',
        name: 'Created Agent',
        model: 'haiku',
        description: 'Created via the editor.',
        system_prompt: 'You are a created agent.',
        effort: 'medium',
        tools: ['Read', 'Bash'],
      }),
    });

    expect(res.statusCode).toBe(201);
    const onDisk = readAgentYaml(projectRoot, 'created-agent');
    expect(onDisk.effort).toBe('medium');
    expect(onDisk.tools).toEqual(['Read', 'Bash']);

    const entry = await findAuditEntry(app, 'agent.create', 'created-agent');
    expect(entry).toBeDefined();

    const mirrorPath = join(projectRoot, '.claude', 'agents', 'created-agent.md');
    expect(existsSync(mirrorPath)).toBe(true);
    const mirror = readFileSync(mirrorPath, 'utf-8');
    expect(mirror).toContain('tools: Read,Bash');
  });

  it('rejects an invalid effort on create with 400', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/agents',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        id: 'bad-create',
        name: 'Bad Create',
        model: 'sonnet',
        description: 'Should fail.',
        system_prompt: 'Never created.',
        effort: 'maximum-overdrive',
      }),
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE / fork / promote — audit entries
// ---------------------------------------------------------------------------

describe('agent CRUD audit coverage', () => {
  it('writes an agent.delete audit entry and removes the mirror', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'doomed-agent');
    const app = await makeApp(projectRoot);

    // Touch the agent first so a mirror exists, then delete.
    await app.inject({
      method: 'PATCH',
      url: '/api/v5/agents/doomed-agent',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ description: 'About to go.' }),
    });
    const mirrorPath = join(projectRoot, '.claude', 'agents', 'doomed-agent.md');
    expect(existsSync(mirrorPath)).toBe(true);

    const res = await app.inject({ method: 'DELETE', url: '/api/v5/agents/doomed-agent' });
    expect(res.statusCode).toBe(200);

    const entry = await findAuditEntry(app, 'agent.delete', 'doomed-agent');
    expect(entry).toBeDefined();
    expect(existsSync(mirrorPath)).toBe(false);
  });

  it('writes an agent.fork audit entry targeting the new agent id', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'fork-source');
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/agents/fork-source/fork',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ newId: 'fork-child' }),
    });
    expect(res.statusCode).toBe(201);

    const entry = await findAuditEntry(app, 'agent.fork', 'fork-child');
    expect(entry).toBeDefined();

    // Fork also mirrors the new agent.
    expect(existsSync(join(projectRoot, '.claude', 'agents', 'fork-child.md'))).toBe(true);
  });

  it('writes an agent.promote audit entry', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'promo-agent', { seniority: 'mid' });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/agents/promo-agent/promote',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ newSeniority: 'lead', approvedBy: 'operator' }),
    });
    expect(res.statusCode).toBe(200);

    const entry = await findAuditEntry(app, 'agent.promote', 'promo-agent');
    expect(entry).toBeDefined();
  });

  it('regenerates the mirror after PUT /api/v5/agents/:id/raw', async () => {
    const projectRoot = makeTmpRoot();
    seedAgent(projectRoot, 'raw-mirror');
    const app = await makeApp(projectRoot);

    const newYaml = yaml.dump({
      name: 'Raw Mirror',
      model: 'opus',
      version: '1.0',
      description: 'Raw rewrite.',
      system_prompt: 'You are the raw rewritten prompt.',
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/raw-mirror/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: newYaml }),
    });
    expect(res.statusCode).toBe(200);

    const mirrorPath = join(projectRoot, '.claude', 'agents', 'raw-mirror.md');
    expect(existsSync(mirrorPath)).toBe(true);
    const mirror = readFileSync(mirrorPath, 'utf-8');
    expect(mirror).toContain('model: opus');
    expect(mirror).toContain('You are the raw rewritten prompt.');
  });
});
