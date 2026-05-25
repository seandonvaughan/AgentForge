/**
 * Reforge Mutator Gate — T2.2
 *
 * Reads proposed learnings from `.agentforge/forge/learnings-proposed.json`
 * (produced by Workstream P's curator) and writes them into each agent's
 * `.agentforge/agents/<id>.yaml` under the `learnings:` array.
 *
 * Rules applied on every merge:
 *  1. Dedup: reject proposals whose normalised SHA-1 matches an existing or
 *     already-applied lesson.
 *  2. Contradiction: if "always X" and "never X" conflict for the same noun,
 *     the lower-scored entry is dropped.
 *  3. Cap: each agent is limited to LEARNINGS_CAP (12) lessons. Excess entries
 *     (lowest-scored) are dropped.
 *  4. Sort: final list is newest-first (ties broken by score desc).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { writeFileAtomic } from "../fs/atomic-write.js";

// TODO: import { ProposedLearning } from "./types.js" once Workstream P lands
// Inline copy until then:
export interface ProposedLearning {
  agentId: string;
  lesson: string;
  score: number;
  sourceId: string;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | 'INFO';
  rationale: 'role-tag' | 'subsystem' | 'recurring-pattern';
  sourceCreatedAt: string;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface AgentMutatorResult {
  agentId: string;
  /** Count of learnings before this run. */
  before: number;
  /** Count after (capped at LEARNINGS_CAP). */
  after: number;
  /** Lessons newly added in this run. */
  added: string[];
  /** Proposals dropped as exact/near duplicates. */
  deduped: number;
  /** Proposals dropped due to contradiction with a higher-scored existing lesson. */
  contradicted: number;
  /** Proposals dropped because the 12-lesson cap was reached. */
  capped: number;
}

