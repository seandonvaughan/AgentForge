/**
 * Integration tests for GET /api/v5/agents/:id/raw and PUT /api/v5/agents/:id/raw.
 *
 * Tests the raw YAML round-trip: read the actual YAML file off disk, edit it,
 * write it back, and verify the content is reserialized through js-yaml.
 *
 * Uses a temporary project root for hermeticity.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'agentforge-raw-yaml-'));
  tmpDirs.push(dir);
  return dir;
}

function makeAgentYaml(overrides: Record<string, string> = {}): string {
  return [
    `name: "${overrides.name ?? 'Test Agent'}"`,
    `model: ${overrides.model ?? 'sonnet'}`,
    `version: "1.0"`,
    `description: "A test agent for raw YAML tests."`,
    `system_prompt: |`,
    `  You are a test agent.`,
    ...(overrides.system_prompt ? [`  ${overrides.system_prompt}`] : []),
  ].join('\n') + '\n';
}

async function makeApp(projectRoot: string) {
  const { app } = await createServerV5({ listen: false, projectRoot });
  createdApps.push(app);
  return app;
}

// ---------------------------------------------------------------------------
// GET /api/v5/agents/:id/raw
// ---------------------------------------------------------------------------

describe('GET /api/v5/agents/:id/raw', () => {
  it('returns yaml, agentId, and modifiedAt for an existing agent', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const content = makeAgentYaml({ name: 'Raw Agent' });
    writeFileSync(join(agentsDir, 'raw-agent.yaml'), content);

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/raw-agent/raw' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { yaml: string; agentId: string; modifiedAt: string } }>();
    expect(body.data.agentId).toBe('raw-agent');
    expect(body.data.yaml).toBe(content);
    expect(typeof body.data.modifiedAt).toBe('string');
    expect(new Date(body.data.modifiedAt).getFullYear()).toBeGreaterThan(2000);
  });

  it('returns 404 for a missing agent', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/ghost-agent/raw' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 for an invalid agent id (path traversal attempt)', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    // Encoded path traversal — Fastify will typically decode %2F → /
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/..%2Fetc%2Fpasswd/raw' });
    // Either 400 (invalid id) or 404 is acceptable; must NOT be 200
    expect([400, 404]).toContain(res.statusCode);
  });

  it('returns the verbatim file content including comments', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    const content = `# my custom comment\nname: "Annotated"\nmodel: haiku\nsystem_prompt: |
  annotated prompt\n`;
    writeFileSync(join(agentsDir, 'annotated.yaml'), content);

    const app = await makeApp(projectRoot);
    const res = await app.inject({ method: 'GET', url: '/api/v5/agents/annotated/raw' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { yaml: string } }>();
    expect(body.data.yaml).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/v5/agents/:id/raw
// ---------------------------------------------------------------------------

describe('PUT /api/v5/agents/:id/raw', () => {
  it('writes normalized YAML and returns updated content', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'edit-agent.yaml'), makeAgentYaml({ name: 'Before' }));

    const app = await makeApp(projectRoot);
    const newYaml = [
      '# comments are not preserved by js-yaml serialization',
      'name: "After"',
      'model: sonnet',
      'version: "1.0"',
      'description: "Path C:\\\\temp\\\\agent"',
      'system_prompt: |',
      '  Render this path exactly: C:\\temp\\agent',
    ].join('\n') + '\n';
    const expectedYaml = yaml.dump(yaml.load(newYaml) as Record<string, unknown>, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/edit-agent/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: newYaml }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { yaml: string; agentId: string } }>();
    expect(body.data.yaml).toBe(expectedYaml);
    expect(body.data.agentId).toBe('edit-agent');
  });

  it('persists the normalized YAML so a re-GET returns the serialized content', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'roundtrip.yaml'), makeAgentYaml({ name: 'Original' }));

    const app = await makeApp(projectRoot);
    const editedYaml = [
      'name: "Edited"',
      'model: haiku',
      'version: "1.0"',
      'description: "Edited path C:\\\\temp\\\\agent"',
      'system_prompt: |',
      '  Edited prompt',
    ].join('\n') + '\n';
    const expectedYaml = yaml.dump(yaml.load(editedYaml) as Record<string, unknown>, {
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });

    await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/roundtrip/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: editedYaml }),
    });

    const getRes = await app.inject({ method: 'GET', url: '/api/v5/agents/roundtrip/raw' });
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json<{ data: { yaml: string } }>();
    expect(body.data.yaml).toBe(expectedYaml);

    // Also verify the file on disk
    const onDisk = readFileSync(join(agentsDir, 'roundtrip.yaml'), 'utf-8');
    expect(onDisk).toBe(expectedYaml);
  });

  it('rejects malformed YAML with 400', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'malform.yaml'), makeAgentYaml());

    const app = await makeApp(projectRoot);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/malform/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: 'key: [unclosed bracket' }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/invalid yaml/i);
  });

  it('rejects YAML missing required fields (name, model, system_prompt) with 400', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'incomplete.yaml'), makeAgentYaml());

    const app = await makeApp(projectRoot);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/incomplete/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: 'description: only this field\n' }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/required/i);
  });

  it('returns 404 when agent file does not exist', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/nonexistent/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: makeAgentYaml() }),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for an invalid agent id in PUT', async () => {
    const projectRoot = makeTmpRoot();
    mkdirSync(join(projectRoot, '.agentforge', 'agents'), { recursive: true });
    const app = await makeApp(projectRoot);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/UPPERCASE_ID/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: makeAgentYaml() }),
    });

    expect(res.statusCode).toBe(400);
  });

  it('writes an audit log entry on successful PUT', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'audit-test.yaml'), makeAgentYaml());

    const app = await makeApp(projectRoot);
    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/audit-test/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: makeAgentYaml({ name: 'Audited' }) }),
    });
    expect(putRes.statusCode).toBe(200);

    // Verify audit entry was written by querying the audit endpoint
    const auditRes = await app.inject({ method: 'GET', url: '/api/v5/audit?limit=10' });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = auditRes.json<{ data: Array<{ action: string; target: string }> }>();
    const entry = auditBody.data.find(e => e.action === 'agent.raw.write' && e.target === 'audit-test');
    expect(entry).toBeDefined();
  });

  it('rejects empty yaml body with 400', async () => {
    const projectRoot = makeTmpRoot();
    const agentsDir = join(projectRoot, '.agentforge', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'empty-test.yaml'), makeAgentYaml());

    const app = await makeApp(projectRoot);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v5/agents/empty-test/raw',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ yaml: '   ' }),
    });

    expect(res.statusCode).toBe(400);
  });
});
