/**
 * Memory Curator — selects per-agent learnings from the project's memory store.
 *
 * Reads `.agentforge/memory/*.jsonl` (gate-verdict, review-finding, cycle-outcome),
 * scores each entry's relevance to a given agent template (by tags / domain /
 * role / skills), and returns the top N as a curated bullet list.
 *
 * The customizer feeds these into the `{baked_learnings}` placeholder so each
 * agent's system prompt carries lessons from prior cycles. Output is also
 * persisted to the agent YAML's `learnings:` field for auditability.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTemplate } from "../types/agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  type: string;
  value: string;
  createdAt: string;
  source?: string;
  tags?: string[];
  /**
   * Owning agent id when the entry came from a per-agent memory file
   * (`.agentforge/memory/agents/<agentId>.jsonl`). Absent for shared-pool
   * entries.
   */
  agentId?: string;
}

export interface CuratedLearningOptions {
  /** Max number of lessons to return for this agent. Default: 8 (the documented cap). */
  maxLessons?: number;
  /** Cap on each lesson's character length. Longer values are truncated. Default: 200. */
  maxLessonChars?: number;
  /**
   * Time-decay half-life in days. Older entries are scored lower. Default: 45.
   * Smaller values prioritise recent learnings more aggressively.
   */
  recencyHalfLifeDays?: number;
}

// ---------------------------------------------------------------------------
// Tag → agent-role relevance keywords
// ---------------------------------------------------------------------------

/**
 * Per-role tag affinities. A tag in the entry is worth ROLE_TAG_BOOST when it
 * appears in the agent's affinity list. Keys are matched against the agent's
 * name (case-insensitive substring), category, and skills.
 */
const ROLE_TAG_AFFINITY: Record<string, string[]> = {
  // Quality / gating roles
  reviewer: ["review", "finding", "critical", "major", "gate", "verdict"],
  "code-reviewer": ["review", "finding", "critical", "major"],
  gate: ["gate", "verdict", "approve", "reject"],
  ceo: ["gate", "verdict", "cycle"],
  "team-reviewer": ["review", "finding", "critical", "major"],
  qa: ["test", "failure", "flakiness", "review"],
  debugger: ["fix", "bug", "failure", "critical"],

  // Planning / scoring
  scorer: ["cycle", "cost", "scoring", "fallback", "estimate"],
  "backlog-scorer": ["cycle", "cost", "scoring", "fallback", "estimate"],
  architect: ["architecture", "design", "memory", "api", "agents", "sprints"],
  cto: ["cycle", "cost", "gate", "strategy", "convergence"],
  "project-manager": ["cycle", "sprint", "planning", "convergence"],

  // Implementation roles
  coder: ["fix", "chore", "feature", "review", "finding", "major"],
  "frontend-dev": ["dashboard", "flywheel", "runner", "branches", "svelte"],
  "ui-engineer": ["dashboard", "flywheel", "runner", "approvals"],
  "api-gateway-engineer": ["api", "sse", "endpoint", "fastify"],
  "api-specialist": ["api", "sse", "endpoint", "fastify"],
  "devops-engineer": ["ci", "release", "git", "branches"],
  "build-release-lead": ["ci", "release", "convergence"],
  dba: ["db", "schema", "sqlite", "memory", "approvals"],
  "db-specialist": ["db", "schema", "sqlite", "memory"],

  // Cross-cutting
  observability: ["metrics", "sse", "live", "logs", "runtime"],
  performance: ["cost", "metrics", "runtime"],
  security: ["security", "audit", "vuln", "auth"],
};

const ROLE_TAG_BOOST = 3.0;
/**
 * Boost for entries that live in the agent's OWN per-agent memory file
 * (`memory/agents/<agentId>.jsonl`). Deliberately above ROLE_TAG_BOOST and
 * SEVERITY_BOOST so an agent's own history outranks shared-pool affinity hits.
 */
const OWN_AGENT_BOOST = 8.0;
const SEVERITY_BOOST: Record<string, number> = {
  critical: 4.0,
  major: 2.5,
  minor: 0.5,
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Parse one JSONL file's lines into entries, tolerating malformed lines. */
function parseJsonlFile(path: string, agentId?: string): MemoryEntry[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as MemoryEntry;
      if (parsed && typeof parsed.value === "string") {
        entries.push(agentId ? { ...parsed, agentId } : parsed);
      }
    } catch {
      // malformed line — skip
    }
  }
  return entries;
}

/**
 * Read every `*.jsonl` file under `.agentforge/memory/` (the shared pool)
 * plus every per-agent file under `.agentforge/memory/agents/` and return
 * parsed entries. Per-agent entries are stamped with their `agentId` (taken
 * from the file name) so scoring can weight an agent's OWN history above
 * shared-pool affinity matches. Lines that fail to parse are silently
 * dropped (the file may contain partial writes from interrupted cycles).
 */
