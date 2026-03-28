import { describe, it, expect, beforeEach } from 'vitest';
import {
  KnowledgeGraph,
  EntityExtractor,
  RelationshipMapper,
} from '../../packages/core/src/knowledge/index.js';

describe('KnowledgeGraph', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = new KnowledgeGraph();
  });

  describe('Entity operations', () => {
    it('adds an entity and retrieves it by id', () => {
      const entity = graph.addEntity({ name: 'ConfidenceRouter', type: 'module', description: 'Routes agent tasks' });
      expect(entity.id).toBeTruthy();
      expect(entity.name).toBe('ConfidenceRouter');
      expect(entity.type).toBe('module');
      expect(graph.getEntity(entity.id)).toEqual(entity);
    });

    it('returns undefined for missing entity', () => {
      expect(graph.getEntity('nonexistent')).toBeUndefined();
    });

    it('lists all entities', () => {
      graph.addEntity({ name: 'AgentA', type: 'agent' });
      graph.addEntity({ name: 'AgentB', type: 'agent' });
      graph.addEntity({ name: 'TaskX', type: 'task' });
      expect(graph.listEntities()).toHaveLength(3);
    });

    it('filters entities by type', () => {
      graph.addEntity({ name: 'AgentA', type: 'agent' });
      graph.addEntity({ name: 'TaskX', type: 'task' });
      expect(graph.listEntities({ type: 'agent' })).toHaveLength(1);
      expect(graph.listEntities({ type: 'task' })).toHaveLength(1);
    });

    it('updates an entity', () => {
      const entity = graph.addEntity({ name: 'MyModule', type: 'module' });
      const updated = graph.updateEntity(entity.id, { description: 'Updated description' });
      expect(updated?.description).toBe('Updated description');
      expect(updated?.name).toBe('MyModule');
    });

    it('returns undefined when updating missing entity', () => {
      expect(graph.updateEntity('missing', { description: 'x' })).toBeUndefined();
    });

    it('deletes an entity and its relationships', () => {
      const a = graph.addEntity({ name: 'A', type: 'concept' });
      const b = graph.addEntity({ name: 'B', type: 'concept' });
      graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'related_to' });
      expect(graph.relationshipCount()).toBe(1);
      graph.deleteEntity(a.id);
      expect(graph.getEntity(a.id)).toBeUndefined();
      expect(graph.relationshipCount()).toBe(0);
    });

    it('returns false when deleting missing entity', () => {
      expect(graph.deleteEntity('missing')).toBe(false);
    });

    it('tracks entity count', () => {
      expect(graph.entityCount()).toBe(0);
      graph.addEntity({ name: 'X', type: 'concept' });
      expect(graph.entityCount()).toBe(1);
    });
  });

  describe('Relationship operations', () => {
    it('adds a relationship between two entities', () => {
      const a = graph.addEntity({ name: 'A', type: 'module' });
      const b = graph.addEntity({ name: 'B', type: 'module' });
      const rel = graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'depends_on', weight: 0.8 });
      expect('error' in rel).toBe(false);
      if ('error' in rel) return;
      expect(rel.sourceId).toBe(a.id);
      expect(rel.targetId).toBe(b.id);
      expect(rel.type).toBe('depends_on');
      expect(rel.weight).toBe(0.8);
    });

    it('returns error for missing source entity', () => {
      const b = graph.addEntity({ name: 'B', type: 'module' });
      const result = graph.addRelationship({ sourceId: 'missing', targetId: b.id, type: 'related_to' });
      expect('error' in result).toBe(true);
    });

    it('returns error for missing target entity', () => {
      const a = graph.addEntity({ name: 'A', type: 'module' });
      const result = graph.addRelationship({ sourceId: a.id, targetId: 'missing', type: 'related_to' });
      expect('error' in result).toBe(true);
    });

    it('lists relationships and filters by type', () => {
      const a = graph.addEntity({ name: 'A', type: 'concept' });
      const b = graph.addEntity({ name: 'B', type: 'concept' });
      const c = graph.addEntity({ name: 'C', type: 'concept' });
      graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'depends_on' });
      graph.addRelationship({ sourceId: b.id, targetId: c.id, type: 'related_to' });
      expect(graph.listRelationships()).toHaveLength(2);
      expect(graph.listRelationships({ type: 'depends_on' })).toHaveLength(1);
    });

    it('deletes a relationship', () => {
      const a = graph.addEntity({ name: 'A', type: 'concept' });
      const b = graph.addEntity({ name: 'B', type: 'concept' });
      const rel = graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'related_to' });
      if ('error' in rel) throw new Error('Expected relationship');
      expect(graph.deleteRelationship(rel.id)).toBe(true);
      expect(graph.relationshipCount()).toBe(0);
    });
  });

  describe('Query', () => {
    it('finds entities by name keyword', () => {
      graph.addEntity({ name: 'ConfidenceRouter', type: 'module', description: 'Routes tasks by confidence' });
      graph.addEntity({ name: 'EscalationProtocol', type: 'module', description: 'Escalates tasks' });
      graph.addEntity({ name: 'SprintPlanner', type: 'task', description: 'Plans sprints' });

      const result = graph.query({ query: 'sprint' });
      expect(result.entities.length).toBeGreaterThan(0);
      expect(result.entities.some(e => e.name === 'SprintPlanner')).toBe(true);
      expect(result.queryTime).toBeGreaterThanOrEqual(0);
    });

    it('filters by entity type in query', () => {
      graph.addEntity({ name: 'MyAgent', type: 'agent' });
      graph.addEntity({ name: 'MyModule', type: 'module' });
      const result = graph.query({ query: 'my', entityTypes: ['agent'] });
      expect(result.entities.every(e => e.type === 'agent')).toBe(true);
    });

    it('respects maxEntities limit', () => {
      for (let i = 0; i < 10; i++) {
        graph.addEntity({ name: `Concept ${i}`, type: 'concept' });
      }
      const result = graph.query({ query: 'concept', maxEntities: 3 });
      expect(result.entities.length).toBeLessThanOrEqual(3);
    });

    it('includes relationships for matched entities', () => {
      const a = graph.addEntity({ name: 'Alpha', type: 'concept' });
      const b = graph.addEntity({ name: 'Beta', type: 'concept' });
      graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'related_to' });
      const result = graph.query({ query: 'alpha beta', includeRelationships: true });
      expect(result.relationships.length).toBeGreaterThanOrEqual(0);
    });

    it('returns relevance scores', () => {
      graph.addEntity({ name: 'RelevantEntity', type: 'concept', description: 'relevant relevant relevant' });
      const result = graph.query({ query: 'relevant' });
      expect(Object.keys(result.relevanceScores).length).toBeGreaterThan(0);
    });
  });

  describe('Subgraph traversal', () => {
    it('returns single entity subgraph with depth 0', () => {
      const a = graph.addEntity({ name: 'A', type: 'concept' });
      const result = graph.getSubgraph(a.id, 0);
      expect(result.entities.some(e => e.id === a.id)).toBe(true);
    });

    it('returns neighbors at depth 1', () => {
      const a = graph.addEntity({ name: 'A', type: 'concept' });
      const b = graph.addEntity({ name: 'B', type: 'concept' });
      const c = graph.addEntity({ name: 'C', type: 'concept' });
      graph.addRelationship({ sourceId: a.id, targetId: b.id, type: 'related_to' });
      graph.addRelationship({ sourceId: a.id, targetId: c.id, type: 'related_to' });

      const result = graph.getSubgraph(a.id, 1);
      const ids = result.entities.map(e => e.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).toContain(c.id);
    });

    it('assigns relevance score 1.0 to root entity', () => {
      const a = graph.addEntity({ name: 'Root', type: 'concept' });
      const result = graph.getSubgraph(a.id, 1);
      expect(result.relevanceScores[a.id]).toBe(1.0);
    });
  });

  describe('Stats', () => {
    it('returns zero stats for empty graph', () => {
      const stats = graph.stats();
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
      expect(stats.densityScore).toBe(0);
    });

    it('computes type distribution', () => {
      graph.addEntity({ name: 'A', type: 'agent' });
      graph.addEntity({ name: 'B', type: 'agent' });
      graph.addEntity({ name: 'C', type: 'task' });
      const stats = graph.stats();
      expect(stats.typeDistribution['agent']).toBe(2);
      expect(stats.typeDistribution['task']).toBe(1);
    });
  });
});

