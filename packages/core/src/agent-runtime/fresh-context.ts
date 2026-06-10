/**
 * Fresh-Context Injection — at agent invocation, pull a small slice of the
 * most-recent memory entries for this agent and splice them into the system
 * prompt as a "Fresh Context (this cycle)" section.
 *
 * This sits alongside the baked-in `learnings:` field that forge/reforge
 * writes into each agent YAML. The split:
 *
 * - **Baked learnings (forge time)** — durable, curated lessons. Auditable
 *   in YAML. Updated only at forge/reforge boundaries.
 * - **Fresh context (invocation time)** — last 3-5 memory entries by recency,
 *   filtered to entries the agent's role plausibly cares about. Never
 *   touches the YAML. Always current.
 *
 * Both feed the same memory store (`.agentforge/memory/*.jsonl`).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspaceAdapter } from '@agentforge/db';
import { injectAgentDms, type InjectAgentDmsOptions } from '../comms/inject-agent-dms.js';
import { readAgentMemoryFromDir } from '../memory/agent-memory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryEntry {
  id: string;
  type: string;
  value: string;
  createdAt: string;
  source?: string;
  tags?: string[];
}

export interface FreshContextOptions {
  /** Max entries to include. Default: 5. */
  maxEntries?: number;
  /** Cap on each entry's character length. Default: 220. */
  maxEntryChars?: number;
  /** Recency window in days — entries older than this are skipped. Default: 60. */
  windowDays?: number;
  /**
   * Optional workspace adapter. When provided, undelivered DMs for `agentId`
   * are pulled and prepended as a `## Direct Messages` section ahead of the
   * fresh-context block. See `comms/inject-agent-dms.ts` (ADR 0001).
   *
   * When omitted, `injectFreshContext` behaves as before — pure memory
   * splice — keeping the existing call sites and tests unchanged.
   */
  adapter?: WorkspaceAdapter;
  /** Forwarded to `injectAgentDms` when `adapter` is provided. */
  dmOptions?: InjectAgentDmsOptions;
}

// ---------------------------------------------------------------------------
// Role → tag affinity (kept small and runtime-cheap; full curation lives in
// team/engine/builder/memory-curator.ts for forge-time baked learnings)
// ---------------------------------------------------------------------------

const RUNTIME_ROLE_TAGS: Record<string, string[]> = {
  // Reviewers and gate-checkers care most about prior findings + verdicts
  reviewer: ['review', 'finding', 'critical', 'major', 'gate', 'verdict'],
  gate: ['gate', 'verdict', 'critical', 'major'],
  ceo: ['gate', 'verdict', 'cycle'],
  // Implementation roles want the latest recurring failures + fixes
  coder: ['fix', 'critical', 'major', 'finding'],
  architect: ['architecture', 'memory', 'design', 'critical', 'major'],
  // Planning + cost roles get cycle outcomes
  scorer: ['cycle', 'cost', 'estimate', 'fallback'],
  planner: ['cycle', 'sprint', 'planning'],
};

