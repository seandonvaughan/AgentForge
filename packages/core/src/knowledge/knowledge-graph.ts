import type { WorkspaceAdapter, KnowledgeEntityRow, KnowledgeRelationshipRow } from '@agentforge/db';
import { EntityExtractor } from './entity-extractor.js';
import { RelationshipMapper } from './relationship-mapper.js';
import type {
  Entity,
  Relationship,
  EntityType,
  RelationshipType,
  GraphQueryResult,
  KnowledgeQueryRequest,
  CreateEntityRequest,
  CreateRelationshipRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Row ↔ domain-type converters
// ---------------------------------------------------------------------------

function rowToEntity(row: KnowledgeEntityRow): Entity {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      properties = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — treat as empty properties
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type as EntityType,
    ...(row.description !== null ? { description: row.description } : {}),
    properties,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRelationship(row: KnowledgeRelationshipRow): Relationship {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      properties = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — treat as empty properties
  }
  return {
    id: row.id,
    sourceId: row.from_entity_id,
    targetId: row.to_entity_id,
    type: row.type as RelationshipType,
    weight: row.confidence,
    properties,
    createdAt: row.created_at,
  };
}

/**
 * KnowledgeGraph — semantic memory graph with optional WorkspaceAdapter persistence.
 *
 * When constructed with an adapter, entities and relationships are persisted to
 * the `knowledge_entities` / `knowledge_relationships` SQLite tables across server
 * restarts. Without an adapter, the graph operates purely in-memory (useful for
 * tests).
 *
 * The in-memory Map/array acts as a read cache: reads are always O(1) from the
 * cache; every mutating operation writes through to the adapter so the DB is the
 * authoritative source of truth. The cache is populated once during construction
 * via `hydrateFromAdapter`.
 */
export class KnowledgeGraph {
  private entities = new Map<string, Entity>();
  private relationships: Relationship[] = [];
  private readonly extractor = new EntityExtractor();
  private readonly mapper = new RelationshipMapper();
  // Typed as `WorkspaceAdapter | undefined` (not `?`) so that the constructor
  // assignment satisfies exactOptionalPropertyTypes.
  private readonly adapter: WorkspaceAdapter | undefined;

  constructor(adapter?: WorkspaceAdapter) {
    this.adapter = adapter;
    if (adapter) {
      this.hydrateFromAdapter(adapter);
    }
  }

  /**
   * Populate the in-memory cache from the adapter's SQLite tables on startup.
   * Replaces the former KV-blob approach — uses proper row-level adapter methods.
   */
  private hydrateFromAdapter(adapter: WorkspaceAdapter): void {
    try {
      // Load up to 10 000 entities — sufficient for any realistic knowledge graph.
      const entityRows = adapter.listKnowledgeEntities({ limit: 10_000 });
      for (const row of entityRows) {
        this.entities.set(row.id, rowToEntity(row));
      }
    } catch {
      // Non-fatal: start with empty entity map
    }

    try {
      const relRows = adapter.listKnowledgeRelationships({ limit: 100_000 });
      for (const row of relRows) {
        this.relationships.push(rowToRelationship(row));
      }
    } catch {
      // Non-fatal: start with empty relationship list
    }
  }

  // ── Entity operations ────────────────────────────────────────────────────────

  addEntity(req: CreateEntityRequest): Entity {
    const entity = this.extractor.create(req);
    this.entities.set(entity.id, entity);
    if (this.adapter) {
      this.adapter.upsertKnowledgeEntity({
        id: entity.id,
        type: entity.type,
        name: entity.name,
        description: entity.description ?? null,
        propertiesJson: JSON.stringify(entity.properties),
        updatedAt: entity.updatedAt,
        createdAt: entity.createdAt,
      });
    }
    return entity;
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  updateEntity(id: string, updates: Partial<Pick<Entity, 'name' | 'description' | 'properties'>>): Entity | undefined {
    const existing = this.entities.get(id);
    if (!existing) return undefined;
    const updated = this.extractor.touch(existing, updates);
    this.entities.set(id, updated);
    if (this.adapter) {
      this.adapter.upsertKnowledgeEntity({
        id: updated.id,
        type: updated.type,
        name: updated.name,
        description: updated.description ?? null,
        propertiesJson: JSON.stringify(updated.properties),
        updatedAt: updated.updatedAt,
        createdAt: updated.createdAt,
      });
    }
    return updated;
  }

  deleteEntity(id: string): boolean {
    if (!this.entities.has(id)) return false;
    this.entities.delete(id);
    // Remove relationships from in-memory cache (the DB cascade handles the DB side).
    this.relationships = this.relationships.filter(
      r => r.sourceId !== id && r.targetId !== id,
    );
    if (this.adapter) {
      // ON DELETE CASCADE in knowledge_relationships handles relationship cleanup in DB.
      this.adapter.deleteKnowledgeEntity(id);
    }
    return true;
  }

  listEntities(filter?: { type?: EntityType }): Entity[] {
    const all = [...this.entities.values()];
    if (filter?.type) return all.filter(e => e.type === filter.type);
    return all;
  }

  entityCount(): number {
    return this.entities.size;
  }

  // ── Relationship operations ─────────────────────────────────────────────────

  addRelationship(req: CreateRelationshipRequest): Relationship | { error: string } {
    if (!this.entities.has(req.sourceId)) return { error: `Source entity ${req.sourceId} not found` };
    if (!this.entities.has(req.targetId)) return { error: `Target entity ${req.targetId} not found` };

    const rel = this.mapper.create(req);
    this.relationships.push(rel);
    if (this.adapter) {
      this.adapter.insertKnowledgeRelationship({
        id: rel.id,
        fromEntityId: rel.sourceId,
        toEntityId: rel.targetId,
        type: rel.type,
        confidence: rel.weight,
        propertiesJson: JSON.stringify(rel.properties),
        createdAt: rel.createdAt,
      });
    }
    return rel;
  }

  getRelationship(id: string): Relationship | undefined {
    return this.relationships.find(r => r.id === id);
  }

  deleteRelationship(id: string): boolean {
    const before = this.relationships.length;
    this.relationships = this.relationships.filter(r => r.id !== id);
    const deleted = this.relationships.length < before;
    if (deleted && this.adapter) {
      this.adapter.deleteKnowledgeRelationship(id);
    }
    return deleted;
  }

  listRelationships(filter?: { type?: RelationshipType; entityId?: string }): Relationship[] {
    let result = [...this.relationships];
    if (filter?.type) result = result.filter(r => r.type === filter.type);
    if (filter?.entityId) {
      result = result.filter(r => r.sourceId === filter.entityId || r.targetId === filter.entityId);
    }
    return result;
  }

  relationshipCount(): number {
    return this.relationships.length;
  }

  // ── Graph traversal ──────────────────────────────────────────────────────────

  /**
   * Get the subgraph for a given entity — the entity + all neighbors + their edges.
   */
  getSubgraph(entityId: string, depth = 1): GraphQueryResult {
    const start = Date.now();
    const visited = new Set<string>([entityId]);
    const queue: Array<{ id: string; d: number }> = [{ id: entityId, d: 0 }];
    const includedRelationships: Relationship[] = [];

    while (queue.length > 0) {
      const { id, d } = queue.shift()!;
      if (d >= depth) continue;

      const rels = this.mapper.findByEntity(id, this.relationships);
      for (const rel of rels) {
        if (!includedRelationships.find(r => r.id === rel.id)) {
          includedRelationships.push(rel);
        }
        const neighborId = rel.sourceId === id ? rel.targetId : rel.sourceId;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push({ id: neighborId, d: d + 1 });
        }
      }
    }

    const entities = [...visited].map(id => this.entities.get(id)).filter(Boolean) as Entity[];
    const scores: Record<string, number> = {};
    for (const e of entities) {
      // Root entity gets score 1.0, each hop reduces by 0.3
      const hopRels = includedRelationships.filter(r => r.sourceId === entityId || r.targetId === entityId);
      const isNeighbor = hopRels.some(r => r.sourceId === e.id || r.targetId === e.id);
      scores[e.id] = e.id === entityId ? 1.0 : isNeighbor ? 0.7 : 0.4;
    }

    return {
      entities,
      relationships: includedRelationships,
      relevanceScores: scores,
      queryTime: Date.now() - start,
    };
  }

  // ── Semantic query ────────────────────────────────────────────────────────────

  /**
   * Query the graph by text. Uses keyword matching against entity names/descriptions.
   */
  query(req: KnowledgeQueryRequest): GraphQueryResult {
    const start = Date.now();
    const {
      query,
      entityTypes,
      maxEntities = 20,
      minRelevance = 0.1,
      includeRelationships = true,
    } = req;

    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
    const scores: Record<string, number> = {};

    for (const entity of this.entities.values()) {
      if (entityTypes && !entityTypes.includes(entity.type)) continue;

      const text = `${entity.name} ${entity.description ?? ''} ${entity.type}`.toLowerCase();
      let score = 0;

      for (const term of terms) {
        if (entity.name.toLowerCase().includes(term)) score += 0.4;
        else if (text.includes(term)) score += 0.2;
      }

      // Normalize by term count
      const normalized = terms.length > 0 ? score / terms.length : 0;
      if (normalized >= minRelevance) scores[entity.id] = normalized;
    }

    // Sort by score, take top maxEntities
    const topIds = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxEntities)
      .map(([id]) => id);

    const entities = topIds.map(id => this.entities.get(id)).filter(Boolean) as Entity[];

    let relationships: Relationship[] = [];
    if (includeRelationships) {
      const idSet = new Set(topIds);
      relationships = this.relationships.filter(
        r => idSet.has(r.sourceId) && idSet.has(r.targetId),
      );
    }

    return {
      entities,
      relationships,
      relevanceScores: scores,
      queryTime: Date.now() - start,
    };
  }

  // ── Statistics ────────────────────────────────────────────────────────────────

  stats(): {
    entityCount: number;
    relationshipCount: number;
    typeDistribution: Record<string, number>;
    densityScore: number;
  } {
    const typeDistribution: Record<string, number> = {};
    for (const e of this.entities.values()) {
      typeDistribution[e.type] = (typeDistribution[e.type] ?? 0) + 1;
    }

    const n = this.entities.size;
    const maxEdges = n * (n - 1) / 2;
    const densityScore = maxEdges > 0 ? this.relationships.length / maxEdges : 0;

    return {
      entityCount: n,
      relationshipCount: this.relationships.length,
      typeDistribution,
      densityScore: Math.round(densityScore * 10000) / 10000,
    };
  }
}