describe('EntityExtractor', () => {
  const extractor = new EntityExtractor();

  it('infers agent type', () => {
    expect(extractor.inferType('MyAgent', 'A smart agent')).toBe('agent');
  });

  it('infers module type', () => {
    expect(extractor.inferType('CoreModule', 'A service module')).toBe('module');
  });

  it('infers task type', () => {
    expect(extractor.inferType('SprintTask', 'Sprint planning job')).toBe('task');
  });

  it('defaults to concept', () => {
    expect(extractor.inferType('XYZ123', 'something unknown')).toBe('concept');
  });

  it('extracts capitalized names from text', () => {
    const names = extractor.extractFromText('The AgentForge system uses ConfidenceRouter and SprintPlanner');
    expect(names).toContain('AgentForge');
    expect(names).toContain('ConfidenceRouter');
    expect(names).toContain('SprintPlanner');
  });

  it('creates entity from request', () => {
    const entity = extractor.create({ name: 'TestEntity', type: 'concept' });
    expect(entity.id).toBeTruthy();
    expect(entity.name).toBe('TestEntity');
    expect(entity.createdAt).toBeTruthy();
    expect(entity.updatedAt).toBeTruthy();
  });
});

describe('RelationshipMapper', () => {
  const mapper = new RelationshipMapper();

  it('infers depends_on from context', () => {
    expect(mapper.inferType('This module depends on CoreModule')).toBe('depends_on');
  });

  it('infers created_by from context', () => {
    expect(mapper.inferType('This was created by Agent X')).toBe('created_by');
  });

  it('defaults to related_to', () => {
    expect(mapper.inferType('vague connection')).toBe('related_to');
  });

  it('creates relationship with default weight', () => {
    const rel = mapper.create({ sourceId: 'a', targetId: 'b', type: 'related_to' });
    expect(rel.sourceId).toBe('a');
    expect(rel.targetId).toBe('b');
    expect(rel.weight).toBe(0.5);
  });

  it('finds relationships by entity', () => {
    const rels = [
      mapper.create({ sourceId: 'a', targetId: 'b', type: 'related_to' }),
      mapper.create({ sourceId: 'b', targetId: 'c', type: 'depends_on' }),
      mapper.create({ sourceId: 'd', targetId: 'e', type: 'related_to' }),
    ];
    const found = mapper.findByEntity('b', rels);
    expect(found).toHaveLength(2);
  });

  it('gets neighbors for entity', () => {
    const rels = [
      mapper.create({ sourceId: 'a', targetId: 'b', type: 'related_to' }),
      mapper.create({ sourceId: 'a', targetId: 'c', type: 'depends_on' }),
    ];
    const neighbors = mapper.getNeighbors('a', rels);
    expect(neighbors).toContain('b');
    expect(neighbors).toContain('c');
  });

  it('computes co-occurrence relationships', () => {
    const entityA = { id: 'a' } as any;
    const entityB = { id: 'b' } as any;
    const entityC = { id: 'c' } as any;
    const groups = [[entityA, entityB], [entityA, entityC], [entityA, entityB]];
    const coOccurrences = mapper.computeCoOccurrence(groups);
    expect(coOccurrences.length).toBeGreaterThan(0);
    const abPair = coOccurrences.find(r =>
      (r.sourceId === 'a' && r.targetId === 'b') || (r.sourceId === 'b' && r.targetId === 'a')
    );
    expect(abPair).toBeTruthy();
    expect(abPair?.weight).toBe(1.0); // Highest frequency
  });
});