export interface MutatorReport {
  dryRun: boolean;
  perAgent: AgentMutatorResult[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEARNINGS_CAP = 12;
const FULL_AGENT_REFRESH_SLOTS = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a lesson string for dedup: lowercase, strip punctuation,
 * collapse whitespace.
 */
function normalise(lesson: string): string {
  return lesson
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** SHA-1 of the normalised lesson string. */
function lessonHash(lesson: string): string {
  return createHash("sha1").update(normalise(lesson)).digest("hex");
}

/**
 * Extract polarity tokens from a lesson:
 * matches /\b(always|never|must|cannot)\s+\w+/g
 *
 * Returns an array of { polarity, keyword } tuples.
 */
interface PolarityToken {
  polarity: string;
  keyword: string;
}

function polarityTokens(lesson: string): PolarityToken[] {
  const re = /\b(always|never|must|cannot)\s+(\w+)/gi;
  const tokens: PolarityToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(lesson)) !== null) {
    tokens.push({ polarity: m[1]!.toLowerCase(), keyword: m[2]!.toLowerCase() });
  }
  return tokens;
}

/** Antonym pairs that signal a contradiction. */
const ANTONYMS: Array<[string, string]> = [
  ["always", "never"],
  ["must", "cannot"],
];

function areContradicting(a: string, b: string): boolean {
  const ta = polarityTokens(a);
  const tb = polarityTokens(b);

  for (const { polarity: pa, keyword: ka } of ta) {
    for (const { polarity: pb, keyword: kb } of tb) {
      if (ka !== kb) continue;
      for (const [p1, p2] of ANTONYMS) {
        if ((pa === p1 && pb === p2) || (pa === p2 && pb === p1)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Agent YAML helpers
// ---------------------------------------------------------------------------

interface AgentYaml {
  learnings?: unknown[];
  [key: string]: unknown;
}

interface ProposedLearningsFile {
  byAgent?: Record<string, unknown>;
  sourcesScanned?: unknown;
  generatedAt?: unknown;
  [key: string]: unknown;
}

async function loadAgentYaml(agentPath: string): Promise<AgentYaml> {
  let raw: string;
  try {
    raw = await readFile(agentPath, "utf8");
  } catch {
    // Agent file missing — treat as empty
    return {};
  }
  const parsed = yaml.load(raw);
  if (parsed === null || typeof parsed !== "object") {
    return {};
  }
  return parsed as AgentYaml;
}

async function writeAgentYaml(agentPath: string, data: AgentYaml): Promise<void> {
  const dumped = yaml.dump(data, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  await writeFileAtomic(agentPath, dumped);
}

// ---------------------------------------------------------------------------
// Core per-agent mutation logic
// ---------------------------------------------------------------------------

interface RichLearning {
  lesson: string;
  score: number;
  sourceCreatedAt: string;
  existing: boolean;
}

function asLearningText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const PLACEHOLDER_LESSONS = new Set([
  "critical",
  "major",
  "minor",
  "info",
  "review",
  "n a",
  "na",
  "none",
]);

const NO_ACTION_LESSON_RE =
  /\b(no action required|no action needed|nothing to do|no changes needed|looks good|all good)\b/i;
const DECORATIVE_LESSON_RE = /^[\W_]*(insight|status|summary|observation)\s*[:\-.]/i;
const ACTIONABLE_LESSON_RE =
  /\b(always|never|must|cannot|can't|should|do not|don't|avoid|prefer|require|requires|required|ensure|validate|run|write|document|preserve|merge|use|keep|add|remove|update|check|test|lint|typecheck|commit|handle|leave|expose)\b/i;
const DEFECT_LESSON_RE =
  /\b(breaks|bug|corrupt|crash|fail(?:s|ure)?|missing|mishandles|regression|risk|silently|stale|overwrite)\b/i;
const FUNCTION_LESSON_RE = /[A-Za-z_$][\w$]*\([^)]*\)/;

function hasActionableLessonSignal(lesson: string): boolean {
  const normalized = normalise(lesson);
  if (normalized.length === 0) return false;
  if (PLACEHOLDER_LESSONS.has(normalized)) return false;
  if (NO_ACTION_LESSON_RE.test(lesson)) return false;
  if (DECORATIVE_LESSON_RE.test(lesson)) return false;

  const words = normalized.split(" ");
  if (words.length < 3) return false;

  return ACTIONABLE_LESSON_RE.test(lesson) ||
    DEFECT_LESSON_RE.test(lesson) ||
    FUNCTION_LESSON_RE.test(lesson);
}

function asScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asSourceCreatedAt(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : "1970-01-01T00:00:00.000Z";
}

function asSeverity(value: unknown): ProposedLearning["severity"] {
  return value === "CRITICAL" ||
    value === "MAJOR" ||
    value === "MINOR" ||
    value === "INFO"
    ? value
    : "INFO";
}

function asRationale(value: unknown): ProposedLearning["rationale"] {
  return value === "role-tag" ||
    value === "subsystem" ||
    value === "recurring-pattern"
    ? value
    : "role-tag";
}

function sanitizeExistingLearnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asLearningText)
    .filter((lesson): lesson is string => lesson !== null);
}

function sanitizeProposal(value: unknown, agentId: string): ProposedLearning | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<ProposedLearning>;
  const lesson = asLearningText(raw.lesson);
  if (!lesson) return null;
  if (!hasActionableLessonSignal(lesson)) return null;

  return {
    agentId: asLearningText(raw.agentId) ?? agentId,
    lesson,
    score: asScore(raw.score),
    sourceId: asLearningText(raw.sourceId) ?? "unknown",
    severity: asSeverity(raw.severity),
    rationale: asRationale(raw.rationale),
    sourceCreatedAt: asSourceCreatedAt(raw.sourceCreatedAt),
  };
}

function sanitizeProposals(value: unknown, agentId: string): ProposedLearning[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((proposal) => sanitizeProposal(proposal, agentId))
    .filter((proposal): proposal is ProposedLearning => proposal !== null);
}

function readProposedLearningsByAgent(parsed: unknown): Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const candidate = parsed as ProposedLearningsFile;
  if (
    candidate.byAgent !== undefined &&
    candidate.byAgent !== null &&
    typeof candidate.byAgent === "object" &&
    !Array.isArray(candidate.byAgent)
  ) {
    return candidate.byAgent;
  }

  return candidate as Record<string, unknown>;
}

function mutateAgentLearnings(
  existingInput: readonly unknown[],
  proposals: ProposedLearning[],
): {
  merged: string[];
  added: string[];
  deduped: number;
  contradicted: number;
  capped: number;
} {
  const existing = sanitizeExistingLearnings(existingInput);

  // Build hash set of existing learnings for O(1) dedup
  const existingHashes = new Set<string>(existing.map(lessonHash));

  // Augment existing learnings so they can participate in contradiction
  // resolution. Existing learnings are trusted and preserved ahead of new
  // proposals when the cap is reached.
  const existingRich: RichLearning[] = existing.map((lesson) => ({
    lesson,
    score: 1,
    sourceCreatedAt: "1970-01-01T00:00:00.000Z",
    existing: true,
  }));

  let deduped = 0;

  // Phase 1 — filter proposals through dedup
  const dedupedProposals: ProposedLearning[] = [];
  for (const p of proposals) {
    const h = lessonHash(p.lesson);
    if (existingHashes.has(h)) {
      deduped++;
    } else {
      existingHashes.add(h); // prevent within-batch duplicates
      dedupedProposals.push(p);
    }
  }

  // Phase 2 — contradiction resolution between new proposals and existing
  // Build a working set combining existing (trusted) + new proposals
  const allRich: RichLearning[] = [
    ...existingRich,
    ...dedupedProposals.map((p) => ({
      lesson: p.lesson,
      score: p.score,
      sourceCreatedAt: p.sourceCreatedAt,
      existing: false,
    })),
  ];

  // For each contradiction pair keep the higher-scored entry
  const dropped = new Set<number>(); // indices into allRich
  for (let i = 0; i < allRich.length; i++) {
    if (dropped.has(i)) continue;
    for (let j = i + 1; j < allRich.length; j++) {
      if (dropped.has(j)) continue;
      if (areContradicting(allRich[i]!.lesson, allRich[j]!.lesson)) {
        // Keep higher score; drop the lower one
        if (allRich[i]!.score >= allRich[j]!.score) {
          dropped.add(j);
        } else {
          dropped.add(i);
          break; // i is dropped; stop inner loop
        }
      }
    }
  }

  // Count contradictions among the PROPOSED entries only (not existing vs existing)
  const existingCount = existingRich.length;
  let contradicted = 0;
  for (const idx of dropped) {
    if (idx >= existingCount) {
      contradicted++;
    }
  }

  const surviving: RichLearning[] = allRich.filter((_, i) => !dropped.has(i));

  const sortNewLearnings = (a: RichLearning, b: RichLearning): number => {
    const dateDiff =
      new Date(b.sourceCreatedAt).getTime() -
      new Date(a.sourceCreatedAt).getTime();
    if (dateDiff !== 0) return dateDiff;
    return b.score - a.score;
  };

  // Phase 3 — keep trusted existing learnings first while the agent has room.
  // Once an agent is already full, reserve a small refresh window for newer
  // proposed learnings; otherwise a capped agent can never learn again.
  let orderedSurviving: RichLearning[];
  if (existing.length >= LEARNINGS_CAP) {
    const existingSurviving = surviving.filter((entry) => entry.existing);
    const newSurviving = surviving
      .filter((entry) => !entry.existing)
      .sort(sortNewLearnings);
    const refreshCount = Math.min(FULL_AGENT_REFRESH_SLOTS, newSurviving.length);
    const retainedExistingCount = Math.max(0, LEARNINGS_CAP - refreshCount);
    orderedSurviving = [
      ...newSurviving.slice(0, refreshCount),
      ...existingSurviving.slice(0, retainedExistingCount),
      ...newSurviving.slice(refreshCount),
      ...existingSurviving.slice(retainedExistingCount),
    ];
  } else {
    orderedSurviving = surviving.sort((a, b) => {
      if (a.existing !== b.existing) return a.existing ? -1 : 1;
      return sortNewLearnings(a, b);
    });
  }

  // Phase 4 — cap at LEARNINGS_CAP
  const overflow = Math.max(0, orderedSurviving.length - LEARNINGS_CAP);
  const cappedSurviving = orderedSurviving.slice(0, LEARNINGS_CAP);

  // Determine which lessons are newly added
  const existingSet = new Set<string>(existing.map(lessonHash));
  const added = cappedSurviving
    .filter((r) => !existingSet.has(lessonHash(r.lesson)))
    .map((r) => r.lesson);

  return {
    merged: cappedSurviving.map((r) => r.lesson),
    added,
    deduped,
    contradicted,
    capped: overflow,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface ApplyLearningsOptions {
  projectRoot: string;
  dryRun?: boolean;
}

/**
 * Apply proposed learnings from `.agentforge/forge/learnings-proposed.json`
 * into each agent's `.agentforge/agents/<id>.yaml`.
 *
 * @param opts.projectRoot - Absolute path to the project root.
 * @param opts.dryRun      - When true, computes the diff but does NOT write files.
 * @returns MutatorReport  - Per-agent summary; also written to
 *                           `.agentforge/forge/mutator-report.json`.
 */
export async function applyLearnings(
  opts: ApplyLearningsOptions,
): Promise<MutatorReport> {
  const { projectRoot, dryRun = false } = opts;

  const forgeDir = join(projectRoot, ".agentforge", "forge");
  const agentsDir = join(projectRoot, ".agentforge", "agents");
  const proposedPath = join(forgeDir, "learnings-proposed.json");

  // Load proposed learnings
  let rawProposed: string;
  try {
    rawProposed = await readFile(proposedPath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `[mutator] learnings-proposed.json not found at ${proposedPath}. ` +
          "Run the learning curator (Workstream P) first.",
      );
    }
    throw err;
  }

  const parsedProposed: unknown = JSON.parse(rawProposed);
  const proposedByAgent = readProposedLearningsByAgent(parsedProposed);

  const perAgent: AgentMutatorResult[] = [];

  for (const [agentId, proposalInput] of Object.entries(proposedByAgent)) {
    const proposals = sanitizeProposals(proposalInput, agentId);
    if (proposals.length === 0) continue;

    const agentPath = join(agentsDir, `${agentId}.yaml`);
    const agentData = await loadAgentYaml(agentPath);
    const existing = sanitizeExistingLearnings(agentData.learnings);

    const { merged, added, deduped, contradicted, capped } =
      mutateAgentLearnings(existing, proposals);

    perAgent.push({
      agentId,
      before: existing.length,
      after: merged.length,
      added,
      deduped,
      contradicted,
      capped,
    });

    if (!dryRun && added.length > 0) {
      agentData.learnings = merged;
      await writeAgentYaml(agentPath, agentData);
    }
  }

  const report: MutatorReport = {
    dryRun,
    perAgent,
    generatedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    await mkdir(forgeDir, { recursive: true });
    await writeFile(
      join(forgeDir, "mutator-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );
  }

  return report;
}
