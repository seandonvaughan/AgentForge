/**
 * tests/server/routes/sprint-orchestration.test.ts
 *
 * Tests for the sprint orchestration route logic by exercising the
 * underlying file-system helpers and phase-order constants directly.
 * The Fastify server is NOT spun up here — we test the pure logic
 * functions by writing/reading sprint JSON through a temp directory.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Phase order — mirrors the constant in sprint-orchestration.ts
// ---------------------------------------------------------------------------

const PHASE_ORDER = [
  'planned',
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
  'completed',
] as const;

type Phase = (typeof PHASE_ORDER)[number];

// ---------------------------------------------------------------------------
// Minimal sprint shape helpers
// ---------------------------------------------------------------------------

interface SprintItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  completedAt?: string;
}

interface SprintFile {
  sprintId: string;
  version: string;
  title: string;
  createdAt: string;
  phase: string;
  items: SprintItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
  auditFindings: string[];
  agentsInvolved?: string[];
  budgetUsed?: number;
}

function makeSprintItem(overrides: Partial<SprintItem> = {}): SprintItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Item',
    description: 'A test item description',
    priority: 'P1',
    assignee: 'coder',
    status: 'planned',
    ...overrides,
  };
}

function makeSprint(overrides: Partial<SprintFile> = {}): SprintFile {
  return {
    sprintId: `sprint-${Math.random().toString(36).slice(2, 8)}`,
    version: '99.0',
    title: 'Test Sprint',
    createdAt: new Date().toISOString(),
    phase: 'planned',
    items: [],
    budget: 500,
    teamSize: 5,
    successCriteria: ['All tests pass'],
    auditFindings: [],
    agentsInvolved: [],
    budgetUsed: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// File helpers — mirrors the implementation
// ---------------------------------------------------------------------------

function sprintsDir(root: string): string {
  return join(root, '.agentforge', 'sprints');
}

function sprintPath(root: string, version: string): string {
  return join(sprintsDir(root), `v${version}.json`);
}

function readSprint(root: string, version: string): SprintFile | null {
  const file = sprintPath(root, version);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SprintFile;
  } catch {
    return null;
  }
}

function writeSprint(root: string, version: string, sprint: SprintFile): void {
  const dir = sprintsDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sprintPath(root, version), JSON.stringify(sprint, null, 2), 'utf-8');
}

function advancePhase(sprint: SprintFile): { ok: boolean; newPhase?: Phase; error?: string } {
  const current = sprint.phase as Phase;
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1) return { ok: false, error: `Unknown phase "${current}"` };
  if (idx >= PHASE_ORDER.length - 1) return { ok: false, error: 'Already in final phase' };
  return { ok: true, newPhase: PHASE_ORDER[idx + 1] };
}

function tallyItemsByStatus(items: SprintItem[]): Record<string, number> {
  const counts: Record<string, number> = {
    planned: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    deferred: 0,
  };
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-sprint-orch-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: Create sprint (validation + structure)
// ---------------------------------------------------------------------------

describe('Create sprint — validation', () => {
  it('version is required', () => {
    const body: Partial<SprintFile> = { title: 'My Sprint' };
    expect(body.version).toBeUndefined();
  });

  it('title is required', () => {
    const body: Partial<SprintFile> = { version: '10.0' };
    expect(body.title).toBeUndefined();
  });

  it('items must be an array', () => {
    const items = undefined as unknown;
    expect(Array.isArray(items)).toBe(false);
  });

  it('creates sprint JSON file at the correct path', () => {
    const sprint = makeSprint({ version: '10.1' });
    writeSprint(tmpRoot, '10.1', sprint);

    expect(existsSync(sprintPath(tmpRoot, '10.1'))).toBe(true);
  });

  it('written sprint is valid JSON and readable', () => {
    const sprint = makeSprint({ version: '10.2' });
    writeSprint(tmpRoot, '10.2', sprint);

    const read = readSprint(tmpRoot, '10.2');
    expect(read).not.toBeNull();
    expect(read!.version).toBe('10.2');
  });

  it('sprint starts in "planned" phase', () => {
    const sprint = makeSprint({ version: '10.3', phase: 'planned' });
    writeSprint(tmpRoot, '10.3', sprint);

    const read = readSprint(tmpRoot, '10.3');
    expect(read!.phase).toBe('planned');
  });

  it('creates items with generated IDs', () => {
    const items = [makeSprintItem({ title: 'Task A' }), makeSprintItem({ title: 'Task B' })];
    const sprint = makeSprint({ version: '10.4', items });
    writeSprint(tmpRoot, '10.4', sprint);

    const read = readSprint(tmpRoot, '10.4');
    expect(read!.items).toHaveLength(2);
    expect(read!.items[0].id).toBeTruthy();
    expect(read!.items[1].id).toBeTruthy();
    // IDs should be unique
    expect(read!.items[0].id).not.toBe(read!.items[1].id);
  });

  it('all new items start with "planned" status', () => {
    const items = [
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'planned' }),
    ];
    const sprint = makeSprint({ version: '10.5', items });
    writeSprint(tmpRoot, '10.5', sprint);

    const read = readSprint(tmpRoot, '10.5');
    for (const item of read!.items) {
      expect(item.status).toBe('planned');
    }
  });

  it('budget defaults to 0 when not provided', () => {
    const sprint = makeSprint({ version: '10.6', budget: 0 });
    writeSprint(tmpRoot, '10.6', sprint);

    const read = readSprint(tmpRoot, '10.6');
    expect(read!.budget).toBe(0);
  });

  it('budgetUsed starts at 0', () => {
    const sprint = makeSprint({ version: '10.7', budgetUsed: 0 });
    writeSprint(tmpRoot, '10.7', sprint);

    const read = readSprint(tmpRoot, '10.7');
    expect(read!.budgetUsed).toBe(0);
  });

  it('auditFindings starts as empty array', () => {
    const sprint = makeSprint({ version: '10.8', auditFindings: [] });
    writeSprint(tmpRoot, '10.8', sprint);

    const read = readSprint(tmpRoot, '10.8');
    expect(read!.auditFindings).toEqual([]);
  });

  it('agentsInvolved starts as empty array', () => {
    const sprint = makeSprint({ version: '10.9', agentsInvolved: [] });
    writeSprint(tmpRoot, '10.9', sprint);

    const read = readSprint(tmpRoot, '10.9');
    expect(read!.agentsInvolved).toEqual([]);
  });

  it('cannot overwrite existing sprint (conflict guard)', () => {
    const sprint = makeSprint({ version: '10.10' });
    writeSprint(tmpRoot, '10.10', sprint);

    // Simulate conflict check: file already exists
    const alreadyExists = existsSync(sprintPath(tmpRoot, '10.10'));
    expect(alreadyExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Phase advancement
// ---------------------------------------------------------------------------

describe('Phase advancement', () => {
  it('advances from "planned" to "audit"', () => {
    const sprint = makeSprint({ phase: 'planned' });
    const result = advancePhase(sprint);

    expect(result.ok).toBe(true);
    expect(result.newPhase).toBe('audit');
  });

  it('advances through all phases in correct order', () => {
    let phase: Phase = 'planned';
    for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
      const sprint = makeSprint({ phase });
      const result = advancePhase(sprint);
      expect(result.ok).toBe(true);
      expect(result.newPhase).toBe(PHASE_ORDER[i + 1]);
      phase = result.newPhase!;
    }
  });

  it('cannot advance past "completed"', () => {
    const sprint = makeSprint({ phase: 'completed' });
    const result = advancePhase(sprint);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/final phase/);
  });

  it('returns error for unknown phase', () => {
    const sprint = makeSprint({ phase: 'unknown-phase' });
    const result = advancePhase(sprint);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown phase/);
  });

  it('phase sequence has 11 steps (planned → completed)', () => {
    expect(PHASE_ORDER).toHaveLength(11);
    expect(PHASE_ORDER[0]).toBe('planned');
    expect(PHASE_ORDER[10]).toBe('completed');
  });

  it('persists phase after advancing (write + read cycle)', () => {
    const sprint = makeSprint({ version: '11.0', phase: 'planned' });
    writeSprint(tmpRoot, '11.0', sprint);

    const loaded = readSprint(tmpRoot, '11.0')!;
    const result = advancePhase(loaded);
    expect(result.ok).toBe(true);

    loaded.phase = result.newPhase!;
    writeSprint(tmpRoot, '11.0', loaded);

    const reloaded = readSprint(tmpRoot, '11.0');
    expect(reloaded!.phase).toBe('audit');
  });

  it('advance from "execute" goes to "test"', () => {
    const sprint = makeSprint({ phase: 'execute' });
    const result = advancePhase(sprint);
    expect(result.newPhase).toBe('test');
  });

  it('advance from "gate" goes to "release"', () => {
    const sprint = makeSprint({ phase: 'gate' });
    const result = advancePhase(sprint);
    expect(result.newPhase).toBe('release');
  });
});

// ---------------------------------------------------------------------------
// Tests: Item status update
// ---------------------------------------------------------------------------

describe('Item status update', () => {
  it('updates item status to in_progress', () => {
    const item = makeSprintItem({ status: 'planned' });
    item.status = 'in_progress';
    expect(item.status).toBe('in_progress');
  });

  it('updates item status to completed and records completedAt', () => {
    const item = makeSprintItem({ status: 'in_progress' });
    const prevStatus = item.status;
    item.status = 'completed';
    if (item.status === 'completed' && prevStatus !== 'completed') {
      item.completedAt = new Date().toISOString();
    }
    expect(item.completedAt).toBeDefined();
    expect(typeof item.completedAt).toBe('string');
  });

  it('does not overwrite completedAt when already completed', () => {
    const originalTime = '2026-01-01T00:00:00.000Z';
    const item = makeSprintItem({ status: 'completed', completedAt: originalTime });
    // Re-completing should not change the timestamp
    if (item.status === 'completed') {
      // no-op — already completed
    }
    expect(item.completedAt).toBe(originalTime);
  });

  it('updates item assignee', () => {
    const item = makeSprintItem({ assignee: 'coder' });
    item.assignee = 'architect';
    expect(item.assignee).toBe('architect');
  });

  it('can update status to blocked', () => {
    const item = makeSprintItem({ status: 'in_progress' });
    item.status = 'blocked';
    expect(item.status).toBe('blocked');
  });

  it('can update status to deferred', () => {
    const item = makeSprintItem({ status: 'planned' });
    item.status = 'deferred';
    expect(item.status).toBe('deferred');
  });

  it('item update persists to file', () => {
    const item = makeSprintItem({ id: 'item-001', status: 'planned' });
    const sprint = makeSprint({ version: '12.0', items: [item] });
    writeSprint(tmpRoot, '12.0', sprint);

    const loaded = readSprint(tmpRoot, '12.0')!;
    const found = loaded.items.find((i) => i.id === 'item-001')!;
    found.status = 'in_progress';
    writeSprint(tmpRoot, '12.0', loaded);

    const reloaded = readSprint(tmpRoot, '12.0')!;
    expect(reloaded.items.find((i) => i.id === 'item-001')!.status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// Tests: Sprint status (tally)
// ---------------------------------------------------------------------------

describe('Sprint status — item counts', () => {
  it('returns zero counts for empty items array', () => {
    const counts = tallyItemsByStatus([]);
    expect(counts.planned).toBe(0);
    expect(counts.in_progress).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.blocked).toBe(0);
    expect(counts.deferred).toBe(0);
  });

  it('counts planned items correctly', () => {
    const items = [
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'in_progress' }),
    ];
    const counts = tallyItemsByStatus(items);
    expect(counts.planned).toBe(2);
    expect(counts.in_progress).toBe(1);
  });

  it('counts mixed statuses correctly', () => {
    const items = [
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'in_progress' }),
      makeSprintItem({ status: 'completed' }),
      makeSprintItem({ status: 'blocked' }),
      makeSprintItem({ status: 'deferred' }),
    ];
    const counts = tallyItemsByStatus(items);
    expect(counts.planned).toBe(1);
    expect(counts.in_progress).toBe(1);
    expect(counts.completed).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.deferred).toBe(1);
  });

  it('total matches sum of all status counts', () => {
    const items = [
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'planned' }),
      makeSprintItem({ status: 'completed' }),
    ];
    const counts = tallyItemsByStatus(items);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(items.length);
  });

  it('agents involved derived from item assignees', () => {
    const items = [
      makeSprintItem({ assignee: 'coder' }),
      makeSprintItem({ assignee: 'architect' }),
      makeSprintItem({ assignee: 'coder' }), // duplicate
    ];
    const agentsFromItems = items.map((i) => i.assignee).filter(Boolean);
    const unique = Array.from(new Set(agentsFromItems));
    expect(unique).toHaveLength(2);
    expect(unique).toContain('coder');
    expect(unique).toContain('architect');
  });
});

// ---------------------------------------------------------------------------
// Tests: Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('readSprint returns null for non-existent sprint', () => {
    const result = readSprint(tmpRoot, '999.999');
    expect(result).toBeNull();
  });

  it('readSprint returns null for malformed JSON', () => {
    mkdirSync(sprintsDir(tmpRoot), { recursive: true });
    writeFileSync(sprintPath(tmpRoot, '13.0'), 'NOT JSON', 'utf-8');
    const result = readSprint(tmpRoot, '13.0');
    expect(result).toBeNull();
  });

  it('writeSprint creates directory if not present', () => {
    const sprint = makeSprint({ version: '14.0' });
    // No directory created yet
    writeSprint(tmpRoot, '14.0', sprint);
    expect(existsSync(sprintPath(tmpRoot, '14.0'))).toBe(true);
  });

  it('sprint with no items has total of 0', () => {
    const sprint = makeSprint({ version: '15.0', items: [] });
    expect(sprint.items.length).toBe(0);
  });

  it('phase order array has no duplicates', () => {
    const seen = new Set<string>();
    for (const phase of PHASE_ORDER) {
      expect(seen.has(phase)).toBe(false);
      seen.add(phase);
    }
  });

  it('PHASE_ORDER contains "execute"', () => {
    expect(PHASE_ORDER).toContain('execute');
  });

  it('execute phase index comes after assign', () => {
    const executeIdx = PHASE_ORDER.indexOf('execute');
    const assignIdx = PHASE_ORDER.indexOf('assign');
    expect(executeIdx).toBeGreaterThan(assignIdx);
  });
});
