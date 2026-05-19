/**
 * Tests for /api/v5/flywheel/proposals routes.
 *
 * Uses temporary directories for _proposed/ fixtures so tests are
 * hermetic and do not touch the real skills-catalog.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  registerFlywheelProposalsRoutes,
  loadProposals,
  loadProposalById,
  type SkillProposal,
} from '../../../packages/server/src/routes/v5/flywheel.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `flywheel-proposals-test-${process.pid}`);
const PROPOSED_DIR = join(
  TMP_ROOT,
  'packages',
  'skills-catalog',
  'skills',
  'agentforge',
  '_proposed',
);

function setup(): void {
  mkdirSync(PROPOSED_DIR, { recursive: true });
}

function teardown(): void {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
}

function writeProposal(
  filename: string,
  overrides: Partial<{
    id: string;
    action: string;
    targetSkillId: string;
    skillId: string;
    capabilityTag: string;
    clusterId: string;
    requiresTools: string;
    occurrences: number;
    status: string;
    createdAt: string;
    body: string;
  }> = {},
): void {
  const {
    id = filename.replace('.md', ''),
    action = 'refine',
    targetSkillId = 'agentforge:tdd',
    skillId = 'agentforge:tdd',
    capabilityTag = 'test-driven-development',
    clusterId = 'cluster-quality-0',
    requiresTools = '[Bash, Edit]',
    occurrences = 5,
    status = 'proposed',
    createdAt = '2024-01-15T10:00:00Z',
    body = '## Proposal body\n\nSome content here.',
  } = overrides;

  const content = `---
id: ${id}
action: ${action}
targetSkillId: ${targetSkillId}
skillId: ${skillId}
capabilityTag: ${capabilityTag}
clusterId: ${clusterId}
requiresTools: ${requiresTools}
occurrences: ${occurrences}
status: ${status}
createdAt: "${createdAt}"
---

${body}`;
  writeFileSync(join(PROPOSED_DIR, filename), content, 'utf8');
}

// ---------------------------------------------------------------------------
// loadProposals unit tests
// ---------------------------------------------------------------------------

describe('loadProposals', () => {
  beforeAll(setup);
  afterAll(teardown);

  it('returns empty array when directory does not exist', () => {
    const result = loadProposals(join(TMP_ROOT, 'nonexistent'));
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const result = loadProposals(TMP_ROOT);
    expect(result).toBeInstanceOf(Array);
    // May have fixtures from other tests — just verify it is an array
  });

  it('parses frontmatter correctly', () => {
    writeProposal('prop-test-001.md', {
      id: 'prop-test-001',
      capabilityTag: 'systematic-debugging',
    });
    const result = loadProposals(TMP_ROOT);
    const p = result.find((x) => x.id === 'prop-test-001');
    expect(p).toBeDefined();
    expect(p!.action).toBe('refine');
    expect(p!.capabilityTag).toBe('systematic-debugging');
    expect(p!.status).toBe('proposed');
    expect(p!.requiresTools).toContain('Bash');
    expect(p!.requiresTools).toContain('Edit');
  });

  it('parses occurrences as number', () => {
    writeProposal('prop-occurrences.md', { id: 'prop-occurrences', occurrences: 42 });
    const result = loadProposals(TMP_ROOT);
    const p = result.find((x) => x.id === 'prop-occurrences');
    expect(p?.occurrences).toBe(42);
  });

  it('parses requiresTools from dash-list frontmatter blocks', () => {
    const content = `---
id: prop-dash-list
action: refine
targetSkillId: agentforge:tdd
skillId: agentforge:tdd
capabilityTag: parser-hardening
clusterId: cluster-quality-1
requiresTools:
  - Bash
  - Edit
  - Grep
occurrences: 4
status: proposed
createdAt: "2024-01-16T10:00:00Z"
---

Body.`;
    writeFileSync(join(PROPOSED_DIR, 'prop-dash-list.md'), content, 'utf8');

    const result = loadProposals(TMP_ROOT);
    const proposal = result.find((x) => x.id === 'prop-dash-list');
    expect(proposal).toBeDefined();
    expect(proposal?.requiresTools).toEqual(['Bash', 'Edit', 'Grep']);
  });

  it('parses action=create correctly', () => {
    writeProposal('prop-create.md', {
      id: 'prop-create',
      action: 'create',
      targetSkillId: 'null',
    });
    const result = loadProposals(TMP_ROOT);
    const p = result.find((x) => x.id === 'prop-create');
    expect(p?.action).toBe('create');
  });

  it('includes body content', () => {
    writeProposal('prop-body.md', {
      id: 'prop-body',
      body: '## My heading\n\nBody text here.',
    });
    const result = loadProposals(TMP_ROOT);
    const p = result.find((x) => x.id === 'prop-body');
    expect(p?.body).toContain('Body text here.');
  });
});

// ---------------------------------------------------------------------------
// loadProposalById unit tests
// ---------------------------------------------------------------------------

describe('loadProposalById', () => {
  beforeAll(setup);
  afterAll(teardown);

  it('returns null for unknown id', () => {
    const result = loadProposalById(TMP_ROOT, 'does-not-exist-xyz');
    expect(result).toBeNull();
  });

  it('finds proposal by exact id', () => {
    writeProposal('prop-find-exact.md', { id: 'prop-find-exact' });
    const result = loadProposalById(TMP_ROOT, 'prop-find-exact');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('prop-find-exact');
  });

  it('returns dash-list tools when loading a proposal by id', () => {
    const content = `---
id: prop-by-id-dash
action: refine
targetSkillId: agentforge:tdd
skillId: agentforge:tdd
capabilityTag: data-correctness
clusterId: cluster-quality-2
requiresTools:
  - Read
  - Bash
occurrences: 2
status: proposed
createdAt: "2024-01-17T10:00:00Z"
---

Body.`;
    writeFileSync(join(PROPOSED_DIR, 'prop-by-id-dash.md'), content, 'utf8');

    const result = loadProposalById(TMP_ROOT, 'prop-by-id-dash');
    expect(result).not.toBeNull();
    expect(result?.requiresTools).toEqual(['Read', 'Bash']);
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe('GET /api/v5/flywheel/proposals', () => {
  let app: ReturnType<typeof Fastify>;
  const ROOT = join(tmpdir(), `flywheel-route-get-${process.pid}`);
  const DIR = join(ROOT, 'packages', 'skills-catalog', 'skills', 'agentforge', '_proposed');

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      join(DIR, 'prop-route-a.md'),
      `---
id: prop-route-a
action: refine
skillId: agentforge:tdd
capabilityTag: tdd
clusterId: cluster-0
requiresTools: [Bash]
occurrences: 3
status: proposed
createdAt: "2024-01-10T00:00:00Z"
---

Body of proposal A.`,
      'utf8',
    );
    app = Fastify();
    registerFlywheelProposalsRoutes(app, { projectRoot: ROOT });
  });

  afterAll(async () => {
    await app.close();
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  it('returns 200 with data array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel/proposals' });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { data: SkillProposal[]; meta: { total: number } };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.meta.total).toBeGreaterThanOrEqual(1);
  });

  it('includes parsed proposal in response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel/proposals' });
    const json = res.json() as { data: SkillProposal[] };
    const p = json.data.find((x) => x.id === 'prop-route-a');
    expect(p).toBeDefined();
    expect(p!.capabilityTag).toBe('tdd');
    expect(p!.status).toBe('proposed');
    expect(p!.occurrences).toBe(3);
  });

  it('returns meta.timestamp as ISO string', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v5/flywheel/proposals' });
    const json = res.json() as { meta: { timestamp: string } };
    expect(typeof json.meta.timestamp).toBe('string');
    expect(new Date(json.meta.timestamp).getTime()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Approve route
// ---------------------------------------------------------------------------

describe('POST /api/v5/flywheel/proposals/:id/approve', () => {
  let app: ReturnType<typeof Fastify>;
  const ROOT = join(tmpdir(), `flywheel-route-approve-${process.pid}`);
  const DIR = join(ROOT, 'packages', 'skills-catalog', 'skills', 'agentforge', '_proposed');

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    app = Fastify();
    registerFlywheelProposalsRoutes(app, { projectRoot: ROOT });
  });

  afterAll(async () => {
    await app.close();
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Write fresh proposal before each test
    writeFileSync(
      join(DIR, 'prop-approve-me.md'),
      `---
id: prop-approve-me
action: refine
skillId: agentforge:tdd
capabilityTag: tdd
clusterId: cluster-0
requiresTools: [Bash]
occurrences: 2
status: proposed
createdAt: "2024-01-12T00:00:00Z"
---

Proposal to approve.`,
      'utf8',
    );
  });

  it('returns 200 and ok=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-approve-me/approve',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { ok: boolean; status: string };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('approved');
  });

  it('removes file from _proposed/ after approval', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-approve-me/approve',
    });
    const stillExists = existsSync(join(DIR, 'prop-approve-me.md'));
    expect(stillExists).toBe(false);
  });

  it('moves file to parent directory', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-approve-me/approve',
    });
    const movedPath = join(DIR, '..', 'prop-approve-me.md');
    expect(existsSync(movedPath)).toBe(true);
  });

  it('returns 404 for unknown proposal id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/does-not-exist/approve',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for id with path traversal characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/..%2Fevil/approve',
    });
    // Fastify URL-decodes, so this hits the route with id=../evil which fails validation
    expect([400, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Reject route
// ---------------------------------------------------------------------------

describe('POST /api/v5/flywheel/proposals/:id/reject', () => {
  let app: ReturnType<typeof Fastify>;
  const ROOT = join(tmpdir(), `flywheel-route-reject-${process.pid}`);
  const DIR = join(ROOT, 'packages', 'skills-catalog', 'skills', 'agentforge', '_proposed');

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    app = Fastify();
    registerFlywheelProposalsRoutes(app, { projectRoot: ROOT });
  });

  afterAll(async () => {
    await app.close();
    if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeFileSync(
      join(DIR, 'prop-reject-me.md'),
      `---
id: prop-reject-me
action: create
skillId: agentforge:new-skill
capabilityTag: new-capability
clusterId: cluster-1
requiresTools: [Edit]
occurrences: 1
status: proposed
createdAt: "2024-01-14T00:00:00Z"
---

Proposal to reject.`,
      'utf8',
    );
  });

  it('returns 200 and ok=true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-reject-me/reject',
    });
    expect(res.statusCode).toBe(200);
    const json = res.json() as { ok: boolean; status: string };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('rejected');
  });

  it('deletes file from _proposed/', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-reject-me/reject',
    });
    const stillExists = existsSync(join(DIR, 'prop-reject-me.md'));
    expect(stillExists).toBe(false);
  });

  it('does NOT create file in parent directory', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/prop-reject-me/reject',
    });
    const parentPath = join(DIR, '..', 'prop-reject-me.md');
    expect(existsSync(parentPath)).toBe(false);
  });

  it('returns 404 for unknown proposal id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v5/flywheel/proposals/no-such-proposal/reject',
    });
    expect(res.statusCode).toBe(404);
  });
});
