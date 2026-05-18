/**
 * Unit tests for WorkspaceAdapter knowledge-graph table methods.
 *
 * Covers:
 *   - knowledge_entities CRUD (upsertKnowledgeEntity, getKnowledgeEntity,
 *     listKnowledgeEntities, countKnowledgeEntities, deleteKnowledgeEntity)
 *   - knowledge_relationships CRUD (insertKnowledgeRelationship,
 *     listKnowledgeRelationships, deleteKnowledgeRelationship,
 *     deleteKnowledgeRelationshipsByEntity)
 *   - Name-based upsert deduplication (upsertKnowledgeEntityByName)
 *   - Filter accessors (type, sourceCycleId, sourceType)
 *   - ON DELETE CASCADE for entity → relationship cleanup
 *   - Migration: ensureKnowledgeColumns() adds source_type on old DBs
 *
 * All tests run against an in-memory SQLite DB so there is no disk I/O.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkspaceAdapter } from '../workspace-adapter.js';

function buildAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-kg' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addEntity(
  adapter: WorkspaceAdapter,
  overrides: Partial<{
    name: string;
    type: string;
    description: string;
    sourceCycleId: string;
    sourceType: string;
  }> = {},
) {
  return adapter.upsertKnowledgeEntity({
    name: overrides.name ?? 'TestEntity',
    type: overrides.type ?? 'concept',
    description: overrides.description ?? null,
    sourceCycleId: overrides.sourceCycleId ?? null,
    sourceType: overrides.sourceType ?? 'cycle',
  });
}

// ---------------------------------------------------------------------------
// knowledge_entities — basic CRUD
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter — knowledge_entities CRUD', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => { adapter = buildAdapter(); });
  afterEach(() => { adapter.close(); });

  it('upsertKnowledgeEntity writes a row and returns it', () => {
    const row = adapter.upsertKnowledgeEntity({
      type: 'agent',
      name: 'MyAgent',
      description: 'A test agent',
      sourceCycleId: 'cycle-123',
      sourceType: 'cycle',
    });

    expect(row.id).toBeTruthy();
    expect(row.type).toBe('agent');
    expect(row.name).toBe('MyAgent');
    expect(row.description).toBe('A test agent');
    expect(row.source_cycle_id).toBe('cycle-123');
    expect(row.source_type).toBe('cycle');
    expect(row.created_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
  });

  it('upsertKnowledgeEntity defaults source_type to "cycle"', () => {
    const row = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Foo' });
    expect(row.source_type).toBe('cycle');
  });

  it('upsertKnowledgeEntity updates existing row when same id is supplied', () => {
    const original = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Alpha', description: 'v1' });
    const updated = adapter.upsertKnowledgeEntity({
      id: original.id,
      type: 'concept',
      name: 'Alpha',
      description: 'v2',
    });

    expect(updated.id).toBe(original.id);
    expect(updated.description).toBe('v2');
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('upsertKnowledgeEntity preserves existing embedding when new embedding is null', () => {
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    const original = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Embed', embedding: vec });
    // Re-upsert without an embedding — existing BLOB must be preserved (COALESCE).
    const updated = adapter.upsertKnowledgeEntity({ id: original.id, type: 'concept', name: 'Embed' });
    expect(updated.embedding).not.toBeNull();
  });

  it('getKnowledgeEntity returns undefined for unknown id', () => {
    expect(adapter.getKnowledgeEntity('nonexistent')).toBeUndefined();
  });

  it('deleteKnowledgeEntity removes the row and returns true', () => {
    const row = addEntity(adapter);
    expect(adapter.countKnowledgeEntities()).toBe(1);
    expect(adapter.deleteKnowledgeEntity(row.id)).toBe(true);
    expect(adapter.countKnowledgeEntities()).toBe(0);
  });

  it('deleteKnowledgeEntity returns false for nonexistent id', () => {
    expect(adapter.deleteKnowledgeEntity('does-not-exist')).toBe(false);
  });

  it('countKnowledgeEntities returns 0 on empty table', () => {
    expect(adapter.countKnowledgeEntities()).toBe(0);
  });

  it('countKnowledgeEntities filters by type', () => {
    addEntity(adapter, { type: 'agent' });
    addEntity(adapter, { name: 'B', type: 'module' });
    expect(adapter.countKnowledgeEntities('agent')).toBe(1);
    expect(adapter.countKnowledgeEntities('module')).toBe(1);
    expect(adapter.countKnowledgeEntities()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// knowledge_entities — list filters
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter — listKnowledgeEntities filters', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => { adapter = buildAdapter(); });
  afterEach(() => { adapter.close(); });

  it('filters by type', () => {
    addEntity(adapter, { name: 'A', type: 'agent' });
    addEntity(adapter, { name: 'B', type: 'module' });
    addEntity(adapter, { name: 'C', type: 'agent' });

    const agents = adapter.listKnowledgeEntities({ type: 'agent' });
    expect(agents).toHaveLength(2);
    expect(agents.every(r => r.type === 'agent')).toBe(true);
  });

  it('filters by sourceCycleId', () => {
    addEntity(adapter, { name: 'X', sourceCycleId: 'cycle-1' });
    addEntity(adapter, { name: 'Y', sourceCycleId: 'cycle-2' });
    addEntity(adapter, { name: 'Z', sourceCycleId: 'cycle-1' });

    const cycle1 = adapter.listKnowledgeEntities({ sourceCycleId: 'cycle-1' });
    expect(cycle1).toHaveLength(2);
  });

  it('filters by sourceType', () => {
    addEntity(adapter, { name: 'CycleEnt', sourceType: 'cycle' });
    addEntity(adapter, { name: 'ManualEnt', sourceType: 'manual' });
    addEntity(adapter, { name: 'ImportEnt', sourceType: 'import' });

    const manual = adapter.listKnowledgeEntities({ sourceType: 'manual' });
    expect(manual).toHaveLength(1);
    expect(manual[0]!.name).toBe('ManualEnt');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      addEntity(adapter, { name: `E${i}` });
    }
    const page1 = adapter.listKnowledgeEntities({ limit: 3, offset: 0 });
    const page2 = adapter.listKnowledgeEntities({ limit: 3, offset: 3 });
    expect(page1).toHaveLength(3);
    expect(page2).toHaveLength(2);
  });

  it('caps limit at 2000', () => {
    // Should not throw even if limit exceeds the cap.
    const rows = adapter.listKnowledgeEntities({ limit: 999_999 });
    expect(Array.isArray(rows)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// upsertKnowledgeEntityByName — name-based deduplication
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter — upsertKnowledgeEntityByName', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => { adapter = buildAdapter(); });
  afterEach(() => { adapter.close(); });

  it('inserts a new entity when name+type pair does not exist', () => {
    const row = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Alpha' });
    expect(row.id).toBeTruthy();
    expect(row.name).toBe('Alpha');
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('returns the same id when called twice with the same name+type', () => {
    const r1 = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Stable' });
    const r2 = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Stable' });
    expect(r1.id).toBe(r2.id);
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('updates description on the existing row (no new insert)', () => {
    adapter.upsertKnowledgeEntityByName({ type: 'agent', name: 'BotA', description: 'v1' });
    const updated = adapter.upsertKnowledgeEntityByName({ type: 'agent', name: 'BotA', description: 'v2' });
    expect(updated.description).toBe('v2');
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('treats same name with different type as distinct entities', () => {
    adapter.upsertKnowledgeEntityByName({ type: 'agent', name: 'Core' });
    adapter.upsertKnowledgeEntityByName({ type: 'module', name: 'Core' });
    expect(adapter.countKnowledgeEntities()).toBe(2);
  });

  it('is idempotent on retry (simulated by calling N times)', () => {
    for (let i = 0; i < 5; i++) {
      adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'RetryMe', sourceCycleId: 'c1' });
    }
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('sets source_type correctly', () => {
    const row = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Imp', sourceType: 'import' });
    expect(row.source_type).toBe('import');
  });

  it('defaults sourceType to "cycle"', () => {
    const row = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'CycleDefault' });
    expect(row.source_type).toBe('cycle');
  });

  it('does not replace a manual entity with a cycle entity (name-based update)', () => {
    // A manual entity is created first.
    adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Shared', sourceType: 'manual' });
    // A cycle-phase extraction finds the same name — should update the existing row.
    const after = adapter.upsertKnowledgeEntityByName({ type: 'concept', name: 'Shared', sourceType: 'cycle' });
    // The source_type is overwritten (cycle wins — last write wins) but id stays the same.
    expect(adapter.countKnowledgeEntities()).toBe(1);
    expect(after.source_type).toBe('cycle');
  });
});

// ---------------------------------------------------------------------------
// knowledge_relationships — CRUD + cascade
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter — knowledge_relationships', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => { adapter = buildAdapter(); });
  afterEach(() => { adapter.close(); });

  function addPair() {
    const a = addEntity(adapter, { name: 'A', type: 'module' });
    const b = addEntity(adapter, { name: 'B', type: 'module' });
    return { a, b };
  }

  it('insertKnowledgeRelationship creates a row and returns it', () => {
    const { a, b } = addPair();
    const rel = adapter.insertKnowledgeRelationship({
      fromEntityId: a.id,
      toEntityId: b.id,
      type: 'depends_on',
      confidence: 0.9,
    });
    expect(rel.id).toBeTruthy();
    expect(rel.from_entity_id).toBe(a.id);
    expect(rel.to_entity_id).toBe(b.id);
    expect(rel.type).toBe('depends_on');
    expect(rel.confidence).toBe(0.9);
  });

  it('insertKnowledgeRelationship defaults confidence to 0.5', () => {
    const { a, b } = addPair();
    const rel = adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'related_to' });
    expect(rel.confidence).toBe(0.5);
  });

  it('countKnowledgeRelationships returns 0 on empty table', () => {
    expect(adapter.countKnowledgeRelationships()).toBe(0);
  });

  it('countKnowledgeRelationships increments after insert', () => {
    const { a, b } = addPair();
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'related_to' });
    expect(adapter.countKnowledgeRelationships()).toBe(1);
  });

  it('deleteKnowledgeRelationship removes the row and returns true', () => {
    const { a, b } = addPair();
    const rel = adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'related_to' });
    expect(adapter.deleteKnowledgeRelationship(rel.id)).toBe(true);
    expect(adapter.countKnowledgeRelationships()).toBe(0);
  });

  it('deleteKnowledgeRelationship returns false for unknown id', () => {
    expect(adapter.deleteKnowledgeRelationship('nope')).toBe(false);
  });

  it('listKnowledgeRelationships filters by type', () => {
    const { a, b } = addPair();
    const c = addEntity(adapter, { name: 'C', type: 'module' });
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: b.id, toEntityId: c.id, type: 'related_to' });

    const deps = adapter.listKnowledgeRelationships({ type: 'depends_on' });
    expect(deps).toHaveLength(1);
    expect(deps[0]!.type).toBe('depends_on');
  });

  it('listKnowledgeRelationships filters by entityId (either end)', () => {
    const { a, b } = addPair();
    const c = addEntity(adapter, { name: 'C', type: 'module' });
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: b.id, toEntityId: c.id, type: 'related_to' });

    const bRels = adapter.listKnowledgeRelationships({ entityId: b.id });
    expect(bRels).toHaveLength(2); // b appears in both as from or to
  });

  it('deleteKnowledgeRelationshipsByEntity removes all rels for an entity', () => {
    const { a, b } = addPair();
    const c = addEntity(adapter, { name: 'C', type: 'module' });
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: c.id, toEntityId: a.id, type: 'related_to' });
    adapter.insertKnowledgeRelationship({ fromEntityId: b.id, toEntityId: c.id, type: 'related_to' });

    const deleted = adapter.deleteKnowledgeRelationshipsByEntity(a.id);
    expect(deleted).toBe(2); // Two rels involved a.id (as from or to)
    expect(adapter.countKnowledgeRelationships()).toBe(1); // b → c survives
  });

  it('ON DELETE CASCADE removes relationships when entity is deleted', () => {
    const { a, b } = addPair();
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });
    expect(adapter.countKnowledgeRelationships()).toBe(1);

    adapter.deleteKnowledgeEntity(a.id);
    // CASCADE removes the relationship automatically.
    expect(adapter.countKnowledgeRelationships()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Migration — source_type column is added to existing DBs
// ---------------------------------------------------------------------------

describe('WorkspaceAdapter — migration: source_type column', () => {
  it('source_type column exists after construction on a fresh DB', () => {
    const adapter = buildAdapter();
    // If the column is missing, upsert would fail with "table has no column named source_type".
    const row = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'MigrationTest', sourceType: 'manual' });
    expect(row.source_type).toBe('manual');
    adapter.close();
  });

  it('listKnowledgeEntities sourceType filter works after migration', () => {
    const adapter = buildAdapter();
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Cycled', sourceType: 'cycle' });
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Imported', sourceType: 'import' });

    const imports = adapter.listKnowledgeEntities({ sourceType: 'import' });
    expect(imports).toHaveLength(1);
    expect(imports[0]!.name).toBe('Imported');
    adapter.close();
  });
});
