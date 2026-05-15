/**
 * Unit tests for knowledge graph persistence:
 *   - writeKnowledgeEntry  — extracts entities from text and appends to JSONL
 *   - loadKnowledgeEntities — reads persisted entities from JSONL
 *
 * Round-trip tests verify that entities written by phase handlers are
 * correctly loaded by the server route on startup to populate the KG.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeKnowledgeEntry, loadKnowledgeEntities } from '../persistence.js';

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agentforge-knowledge-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeKnowledgeEntry
// ---------------------------------------------------------------------------

describe('writeKnowledgeEntry — basic extraction', () => {
  it('returns [] for empty text', () => {
    const entities = writeKnowledgeEntry(tmpRoot, { text: '', source: 'audit' });
    expect(entities).toHaveLength(0);
  });

  it('extracts CamelCase identifiers as entities', () => {
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: 'The KnowledgeGraph is built by EntityExtractor and RelationshipMapper.',
      source: 'audit',
    });
    const names = entities.map(e => e.name);
    expect(names).toContain('KnowledgeGraph');
    expect(names).toContain('EntityExtractor');
    expect(names).toContain('RelationshipMapper');
  });

  it('extracts quoted strings as entities', () => {
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: 'Phase "audit-phase" and "review-phase" both need wiring.',
      source: 'audit',
    });
    const names = entities.map(e => e.name);
    expect(names.some(n => n.includes('audit-phase') || n.includes('review-phase'))).toBe(true);
  });

  it('attaches source, cycleId and tags as properties', () => {
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: 'AuditPhase findings produced by ResearcherAgent.',
      source: 'audit',
      cycleId: 'cycle-abc',
      tags: ['sprint:v16.0', 'audit-findings'],
    });
    expect(entities.length).toBeGreaterThan(0);
    const entity = entities[0]!;
    expect(entity.properties.source).toBe('audit');
    expect(entity.properties.cycleId).toBe('cycle-abc');
    expect(entity.properties.tags).toEqual(['sprint:v16.0', 'audit-findings']);
  });

  it('assigns a non-empty UUID id to each entity', () => {
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: 'SprintPlanner delegates to ExecutePhase.',
      source: 'audit',
    });
    expect(entities.length).toBeGreaterThan(0);
    for (const e of entities) {
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('deduplicates the same name (case-insensitive)', () => {
    // "AuditPhase" and "auditphase" would normalise to the same entity.
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: 'AuditPhase is managed by AuditPhase. The AuditPhase runs first.',
      source: 'audit',
    });
    const names = entities.map(e => e.name.toLowerCase());
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length); // no duplicates after dedup
  });

  it('respects maxEntities cap', () => {
    // Generate text with many unique CamelCase words
    const words = Array.from({ length: 50 }, (_, i) => `ModuleAlpha${i}`).join(' ');
    const entities = writeKnowledgeEntry(tmpRoot, {
      text: words,
      source: 'audit',
      maxEntities: 5,
    });
    expect(entities.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// writeKnowledgeEntry — disk persistence
// ---------------------------------------------------------------------------

describe('writeKnowledgeEntry — disk persistence', () => {
  it('creates .agentforge/knowledge/entities.jsonl when it does not exist', () => {
    writeKnowledgeEntry(tmpRoot, {
      text: 'KnowledgeGraph persisted by AuditPhase.',
      source: 'audit',
    });
    const filePath = join(tmpRoot, '.agentforge', 'knowledge', 'entities.jsonl');
    expect(existsSync(filePath)).toBe(true);
  });

  it('appends new entities to an existing JSONL file', () => {
    writeKnowledgeEntry(tmpRoot, { text: 'FirstEntity found here.', source: 'audit' });
    writeKnowledgeEntry(tmpRoot, { text: 'SecondEntity discovered there.', source: 'review' });

    const loaded = loadKnowledgeEntities(tmpRoot);
    expect(loaded.length).toBeGreaterThanOrEqual(2);
  });

  it('survives a non-existent project root without throwing', () => {
    // Should swallow the error and return empty
    expect(() =>
      writeKnowledgeEntry('/nonexistent/path/that/does/not/exist', {
        text: 'SprintRunner runs the cycle.',
        source: 'audit',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadKnowledgeEntities
// ---------------------------------------------------------------------------

describe('loadKnowledgeEntities', () => {
  it('returns [] when the knowledge directory does not exist', () => {
    const entities = loadKnowledgeEntities(tmpRoot);
    expect(entities).toEqual([]);
  });

  it('returns [] when entities.jsonl is absent', () => {
    mkdirSync(join(tmpRoot, '.agentforge', 'knowledge'), { recursive: true });
    const entities = loadKnowledgeEntities(tmpRoot);
    expect(entities).toEqual([]);
  });

  it('skips malformed JSONL lines without throwing', () => {
    const dir = join(tmpRoot, '.agentforge', 'knowledge');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'entities.jsonl'),
      'not valid json\n{"id":"abc","name":"Valid","type":"concept","properties":{},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}\n',
      'utf8',
    );
    const entities = loadKnowledgeEntities(tmpRoot);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.name).toBe('Valid');
  });

  it('skips entries missing required fields (id, name, type)', () => {
    const dir = join(tmpRoot, '.agentforge', 'knowledge');
    mkdirSync(dir, { recursive: true });
    // Missing name field
    writeFileSync(
      join(dir, 'entities.jsonl'),
      '{"id":"abc","type":"concept","properties":{},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}\n',
      'utf8',
    );
    const entities = loadKnowledgeEntities(tmpRoot);
    expect(entities).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: write → load → KnowledgeGraph hydration
// ---------------------------------------------------------------------------

describe('write → load round-trip', () => {
  it('entities written by writeKnowledgeEntry are loadable by loadKnowledgeEntities', () => {
    const text = 'The AuditPhaseHandler dispatches ResearcherAgent to scan the codebase.';
    const written = writeKnowledgeEntry(tmpRoot, {
      text,
      source: 'audit',
      cycleId: 'cycle-123',
      tags: ['sprint:v16.0', 'audit-findings'],
    });
    expect(written.length).toBeGreaterThan(0);

    const loaded = loadKnowledgeEntities(tmpRoot);
    expect(loaded.length).toBe(written.length);

    // Each loaded entity should preserve the original id
    const writtenIds = new Set(written.map(e => e.id));
    for (const entity of loaded) {
      expect(writtenIds.has(entity.id)).toBe(true);
    }
  });

  it('multiple write calls accumulate entities in the JSONL file', () => {
    writeKnowledgeEntry(tmpRoot, {
      text: 'AuditPhase produces findings for SprintPlanner.',
      source: 'audit',
      cycleId: 'cycle-001',
    });
    writeKnowledgeEntry(tmpRoot, {
      text: 'ReviewPhase validates CodeReviewer output.',
      source: 'review',
      cycleId: 'cycle-001',
    });

    const loaded = loadKnowledgeEntities(tmpRoot);
    const sources = loaded.map(e => e.properties.source as string);
    expect(sources).toContain('audit');
    expect(sources).toContain('review');
  });

  it('entity type is inferred (module/concept/agent/etc.) and preserved on load', () => {
    // "ResearcherAgent" should match the 'agent' type pattern
    const written = writeKnowledgeEntry(tmpRoot, {
      text: 'ResearcherAgent produces findings.',
      source: 'audit',
    });
    const agentEntity = written.find(e => e.name === 'ResearcherAgent');
    expect(agentEntity).toBeDefined();

    const loaded = loadKnowledgeEntities(tmpRoot);
    const loadedAgent = loaded.find(e => e.name === 'ResearcherAgent');
    expect(loadedAgent?.type).toBe(agentEntity?.type);
  });
});
