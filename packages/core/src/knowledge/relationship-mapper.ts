import { generateId, nowIso } from '@agentforge/shared';
import type { Entity, Relationship, RelationshipType, CreateRelationshipRequest } from './types.js';

/** Verb patterns that suggest relationship types */
const RELATIONSHIP_SIGNALS: Array<{ type: RelationshipType; verbs: string[] }> = [
  { type: 'depends_on', verbs: ['depends', 'requires', 'needs', 'uses'] },
  { type: 'created_by', verbs: ['created', 'built', 'authored', 'owns'] },
  { type: 'part_of', verbs: ['part', 'child', 'sub', 'within', 'inside'] },
  { type: 'triggers', verbs: ['triggers', 'fires', 'invokes', 'calls', 'activates'] },
  { type: 'contradicts', verbs: ['contradicts', 'conflicts', 'opposes', 'blocks'] },
  { type: 'extends', verbs: ['extends', 'inherits', 'enhances', 'augments'] },
  { type: 'references', verbs: ['references', 'mentions', 'points', 'links', 'cites'] },
];

/**
 * RelationshipMapper — creates and infers relationships between entities.
 */
export class RelationshipMapper {
  /**
   * Infer relationship type from context text describing how two entities relate.
   */
  inferType(context: string): RelationshipType {
    const lower = context.toLowerCase();
    for (const { type, verbs } of RELATIONSHIP_SIGNALS) {
      if (verbs.some(v => lower.includes(v))) return type;
    }
    return 'related_to';
  }

  /**
   * Create a relationship between two entities.
   */
  create(req: CreateRelationshipRequest): Relationship {
    return {
      id: generateId(),
      sourceId: req.sourceId,
      targetId: req.targetId,
      type: req.type,
      weight: req.weight ?? 0.5,
      properties: req.properties ?? {},
      createdAt: nowIso(),
    };
  }

  /**
   * Compute co-occurrence relationships from a list of entities appearing together.
   * Each pair gets a 'related_to' relationship with weight based on frequency.
   */
  computeCoOccurrence(
    entityGroups: Entity[][],
  ): Omit<Relationship, 'id' | 'createdAt'>[] {
    const pairCount = new Map<string, number>();

    for (const group of entityGroups) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const key = [group[i].id, group[j].id].sort().join('::');
          pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
        }
      }
    }

    const maxCount = Math.max(1, ...pairCount.values());
    return [...pairCount.entries()].map(([key, count]) => {
      const [sourceId, targetId] = key.split('::');
      return {
        sourceId,
        targetId,
        type: 'related_to' as RelationshipType,
        weight: count / maxCount,
        properties: { coOccurrenceCount: count },
      };
    });
  }

  /**
   * Find all relationships involving a specific entity.
   */
  findByEntity(entityId: string, relationships: Relationship[]): Relationship[] {
    return relationships.filter(r => r.sourceId === entityId || r.targetId === entityId);
  }

  /**
   * Get the neighbor entity IDs for a given entity.
   */
  getNeighbors(entityId: string, relationships: Relationship[]): string[] {
    const neighbors = new Set<string>();
    for (const r of relationships) {
      if (r.sourceId === entityId) neighbors.add(r.targetId);
      else if (r.targetId === entityId) neighbors.add(r.sourceId);
    }
    return [...neighbors];
  }
}
