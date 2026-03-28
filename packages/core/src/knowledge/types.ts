/** Knowledge Graph types for semantic memory */

export type EntityType =
  | 'agent'
  | 'concept'
  | 'task'
  | 'decision'
  | 'resource'
  | 'module'
  | 'person'
  | 'event'
  | 'custom';

export type RelationshipType =
  | 'depends_on'
  | 'created_by'
  | 'related_to'
  | 'part_of'
  | 'references'
  | 'triggers'
  | 'contradicts'
  | 'extends'
  | 'custom';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description?: string;
  properties: Record<string, unknown>;
  embedding?: number[];
  createdAt: string;
  updatedAt: string;
}

export interface Relationship {
  id: string;
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  weight: number; // 0-1 strength of relationship
  properties: Record<string, unknown>;
  createdAt: string;
}

export interface GraphQueryResult {
  entities: Entity[];
  relationships: Relationship[];
  relevanceScores: Record<string, number>;
  queryTime: number;
}

export interface KnowledgeQueryRequest {
  query: string;
  entityTypes?: EntityType[];
  maxEntities?: number;
  minRelevance?: number;
  includeRelationships?: boolean;
}

export interface CreateEntityRequest {
  name: string;
  type: EntityType;
  description?: string;
  properties?: Record<string, unknown>;
}

export interface CreateRelationshipRequest {
  sourceId: string;
  targetId: string;
  type: RelationshipType;
  weight?: number;
  properties?: Record<string, unknown>;
}
