// packages/core/src/autonomous/routing/router.ts
//
// Phase D: Capability-tag-aware agent picker.
//
// Replaces the 5-keyword switch in assign-phase.ts:inferAssigneeFromTag.
// Algorithm (in priority order):
//   1. Subsystem match   — file path prefixes from item text → agent owns_subsystems
//   2. Tag match         — item tokens vs agent capability_tags (threshold ≥ 2)
//   3. Legacy fallback   — the existing 5-keyword inferAssigneeFromTag()
//   4. Final fallback    — 'coder' or first agent in index

import type { RoutingIndex, RoutingIndexAgent } from './routing-index.js';
import { inferAssigneeFromTag } from '../phase-handlers/assign-phase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutableItem {
  title?: string;
  description?: string;
  tags?: string[];
}

export type RoutingReason = 'subsystem' | 'tag' | 'legacy' | 'fallback';

export interface PickResult {
  agentId: string;
  reason: RoutingReason;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Path extraction
// ---------------------------------------------------------------------------

const PATH_RE = /((?:packages|src|tests|test|lib|apps|scripts)\/[^\s"'`,)[\]{}]+)/g;

function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text)) !== null) {
    paths.push(m[1]!);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const WORD_RE = /\b[a-zA-Z][a-zA-Z0-9_-]{1,}\b/g;

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  let m: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text)) !== null) {
    tokens.add(m[0]!.toLowerCase());
  }
  return tokens;
}

function itemText(item: RoutableItem): string {
  return [item.title ?? '', item.description ?? '', ...(item.tags ?? [])].join(' ');
}

// ---------------------------------------------------------------------------
// Subsystem match (priority 1)
// ---------------------------------------------------------------------------

/**
 * For each extracted file path, find agents whose owns_subsystems entries are
 * a prefix of that path. Return the agent with the longest (most-specific)
 * matching prefix. If multiple agents tie on prefix length, pick by priority.
 */
function subsystemMatch(
  paths: string[],
  agents: RoutingIndexAgent[],
): { agent: RoutingIndexAgent; prefixLen: number } | null {
  let bestAgent: RoutingIndexAgent | null = null;
  let bestPrefixLen = 0;

  for (const agent of agents) {
    for (const sub of agent.owns_subsystems) {
      const normalSub = sub.endsWith('/') ? sub : sub + '/';
      for (const filePath of paths) {
        const normalPath = filePath.endsWith('/') ? filePath : filePath + '/';
        if (normalPath.startsWith(normalSub) || filePath === sub) {
          const prefixLen = sub.length;
          if (
            prefixLen > bestPrefixLen ||
            (prefixLen === bestPrefixLen && bestAgent !== null && agent.priority > bestAgent.priority)
          ) {
            bestPrefixLen = prefixLen;
            bestAgent = agent;
          }
        }
      }
    }
  }

  return bestAgent ? { agent: bestAgent, prefixLen: bestPrefixLen } : null;
}

// ---------------------------------------------------------------------------
// Tag match (priority 2)
// ---------------------------------------------------------------------------

/**
 * Tag match scoring:
 *   - Each capability_tag is sub-tokenized on `-` (so `fastify-route`
 *     produces both `fastify` and `route` as match targets).
 *   - A tag scores 2.0 for an exact whole-tag match in tokens,
 *     1.0 for a sub-token match (a `-`-split component appears in tokens).
 *   - Agent-id tokens (split on `-`, `_`, `.`) each contribute 0.5 when
 *     the token appears in the item text. This breaks ties between agents
 *     with identical capability_tags by rewarding the one whose identity
 *     is more relevant to the item. Example: item "WorkspaceAdapter losing
 *     session rows" → tokens include `workspace`; agent id
 *     `db-workspace-engineer` yields id-tokens [`db`, `workspace`, `engineer`]
 *     so gains +0.5 for `workspace`, beating `fastify-v5-engineer` (0 id hits).
 *   - The score threshold is 1.0 — a single sub-token match suffices
 *     when there's no better candidate. Earlier threshold of 2 left
 *     most realistic items unmatched and falling through to legacy.
 *
 * Final score formula:
 *   score = Σ capability_tag score (2.0 exact, 1.0 sub-token)
 *         + Σ agent-id-token score (0.5 per token present in item text)
 */
const TAG_MATCH_MIN_SCORE = 1.0;

interface TagScore {
  agent: RoutingIndexAgent;
  score: number;
}

/**
 * Tokenize an agent id string by splitting on `-`, `_`, and `.`.
 * Returns only tokens of length ≥ 2 (filters out noise like single chars).
 */
