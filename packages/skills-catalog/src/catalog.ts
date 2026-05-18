/**
 * Catalog — fs-backed registry that loads skill .md files from the bundled
 * `skills/` directory tree.
 *
 * Skills are discovered at first use (lazy load + cache). Each .md file must
 * have a YAML front-matter block recognised by `gray-matter`.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { SkillFrontmatterSchema } from './types.js';
import type { Skill } from './types.js';

// ---------------------------------------------------------------------------
// Resolve the bundled skills/ root
// ---------------------------------------------------------------------------

/**
 * Resolve the skills/ directory bundled alongside this package.
 *
 * When running from dist/ (compiled), the skills/ folder lives two levels up
 * from this file's directory:
 *   dist/  <── __dirname
 *   src/
 *   skills/  <── target
 *
 * When running from src/ (ts-node / vitest), same relative layout applies.
 */
function resolveSkillsRoot(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  // selfDir is either packages/skills-catalog/dist or packages/skills-catalog/src
  return join(selfDir, '..', 'skills');
}

// ---------------------------------------------------------------------------
// Internal: parse a single skill file
// ---------------------------------------------------------------------------

function parseSkillFile(filePath: string): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return null;
  }

  const result = SkillFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) {
    // Log but do not throw — a malformed skill should not crash the runtime
    console.warn(
      `[skills-catalog] Skipping ${filePath}: invalid frontmatter — ${result.error.issues
        .map((i) => i.message)
        .join(', ')}`,
    );
    return null;
  }

  return {
    frontmatter: result.data,
    body: parsed.content.trim(),
    filePath,
  };
}

// ---------------------------------------------------------------------------
// Discovery: walk the skills/ tree
// ---------------------------------------------------------------------------

function discoverSkillFiles(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) return [];
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        found.push(full);
      }
    }
  }

  walk(skillsRoot);
  return found;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let _cache: Map<string, Skill> | null = null;

function getCache(): Map<string, Skill> {
  if (_cache) return _cache;

  const skillsRoot = resolveSkillsRoot();
  const files = discoverSkillFiles(skillsRoot);
  const map = new Map<string, Skill>();

  for (const filePath of files) {
    const skill = parseSkillFile(filePath);
    if (!skill) continue;
    if (map.has(skill.frontmatter.id)) {
      console.warn(
        `[skills-catalog] Duplicate skill id "${skill.frontmatter.id}" — keeping first occurrence.`,
      );
      continue;
    }
    map.set(skill.frontmatter.id, skill);
  }

  _cache = map;
  return map;
}

/**
 * Bust the module-level cache. Primarily for tests.
 */
export function _resetCache(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a skill by its kebab-case id.
 *
 * Returns `null` when the id is unknown (caller should log and skip — never
 * throw, never block a cycle).
 */
export function loadSkill(id: string): Skill | null {
  const cache = getCache();
  return cache.get(id) ?? null;
}

/**
 * Return all loaded skills as an array, sorted by id for deterministic output.
 */
export function listSkills(): Skill[] {
  const cache = getCache();
  return [...cache.values()].sort((a, b) =>
    a.frontmatter.id.localeCompare(b.frontmatter.id),
  );
}