export function loadMemoryEntries(projectRoot: string): MemoryEntry[] {
  const memDir = join(projectRoot, ".agentforge", "memory");
  if (!existsSync(memDir)) return [];

  const entries: MemoryEntry[] = [];
  for (const file of readdirSync(memDir)) {
    if (!file.endsWith(".jsonl")) continue;
    entries.push(...parseJsonlFile(join(memDir, file)));
  }

  // Per-agent memory: memory/agents/<agentId>.jsonl
  const agentsDir = join(memDir, "agents");
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const agentId = file.slice(0, -".jsonl".length);
      entries.push(...parseJsonlFile(join(agentsDir, file), agentId));
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Collect the tag affinity set for an agent from its name, category, skills. */
function agentAffinityTags(agent: AgentTemplate): Set<string> {
  const affinity = new Set<string>();
  const nameLower = agent.name.toLowerCase();

  for (const [role, tags] of Object.entries(ROLE_TAG_AFFINITY)) {
    if (nameLower.includes(role)) {
      for (const t of tags) affinity.add(t);
    }
  }

  // Skills can also imply affinity — match skill identifier substrings
  for (const skill of agent.skills ?? []) {
    const s = skill.toLowerCase();
    if (s.includes("review")) affinity.add("review");
    if (s.includes("test")) affinity.add("test");
    if (s.includes("cost") || s.includes("budget")) affinity.add("cost");
    if (s.includes("security") || s.includes("audit")) affinity.add("security");
    if (s.includes("api")) affinity.add("api");
    if (s.includes("debug") || s.includes("bug")) affinity.add("fix");
  }

  return affinity;
}

/** Detect [CRITICAL] / [MAJOR] / [MINOR] markers in a value string. */
function detectSeverity(value: string): keyof typeof SEVERITY_BOOST | null {
  if (/\[CRITICAL\]/i.test(value)) return "critical";
  if (/\[MAJOR\]/i.test(value)) return "major";
  if (/\[MINOR\]/i.test(value)) return "minor";
  return null;
}

/** Recency multiplier — half-life decay since createdAt. */
function recencyScore(createdAt: string, halfLifeDays: number): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return 1.0;
  const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

interface ScoredEntry {
  entry: MemoryEntry;
  score: number;
  preview: string;
}

function scoreEntry(
  entry: MemoryEntry,
  affinity: Set<string>,
  agent: AgentTemplate,
  halfLifeDays: number,
): ScoredEntry {
  let score = 0;

  // Per-agent ownership — an agent's OWN memory entries outrank any
  // shared-pool affinity match; another agent's private entries never leak.
  if (entry.agentId) {
    const normalizedName = agent.name.toLowerCase().replace(/\s+/g, "-");
    if (entry.agentId.toLowerCase() !== normalizedName) {
      return { entry, score: 0, preview: entry.value };
    }
    score += OWN_AGENT_BOOST;
  }

  // Tag affinity
  const tags = entry.tags ?? [];
  for (const tag of tags) {
    if (affinity.has(tag.toLowerCase())) score += ROLE_TAG_BOOST;
  }

  // Severity boost
  const sev = detectSeverity(entry.value);
  if (sev) score += SEVERITY_BOOST[sev]!;

  // Type weighting — gate-verdicts are dense lessons; cycle-outcomes are raw data
  if (entry.type === "gate-verdict") score += 1.0;
  if (entry.type === "review-finding") score += 0.8;

  // Domain match (if agent has a domain and tag mentions it)
  if (agent.domain && tags.some((t) => t.toLowerCase() === agent.domain)) {
    score += 1.0;
  }

  // Recency
  score *= recencyScore(entry.createdAt, halfLifeDays);

  // Mild penalty for entries with no tags — they're harder to attribute
  if (tags.length === 0) score *= 0.5;

  return { entry, score, preview: entry.value };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the top-scoring memory entries for an agent and return them as
 * formatted bullet strings ready to splice into the agent's system prompt.
 *
 * @param agent       - The agent template being customized.
 * @param entries     - All memory entries (load once, curate many).
 * @param options     - Tuning knobs (maxLessons, maxLessonChars, halfLife).
 * @returns           - Array of formatted lesson strings, longest-priority first.
 */
export function curateLearnings(
  agent: AgentTemplate,
  entries: MemoryEntry[],
  options: CuratedLearningOptions = {},
): string[] {
  // 8 is the documented per-agent lessons cap (see CLAUDE.md flywheel notes).
  const maxLessons = options.maxLessons ?? 8;
  const maxChars = options.maxLessonChars ?? 200;
  const halfLife = options.recencyHalfLifeDays ?? 45;

  if (entries.length === 0) return [];

  const affinity = agentAffinityTags(agent);
  const scored = entries
    .map((e) => scoreEntry(e, affinity, agent, halfLife))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored.slice(0, maxLessons);
  return top.map(({ preview }) => {
    const clean = preview
      .replace(/\s+/g, " ")
      .replace(/^[*-]\s*/, "")
      .trim();
    return clean.length > maxChars ? clean.slice(0, maxChars - 1) + "…" : clean;
  });
}

/** Format a list of curated lessons as a markdown bullet block. */
export function formatLearningsBlock(lessons: string[]): string {
  if (lessons.length === 0) {
    return "*(no prior learnings available yet — this section will populate after the first cycle ships)*";
  }
  return lessons.map((l) => `- ${l}`).join("\n");
}
