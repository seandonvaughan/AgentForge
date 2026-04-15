import { generateId, nowIso } from '@agentforge/shared';
import type { Entity, EntityType, CreateEntityRequest } from './types.js';

/** Heuristic patterns for entity type classification */
const TYPE_PATTERNS: Array<{ type: EntityType; patterns: RegExp[] }> = [
  {
    type: 'agent',
    patterns: [/\bagent\b/i, /\bassistant\b/i, /\bbot\b/i, /\bworker\b/i],
  },
  {
    type: 'module',
    patterns: [/\bmodule\b/i, /\bpackage\b/i, /\blibrary\b/i, /\bservice\b/i, /\bcomponent\b/i],
  },
  {
    type: 'task',
    patterns: [/\btask\b/i, /\bjob\b/i, /\bwork\b/i, /\bsprint\b/i, /\bticket\b/i],
  },
  {
    type: 'decision',
    patterns: [/\bdecision\b/i, /\bchoice\b/i, /\bselect\b/i, /\bapproval\b/i, /\bpolicy\b/i],
  },
  {
    type: 'resource',
    patterns: [/\bresource\b/i, /\bfile\b/i, /\bdatabase\b/i, /\bapi\b/i, /\bendpoint\b/i],
  },
  {
    type: 'event',
    patterns: [/\bevent\b/i, /\btrigger\b/i, /\bhook\b/i, /\bwebhook\b/i, /\bcallback\b/i],
  },
  {
    type: 'person',
    patterns: [/\buser\b/i, /\bhuman\b/i, /\boperator\b/i, /\bowner\b/i, /\bteam\b/i],
  },
];

/**
 * EntityExtractor — infers entity type from text and creates Entity objects.
 */
export class EntityExtractor {
  /**
   * Infer the entity type from name and optional description.
   */
  inferType(name: string, description?: string): EntityType {
    const text = `${name} ${description ?? ''}`;
    for (const { type, patterns } of TYPE_PATTERNS) {
      if (patterns.some(p => p.test(text))) return type;
    }
    return 'concept';
  }

  /**
   * Extract potential entity names from free text (simple NLP heuristic).
   * Returns noun phrases: capitalized words or quoted strings.
   */
  extractFromText(text: string): string[] {
    const names = new Set<string>();

    // Quoted strings
    const quoted = text.match(/"([^"]{2,50})"/g);
    if (quoted) quoted.forEach(q => names.add(q.replace(/"/g, '').trim()));

    // CamelCase words (module/class names)
    const camel = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g);
    if (camel) camel.forEach(c => names.add(c));

    // Capitalized multi-word phrases (up to 3 words)
    const caps = text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2})\b/g);
    if (caps) caps.forEach(c => names.add(c));

    return [...names].filter(n => n.length >= 3);
  }

  /**
   * Create an Entity from a creation request.
   */
  create(req: CreateEntityRequest): Entity {
    const type = req.type ?? this.inferType(req.name, req.description);
    return {
      id: generateId(),
      name: req.name,
      type,
      ...(req.description ? { description: req.description } : {}),
      properties: req.properties ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }

  /**
   * Update the updatedAt timestamp for an entity.
   */
  touch(entity: Entity, updates: Partial<Pick<Entity, 'name' | 'description' | 'properties'>>): Entity {
    return {
      ...entity,
      ...updates,
      properties: { ...entity.properties, ...(updates.properties ?? {}) },
      updatedAt: nowIso(),
    };
  }
}
