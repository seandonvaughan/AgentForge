/**
 * Tests for knowledge_entities and knowledge_relationships SQLite tables
 * via WorkspaceAdapter.
 *
 * Verifies that:
 *   - CREATE TABLE IF NOT EXISTS migration runs cleanly on a fresh DB
 *   - All CRUD methods persist to and read from SQLite correctly
 *   - ON DELETE CASCADE removes relationships when an entity is deleted
 *   - upsertKnowledgeEntity is idempotent on repeated calls with the same id
 *   - Filters (type, sourceCycleId, entityId) work correctly
 *   - Embedding BLOBs round-trip correctly
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceAdapter } from '@agentforge/db';

function makeAdapter(): WorkspaceAdapter {
  return new WorkspaceAdapter({ dbPath: ':memory:', workspaceId: 'test-ws' });
}

// ── Schema migration ───────────────────────────────────────────────────────────

describe('knowledge_entities and knowledge_relationships — schema migration', () => {
  it('initialises tables without error on a fresh in-memory DB', () => {
    // If CREATE TABLE IF NOT EXISTS fails the constructor would throw.
    expect(() => makeAdapter()).not.toThrow();
  });

  it('tables are queryable immediately after construction', () => {
    const adapter = makeAdapter();
    // Both tables must exist — if they don't, listKnowledge* would throw.
    expect(adapter.listKnowledgeEntities()).toEqual([]);
    expect(adapter.listKnowledgeRelationships()).toEqual([]);
    adapter.close();
  });
});

// ── Entity CRUD ────────────────────────────────────────────────────────────────

describe('WorkspaceAdapter — knowledge_entities CRUD', () => {
  let adapter: WorkspaceAdapter;

  beforeEach(() => {
    adapter = makeAdapter();
  });

  it('upsertKnowledgeEntity inserts a new entity and returns the row', () => {
    const entity = adapter.upsertKnowledgeEntity({
      type: 'agent',
      name: 'SprintPlanner',
      description: 'Plans sprints for the team',
      sourceCycleId: 'cycle-001',
    });
    expect(entity.id).toBeTruthy();
    expect(entity.type).toBe('agent');
    expect(entity.name).toBe('SprintPlanner');
    expect(entity.description).toBe('Plans sprints for the team');
    expect(entity.source_cycle_id).toBe('cycle-001');
    expect(entity.created_at).toBeTruthy();
  });

  it('upsertKnowledgeEntity with an explicit id is idempotent — updates on conflict', () => {
    const first = adapter.upsertKnowledgeEntity({
      id: 'entity-abc',
      type: 'module',
      name: 'CoreModule',
    });
    const second = adapter.upsertKnowledgeEntity({
      id: 'entity-abc',
      type: 'module',
      name: 'CoreModule',
      description: 'Updated description',
    });
    // Same row — id must match
    expect(second.id).toBe(first.id);
    expect(second.description).toBe('Updated description');
    // Only one row should exist
    expect(adapter.countKnowledgeEntities()).toBe(1);
  });

  it('getKnowledgeEntity retrieves a persisted entity', () => {
    const created = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'GraphNode' });
    const found = adapter.getKnowledgeEntity(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('GraphNode');
  });

  it('getKnowledgeEntity returns undefined for a missing id', () => {
    expect(adapter.getKnowledgeEntity('nonexistent-id')).toBeUndefined();
  });

  it('listKnowledgeEntities returns all entities when no filter', () => {
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'Alpha' });
    adapter.upsertKnowledgeEntity({ type: 'module', name: 'Beta' });
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'Gamma' });
    expect(adapter.listKnowledgeEntities()).toHaveLength(3);
  });

  it('listKnowledgeEntities filters by type', () => {
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'AgentA' });
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'AgentB' });
    adapter.upsertKnowledgeEntity({ type: 'module', name: 'ModX' });

    const agents = adapter.listKnowledgeEntities({ type: 'agent' });
    expect(agents).toHaveLength(2);
    expect(agents.every(e => e.type === 'agent')).toBe(true);
  });

  it('listKnowledgeEntities filters by sourceCycleId', () => {
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C1', sourceCycleId: 'cycle-A' });
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C2', sourceCycleId: 'cycle-A' });
    adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C3', sourceCycleId: 'cycle-B' });

    const cycleA = adapter.listKnowledgeEntities({ sourceCycleId: 'cycle-A' });
    expect(cycleA).toHaveLength(2);
    expect(cycleA.every(e => e.source_cycle_id === 'cycle-A')).toBe(true);
  });

  it('listKnowledgeEntities respects limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      adapter.upsertKnowledgeEntity({ type: 'concept', name: `Entity${i}` });
    }
    const page1 = adapter.listKnowledgeEntities({ limit: 4, offset: 0 });
    const page2 = adapter.listKnowledgeEntities({ limit: 4, offset: 4 });
    expect(page1).toHaveLength(4);
    expect(page2).toHaveLength(4);
    const ids1 = new Set(page1.map(e => e.id));
    const ids2 = new Set(page2.map(e => e.id));
    // No overlap between pages
    for (const id of ids2) {
      expect(ids1.has(id)).toBe(false);
    }
  });

  it('countKnowledgeEntities returns correct total', () => {
    expect(adapter.countKnowledgeEntities()).toBe(0);
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'A1' });
    adapter.upsertKnowledgeEntity({ type: 'module', name: 'M1' });
    expect(adapter.countKnowledgeEntities()).toBe(2);
  });

  it('countKnowledgeEntities filters by type', () => {
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'A1' });
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'A2' });
    adapter.upsertKnowledgeEntity({ type: 'module', name: 'M1' });
    expect(adapter.countKnowledgeEntities('agent')).toBe(2);
    expect(adapter.countKnowledgeEntities('module')).toBe(1);
    expect(adapter.countKnowledgeEntities('concept')).toBe(0);
  });

  it('deleteKnowledgeEntity removes the entity and returns true', () => {
    const entity = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'ToDelete' });
    const deleted = adapter.deleteKnowledgeEntity(entity.id);
    expect(deleted).toBe(true);
    expect(adapter.getKnowledgeEntity(entity.id)).toBeUndefined();
    expect(adapter.countKnowledgeEntities()).toBe(0);
  });

  it('deleteKnowledgeEntity returns false for a missing id', () => {
    expect(adapter.deleteKnowledgeEntity('nonexistent')).toBe(false);
  });
});

// ── Embedding BLOB round-trip ─────────────────────────────────────────────────

describe('WorkspaceAdapter — knowledge_entities embedding BLOB', () => {
  it('stores and retrieves a Float32Array embedding', () => {
    const adapter = makeAdapter();
    const vector = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
    const entity = adapter.upsertKnowledgeEntity({
      type: 'concept',
      name: 'EmbeddedConcept',
      embedding: vector,
    });

    const found = adapter.getKnowledgeEntity(entity.id);
    expect(found).toBeDefined();
    // The DB stores it as a Buffer; the raw row's embedding should be non-null
    expect(found!.embedding).not.toBeNull();
    adapter.close();
  });

  it('null embedding is stored and retrieved as null', () => {
    const adapter = makeAdapter();
    const entity = adapter.upsertKnowledgeEntity({
      type: 'concept',
      name: 'NoEmbedding',
      embedding: null,
    });
    const found = adapter.getKnowledgeEntity(entity.id);
    expect(found!.embedding).toBeNull();
    adapter.close();
  });
});

// ── Relationship CRUD ──────────────────────────────────────────────────────────

describe('WorkspaceAdapter — knowledge_relationships CRUD', () => {
  let adapter: WorkspaceAdapter;
  let entityA: ReturnType<WorkspaceAdapter['getKnowledgeEntity']>;
  let entityB: ReturnType<WorkspaceAdapter['getKnowledgeEntity']>;

  beforeEach(() => {
    adapter = makeAdapter();
    entityA = adapter.upsertKnowledgeEntity({ type: 'module', name: 'ModuleA' });
    entityB = adapter.upsertKnowledgeEntity({ type: 'module', name: 'ModuleB' });
  });

  it('insertKnowledgeRelationship creates a relationship row', () => {
    const rel = adapter.insertKnowledgeRelationship({
      fromEntityId: entityA!.id,
      toEntityId: entityB!.id,
      type: 'depends_on',
      confidence: 0.9,
    });
    expect(rel.id).toBeTruthy();
    expect(rel.from_entity_id).toBe(entityA!.id);
    expect(rel.to_entity_id).toBe(entityB!.id);
    expect(rel.type).toBe('depends_on');
    expect(rel.confidence).toBe(0.9);
    expect(rel.created_at).toBeTruthy();
  });

  it('insertKnowledgeRelationship defaults confidence to 0.5', () => {
    const rel = adapter.insertKnowledgeRelationship({
      fromEntityId: entityA!.id,
      toEntityId: entityB!.id,
      type: 'related_to',
    });
    expect(rel.confidence).toBe(0.5);
  });

  it('getKnowledgeRelationship retrieves by id', () => {
    const rel = adapter.insertKnowledgeRelationship({
      fromEntityId: entityA!.id,
      toEntityId: entityB!.id,
      type: 'created_by',
    });
    const found = adapter.getKnowledgeRelationship(rel.id);
    expect(found).toBeDefined();
    expect(found!.type).toBe('created_by');
  });

  it('getKnowledgeRelationship returns undefined for missing id', () => {
    expect(adapter.getKnowledgeRelationship('nonexistent')).toBeUndefined();
  });

  it('listKnowledgeRelationships returns all relationships', () => {
    const entityC = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityB!.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityB!.id, toEntityId: entityC.id, type: 'related_to' });
    expect(adapter.listKnowledgeRelationships()).toHaveLength(2);
  });

  it('listKnowledgeRelationships filters by type', () => {
    const entityC = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityB!.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityC.id, type: 'related_to' });

    const dependents = adapter.listKnowledgeRelationships({ type: 'depends_on' });
    expect(dependents).toHaveLength(1);
    expect(dependents[0]!.type).toBe('depends_on');
  });

  it('listKnowledgeRelationships filters by entityId (matches both from and to)', () => {
    const entityC = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityB!.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityC.id, toEntityId: entityB!.id, type: 'related_to' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityC.id, type: 'related_to' });

    // entityB appears as to_entity_id in two relationships
    const forB = adapter.listKnowledgeRelationships({ entityId: entityB!.id });
    expect(forB).toHaveLength(2);
  });

  it('countKnowledgeRelationships returns correct count', () => {
    expect(adapter.countKnowledgeRelationships()).toBe(0);
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityB!.id, type: 'depends_on' });
    expect(adapter.countKnowledgeRelationships()).toBe(1);
    adapter.insertKnowledgeRelationship({ fromEntityId: entityB!.id, toEntityId: entityA!.id, type: 'related_to' });
    expect(adapter.countKnowledgeRelationships()).toBe(2);
  });

  it('deleteKnowledgeRelationship removes a single relationship', () => {
    const rel = adapter.insertKnowledgeRelationship({
      fromEntityId: entityA!.id,
      toEntityId: entityB!.id,
      type: 'depends_on',
    });
    const deleted = adapter.deleteKnowledgeRelationship(rel.id);
    expect(deleted).toBe(true);
    expect(adapter.getKnowledgeRelationship(rel.id)).toBeUndefined();
    expect(adapter.countKnowledgeRelationships()).toBe(0);
  });

  it('deleteKnowledgeRelationship returns false for missing id', () => {
    expect(adapter.deleteKnowledgeRelationship('nonexistent')).toBe(false);
  });

  it('deleteKnowledgeRelationshipsByEntity removes all relationships for entity', () => {
    const entityC = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityB!.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityA!.id, toEntityId: entityC.id, type: 'related_to' });
    adapter.insertKnowledgeRelationship({ fromEntityId: entityB!.id, toEntityId: entityC.id, type: 'related_to' });

    // Delete all relationships touching entityA (2 of them)
    const removed = adapter.deleteKnowledgeRelationshipsByEntity(entityA!.id);
    expect(removed).toBe(2);
    // One relationship (B→C) should remain
    expect(adapter.countKnowledgeRelationships()).toBe(1);
  });
});

// ── ON DELETE CASCADE ──────────────────────────────────────────────────────────

describe('WorkspaceAdapter — knowledge_entities ON DELETE CASCADE', () => {
  it('deleting an entity cascades to all its relationships', () => {
    const adapter = makeAdapter();
    const a = adapter.upsertKnowledgeEntity({ type: 'module', name: 'A' });
    const b = adapter.upsertKnowledgeEntity({ type: 'module', name: 'B' });
    const c = adapter.upsertKnowledgeEntity({ type: 'concept', name: 'C' });

    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });
    adapter.insertKnowledgeRelationship({ fromEntityId: c.id, toEntityId: a.id, type: 'related_to' });
    expect(adapter.countKnowledgeRelationships()).toBe(2);

    // Deleting entity A should cascade and remove both its relationships
    adapter.deleteKnowledgeEntity(a.id);
    expect(adapter.countKnowledgeRelationships()).toBe(0);
    expect(adapter.countKnowledgeEntities()).toBe(2); // B and C remain
    adapter.close();
  });

  it('deleting a target entity cascades correctly', () => {
    const adapter = makeAdapter();
    const a = adapter.upsertKnowledgeEntity({ type: 'module', name: 'A' });
    const b = adapter.upsertKnowledgeEntity({ type: 'module', name: 'B' });
    adapter.insertKnowledgeRelationship({ fromEntityId: a.id, toEntityId: b.id, type: 'depends_on' });

    adapter.deleteKnowledgeEntity(b.id);
    expect(adapter.countKnowledgeRelationships()).toBe(0);
    adapter.close();
  });
});

// ── Cross-instance persistence (same adapter, multiple reads) ─────────────────

describe('WorkspaceAdapter — knowledge graph cross-call consistency', () => {
  it('entities written in one call are visible in subsequent list calls', () => {
    const adapter = makeAdapter();

    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'CodeReviewer', sourceCycleId: 'c-1' });
    adapter.upsertKnowledgeEntity({ type: 'agent', name: 'SprintPlanner', sourceCycleId: 'c-1' });

    // Verify count and content without re-creating the adapter
    expect(adapter.countKnowledgeEntities('agent')).toBe(2);
    const list = adapter.listKnowledgeEntities({ sourceCycleId: 'c-1' });
    const names = list.map(e => e.name);
    expect(names).toContain('CodeReviewer');
    expect(names).toContain('SprintPlanner');
    adapter.close();
  });

  it('upsert + relationship insert + delete in sequence produces correct state', () => {
    const adapter = makeAdapter();

    const e1 = adapter.upsertKnowledgeEntity({ type: 'module', name: 'E1' });
    const e2 = adapter.upsertKnowledgeEntity({ type: 'module', name: 'E2' });
    const e3 = adapter.upsertKnowledgeEntity({ type: 'module', name: 'E3' });

    const r1 = adapter.insertKnowledgeRelationship({ fromEntityId: e1.id, toEntityId: e2.id, type: 'depends_on' });
    const r2 = adapter.insertKnowledgeRelationship({ fromEntityId: e2.id, toEntityId: e3.id, type: 'related_to' });

    adapter.deleteKnowledgeRelationship(r1.id);
    expect(adapter.countKnowledgeRelationships()).toBe(1);
    expect(adapter.getKnowledgeRelationship(r2.id)).toBeDefined();

    adapter.deleteKnowledgeEntity(e2.id);
    // r2 is FROM e2, so it cascades
    expect(adapter.countKnowledgeRelationships()).toBe(0);
    expect(adapter.countKnowledgeEntities()).toBe(2); // e1 and e3 remain
    adapter.close();
  });
});