function agentIdTokens(agentId: string): string[] {
  return agentId
    .toLowerCase()
    .split(/[-_.]+/)
    .filter((t) => t.length >= 2);
}

function tagMatch(tokens: Set<string>, agents: RoutingIndexAgent[]): TagScore | null {
  let best: TagScore | null = null;

  for (const agent of agents) {
    if (agent.capability_tags.length === 0) continue;
    let score = 0;

    // ── Tag component of the score ────────────────────────────────────────
    for (const tag of agent.capability_tags) {
      const lowerTag = tag.toLowerCase();
      if (tokens.has(lowerTag)) {
        score += 2.0; // exact whole-tag match
        continue;
      }
      // Sub-token match: split kebab-case tags and check each component.
      // "fastify-route" -> ["fastify", "route"]; each that appears in
      // tokens contributes 1.0.
      const subTokens = lowerTag.split(/[-_/]/);
      if (subTokens.length > 1) {
        for (const sub of subTokens) {
          if (sub.length >= 2 && tokens.has(sub)) score += 1.0;
        }
      }
    }

    // ── Agent-id-token component of the score (tie-breaker, weight 0.5) ──
    // Split the agent id itself on delimiters and check each token against
    // the item text. This ensures that when two agents share the same
    // capability_tags, the one whose id contains domain words that appear
    // in the item wins.  Weight is intentionally < 1.0 so it can only
    // influence the result when the tag scores are equal or near-equal;
    // it cannot reverse a meaningful tag-score gap.
    for (const idToken of agentIdTokens(agent.id)) {
      if (tokens.has(idToken)) score += 0.5;
    }

    if (score >= TAG_MATCH_MIN_SCORE) {
      if (
        !best ||
        score > best.score ||
        (score === best.score && agent.priority > best.agent.priority)
      ) {
        best = { agent, score };
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Public pickAgent
// ---------------------------------------------------------------------------

/**
 * Pick the best agent for a sprint item using the 4-tier algorithm.
 */
export function pickAgent(item: RoutableItem, index: RoutingIndex): PickResult {
  const agents = index.agents;

  if (agents.length === 0) {
    return { agentId: 'coder', reason: 'fallback', confidence: 0 };
  }

  const text = itemText(item);

  // Priority 1: subsystem match via file paths
  const paths = extractFilePaths(text);
  if (paths.length > 0) {
    const subMatch = subsystemMatch(paths, agents);
    if (subMatch) {
      // Subsystem confidence: base 0.80 + bonus for longer (more-specific) prefixes.
      // Always > tag confidence (max 0.79) so the priority ordering is enforced.
      const confidence = Math.min(0.97, 0.80 + subMatch.prefixLen / 200);
      return { agentId: subMatch.agent.id, reason: 'subsystem', confidence };
    }
  }

  // Priority 2: capability_tags token intersection
  const tokens = tokenize(text);
  const tagResult = tagMatch(tokens, agents);
  if (tagResult) {
    // Tag confidence: capped at 0.79 to remain strictly below subsystem confidence floor (0.80).
    const confidence = Math.min(0.79, 0.35 + tagResult.score * 0.1);
    return { agentId: tagResult.agent.id, reason: 'tag', confidence };
  }

  // Priority 3: legacy 5-keyword fallback — but ONLY when the legacy
  // candidate id actually exists in the current roster. The v18 Opus-driven
  // forge replaced `coder`/`backend-tech-writer`/`architect`/`backend-qa`
  // with project-specific specialists, so falling through to legacy and
  // returning `coder` produces an agentId the executor can't resolve.
  for (const tag of item.tags ?? []) {
    const legacyCandidate = inferAssigneeFromTag(tag);
    if (legacyCandidate && agents.find((a) => a.id === legacyCandidate)) {
      return {
        agentId: legacyCandidate,
        reason: 'legacy',
        confidence: 0.6,
      };
    }
  }

  // Priority 4: final fallback. Prefer the first opus-tier agent (typically
  // the chief-architect / strategist in an Opus-forged team) over the first
  // agent alphabetically, since the architect is the canonical "I don't know
  // who else owns this — figure it out" recipient.
  const coderAgent = agents.find((a) => a.id === 'coder');
  if (coderAgent) {
    return { agentId: 'coder', reason: 'fallback', confidence: 0.1 };
  }
  const opusAgent = agents.find((a) => a.tier === 'opus');
  if (opusAgent) {
    return { agentId: opusAgent.id, reason: 'fallback', confidence: 0.1 };
  }
  return { agentId: agents[0]!.id, reason: 'fallback', confidence: 0.1 };
}