/** Resolve the agent's runtime affinity tags from its id. */
function agentRuntimeTags(agentId: string): Set<string> {
  const idLower = agentId.toLowerCase();
  const tags = new Set<string>();
  for (const [role, list] of Object.entries(RUNTIME_ROLE_TAGS)) {
    if (idLower.includes(role)) {
      for (const t of list) tags.add(t);
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Memory loading + ranking (runtime-light variant)
// ---------------------------------------------------------------------------

function loadEntries(memDir: string): MemoryEntry[] {
  if (!existsSync(memDir)) return [];
  const out: MemoryEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(memDir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(memDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as MemoryEntry;
        if (parsed && typeof parsed.value === 'string') out.push(parsed);
      } catch {
        // skip
      }
    }
  }
  return out;
}

function withinWindow(createdAt: string, windowDays: number): boolean {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
  return ageDays <= windowDays;
}

/**
 * Score an entry's runtime relevance. Returns 0 when the entry has neither a
 * tag-affinity match nor a severity marker — recency alone is a tiebreaker,
 * not a qualifier (otherwise every fresh entry would be picked regardless of
 * what the agent's role actually cares about).
 */
function rankRuntimeEntry(entry: MemoryEntry, affinity: Set<string>): number {
  let qualifyingScore = 0;
  for (const t of entry.tags ?? []) {
    if (affinity.has(t.toLowerCase())) qualifyingScore += 2;
  }
  if (/\[CRITICAL\]/i.test(entry.value)) qualifyingScore += 3;
  if (/\[MAJOR\]/i.test(entry.value)) qualifyingScore += 1.5;

  // No qualifying signal → entry is irrelevant regardless of recency.
  if (qualifyingScore === 0) return 0;

  // Recency adds a tiebreaker but cannot rescue an unrelated entry.
  const ageDays = (Date.now() - new Date(entry.createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyBoost = ageDays <= 7 ? 1 : 0;
  return qualifyingScore + recencyBoost;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return up to N most-relevant recent memory entries for an agent, formatted
 * as markdown bullets ready to splice into a system prompt.
 *
 * Returns an empty string when no entries match — the caller can then skip
 * appending the section entirely (keeps prompts tight when memory is new).
 */
export function buildFreshContextBlock(
  agentId: string,
  agentforgeDir: string,
  options: FreshContextOptions = {},
): string {
  const maxChars = options.maxEntryChars ?? 220;
  const windowDays = options.windowDays ?? 60;
  const memDir = join(agentforgeDir, 'memory');

  // W2 — the agent's OWN history comes first: distilled outcomes of its prior
  // items plus its own LEARNED notes, from .agentforge/memory/agents/<id>.jsonl.
  // When personal history exists, the shared role-filtered pool shrinks to
  // make room (the personal slice is strictly more relevant).
  const personal = readAgentMemoryFromDir(memDir, agentId, 5);
  const personalBullets = personal.map((e) => {
    const clean = e.value.replace(/\s+/g, ' ').trim();
    return clean.length > maxChars ? `- ${clean.slice(0, maxChars - 1)}…` : `- ${clean}`;
  });
  const maxEntries = options.maxEntries ?? (personal.length > 0 ? 3 : 5);

  const sections: string[] = [];
  if (personalBullets.length > 0) {
    sections.push(
      [
        '## Your history',
        'Outcomes of your own recent work and notes you recorded. Apply them.',
        '',
        personalBullets.join('\n'),
      ].join('\n'),
    );
  }

  const entries = loadEntries(memDir);
  const affinity = agentRuntimeTags(agentId);
  const recent = entries.filter((e) => withinWindow(e.createdAt, windowDays));

  const scored = recent
    .map((e) => ({ e, score: rankRuntimeEntry(e, affinity) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.e.createdAt).getTime() - new Date(a.e.createdAt).getTime();
    });

  if (scored.length > 0) {
    const bullets = scored.slice(0, maxEntries).map(({ e }) => {
      const clean = e.value.replace(/\s+/g, ' ').replace(/^[*-]\s*/, '').trim();
      return clean.length > maxChars ? `- ${clean.slice(0, maxChars - 1)}…` : `- ${clean}`;
    });
    sections.push(
      [
        '## Fresh Context (this cycle)',
        'The notes below are the most-recent relevant memory entries for your role.',
        'Treat them as live signal — what just happened across the team.',
        '',
        bullets.join('\n'),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * Append a "Fresh Context" section to a system prompt if any memory entries
 * are relevant. Returns the prompt unchanged when nothing is found, so it's
 * safe to wrap every loadAgentConfig path with this helper.
 *
 * @param prompt        - The base system prompt from agent YAML.
 * @param agentId       - Agent identifier (used for tag affinity).
 * @param agentforgeDir - Path to the `.agentforge/` directory.
 */
export function injectFreshContext(
  prompt: string,
  agentId: string,
  agentforgeDir: string,
  options?: FreshContextOptions,
): string {
  const block = buildFreshContextBlock(agentId, agentforgeDir, options);
  const memoryAugmented = block ? `${prompt.trimEnd()}\n\n${block}\n` : prompt;

  if (options?.adapter) {
    return injectAgentDms(memoryAugmented, agentId, options.adapter, options.dmOptions ?? {});
  }
  return memoryAugmented;
}

/**
 * Convenience: resolve `.agentforge/` from a `projectRoot` and inject. Used by
 * the autonomous runtime where `projectRoot` is the natural input.
 */
export function injectFreshContextFromRoot(
  prompt: string,
  agentId: string,
  projectRoot: string,
  options?: FreshContextOptions,
): string {
  return injectFreshContext(prompt, agentId, join(projectRoot, '.agentforge'), options);
}

/** Re-export dirname for the runtime caller that wants symmetric helpers. */
export { dirname };
