/**
 * `@team-*` recipient resolution for the inbox.
 *
 * The v1 helper layer hard-rejected anything outside `['@user']`. Phase 2
 * lifts that for team aliases: when an inbox message is addressed to
 * `@team-frontend`, the alias is expanded into the literal agent ids that
 * belong to that team. The expanded list is what `inbox_recipients` actually
 * stores (per ADR 0005 — junction table for recipients).
 *
 * Resolution order:
 *
 *   1. Per-agent `team:` field in `.agentforge/agents/<id>.yaml`. The
 *      forge/reforge writer sets this for every generated agent. When the
 *      alias is e.g. `@team-runtime`, every agent whose YAML has
 *      `team: runtime` matches.
 *   2. `team.yaml` tier groupings (`agents.strategic`, `implementation`,
 *      etc.). When step 1 returns nothing, we fall back to the tier groups
 *      so aliases like `@team-quality` keep working without every agent
 *      explicitly carrying the `team` field.
 *
 * The resolver is cached per-directory so a single inbox write that
 * expands `@team-frontend` and `@team-backend` doesn't reread the agents
 * folder twice. Cache TTL is intentionally infinite for the lifetime of the
 * resolver — callers that mutate agent YAMLs (forge, reforge) instantiate a
 * fresh resolver afterwards.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface AgentTeamCache {
  /** Map<agentId, team-from-YAML>. */
  perAgent: Map<string, string | null>;
  /** Map<tier-name (lowercased), agentIds[]> derived from `team.yaml`. */
  tiers: Map<string, string[]>;
}

const TEAM_ALIAS_RE = /^@team-(.+)$/;

/**
 * Resolve a recipient input against an `.agentforge/` directory.
 *
 *   - `@team-*` aliases expand into the agent ids that belong to that team
 *     (per-agent YAML field first, then `team.yaml` tier groupings).
 *   - A literal agent id (matching one of the YAML files in `agents/`)
 *     resolves to itself — so it can be written into `inbox_recipients`
 *     and pass the upstream v1 invariant check.
 *
 * Returns `null` for inputs that the resolver does not recognise (e.g.
 * `@user`, `@all` — the v1 helper layer continues to enforce its own
 * invariants for those). Returns an empty array when the input *was*
 * recognised as a team alias but had no members — callers should treat
 * that as "unknown alias" (HTTP 400).
 */
export function resolveTeamRecipients(
  agentforgeDir: string,
  recipient: string,
): readonly string[] | null {
  const cache = loadTeamCache(agentforgeDir);

  const teamMatch = TEAM_ALIAS_RE.exec(recipient);
  if (teamMatch) {
    const teamSlug = teamMatch[1]!.toLowerCase();
    // 1. Per-agent YAML field — exact match on `team:` value.
    const fromYaml: string[] = [];
    for (const [agentId, team] of cache.perAgent.entries()) {
      if (team && team.toLowerCase() === teamSlug) fromYaml.push(agentId);
    }
    if (fromYaml.length > 0) {
      return fromYaml.sort();
    }
    // 2. team.yaml tier fallback (`agents.<tier>`).
    const tierMembers = cache.tiers.get(teamSlug);
    if (tierMembers && tierMembers.length > 0) {
      return [...tierMembers].sort();
    }
    return [];
  }

  // Literal agent id — accepted when an agent of that name exists on disk.
  if (cache.perAgent.has(recipient)) {
    return [recipient];
  }

  return null;
}

// Cache -------------------------------------------------------------------

const caches = new Map<string, AgentTeamCache>();

/** Drop the cache for a directory (or all). Exposed for tests + reforge. */
export function clearTeamRecipientsCache(agentforgeDir?: string): void {
  if (agentforgeDir === undefined) {
    caches.clear();
    return;
  }
  caches.delete(agentforgeDir);
}

function loadTeamCache(agentforgeDir: string): AgentTeamCache {
  const cached = caches.get(agentforgeDir);
  if (cached) return cached;
  const fresh: AgentTeamCache = {
    perAgent: loadPerAgentTeams(agentforgeDir),
    tiers: loadTierGroupings(agentforgeDir),
  };
  caches.set(agentforgeDir, fresh);
  return fresh;
}

function loadPerAgentTeams(agentforgeDir: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const agentsDir = join(agentforgeDir, 'agents');
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const agentId = entry.replace(/\.(yaml|yml)$/, '');
    let raw: string;
    try {
      raw = readFileSync(join(agentsDir, entry), 'utf8');
    } catch {
      out.set(agentId, null);
      continue;
    }
    // Cheap line-level parse — we only need the `team:` field. Avoids
    // pulling js-yaml on every inbox write. Matches `team: runtime` (with
    // optional quoting) anchored to the start of a line.
    const teamMatch = /^team:\s*['"]?([^'"\r\n#]+?)['"]?\s*(?:#.*)?$/m.exec(raw);
    out.set(agentId, teamMatch ? teamMatch[1]!.trim() : null);
  }
  return out;
}

function loadTierGroupings(agentforgeDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let raw: string;
  try {
    raw = readFileSync(join(agentforgeDir, 'team.yaml'), 'utf8');
  } catch {
    return out;
  }

  // Hand-rolled mini-parser tuned for the `team.yaml` layout that the forge
  // emits: top-level `agents:` block whose children are tier names mapping
  // to arrays of agent ids. Avoids pulling js-yaml on the hot path for inbox
  // writes; the format is stable across forge versions.
  const lines = raw.split('\n');
  let inAgents = false;
  let currentTier: string | null = null;
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\r$/, '');
    if (!inAgents) {
      if (/^agents:\s*(#.*)?$/.test(line)) {
        inAgents = true;
        continue;
      }
      continue;
    }
    // Exit the `agents:` block when we hit another top-level key.
    if (/^\S/.test(line)) {
      if (/^\s*#/.test(line)) continue;
      break;
    }
    // Tier-name line: two-space indent, name + colon, no list marker.
    const tierMatch = /^ {2}([a-z0-9_-]+):\s*(#.*)?$/i.exec(line);
    if (tierMatch) {
      currentTier = tierMatch[1]!.toLowerCase();
      if (!out.has(currentTier)) out.set(currentTier, []);
      continue;
    }
    if (currentTier === null) continue;
    // List item: four-space indent, "- agentId".
    const itemMatch = /^ {4}-\s*([a-z0-9_-]+)\s*(#.*)?$/i.exec(line);
    if (itemMatch) {
      out.get(currentTier)!.push(itemMatch[1]!);
    }
  }

  return out;
}
