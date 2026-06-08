// packages/core/src/autonomous/phase-handlers/execute-phase.ts
//
// v6.5.1 — Real execute phase handler.
//
// Reads the sprint JSON written by the plan phase, then dispatches each
// sprint item sequentially to its assignee agent via the RuntimeAdapter.
// Each agent runs `claude -p` with Read/Write/Edit/Bash/Glob/Grep tools
// enabled so it can actually modify files in the working tree. The
// cycle's git stage later picks up those modifications via
// `collectChangedFiles` and commits them.
//
// Per-item failures are tolerated: an individual agent throw marks that
// item failed and the phase moves on. The phase only returns 'failed'
// when more than `config.limits.maxExecutePhaseFailureRate` (default 0.5)
// of items fail. All-failures returns 'blocked'.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  EpicIntegrationResult,
  GateRetryContext,
  PhaseContext,
  PhaseResult,
  WorktreePoolLike,
} from '../phase-scheduler.js';
import type { ParsedMemoryEntry } from '../../memory/types.js';
import {
  extractBreakdownFromAgentRun,
  mergeBreakdowns,
  type CostBreakdown,
} from '../cost-breakdown.js';
import { appendStepScore } from '../../scoring/jsonl-writer.js';
import type { ModelTier, StepScore } from '@agentforge/shared';
import type { ExecutionProviderKind, RuntimeMode } from '../../runtime/types.js';
// T4.5 — ConcurrencyGate: caps MAX_PARALLEL_AGENTS (default 8, max 40) and
// provides backpressure queue so the execute phase never spawns more agents
// than the configured ceiling, regardless of item count or parallelism cap.
import { ConcurrencyGate } from '../../runtime/concurrency-gate.js';
import { parseSelfEval } from '../self-eval/parser.js';
import { recordSelfEval } from '../self-eval/recorder.js';
// Wave 5 T1 — per-item intra-phase checkpoint writer.
import { ItemCheckpointWriter } from '../checkpoint/item-checkpoint.js';
// Phase 0 — lesson-attribution instrumentation.
import { appendLessonAttributions } from '../../memory/lesson-attribution.js';
import { computeLessonId } from '../../team/engine/learnings/lesson-id.js';
// Gem #2 — semantic reranking of memory entries.
import { rankMemoriesBySemantic } from './semantic-memory.js';
// Epic-decomposer — wave grouping + local integration-branch orchestration.
import { groupItemsByWave } from '../decompose/index.js';
import {
  epicIntegrationBranchName,
  ensureIntegrationWorktree,
  mergeBranchesIntoIntegration,
} from './wave-integration.js';
// P0.5 — deterministic per-child completion bar (no LLM judgement).
import {
  verifyChildWorktree,
  formatChildVerifyError,
  detectPackageCommands,
  type ChildVerifyCommandRunner,
} from './child-verify.js';

// T4 — structured-output contract (inlined pending T1 merge onto origin/main).
/**
 * Captured structured output for an agent run that had an `output_schema`
 * declared in its YAML. Stored in `ItemResult.validatedOutput` when
 * schema validation succeeded.
 */
export interface ValidatedJsonOutput {
  agentId: string;
  schemaName: string;
  /** The raw JSON string returned by the agent. */
  raw: string;
  /** The deserialized JavaScript value. */
  parsed: unknown;
  /** Whether schema validation passed (mirrors RunResult.schemaValidation.ok). */
  ok: boolean;
  /** Error message when ok === false. */
  validationError?: string;
  /** ISO timestamp when the output was captured. */
  capturedAt: string;
}

// ---- Self-eval prompt fragment (loaded once at module init) ----
// Read from disk relative to this file so it works in both source and built
// output. Falls back to empty string so the module is always importable even
// in stripped build trees where the .md file is absent.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let _selfEvalFragment: string;
try {
  _selfEvalFragment = readFileSync(
    join(__dirname, '../self-eval/prompt-fragment.md'),
    'utf8',
  );
} catch {
  _selfEvalFragment = '';
}
export const SELF_EVAL_FRAGMENT = _selfEvalFragment;

const execFileAsync = promisify(execFile);

// ---- Scorer integration (T2) ----
// TODO: replace stub with real import once T1 scorer merges to origin/main.
// import { scoreStep } from '../../scoring/scorer.js';

export interface ScoreStepInput {
  cycleId: string;
  itemId: string;
  agentId: string;
  model: string;
  costUsd: number;
  latencyMs: number;
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  validatedOutput?: ValidatedJsonOutput;
  schemaValidationOk?: boolean;
}

/**
 * T2 stub — returns a deterministic StepScore from available runtime signals.
 * Replaced by the real scorer once T1 merges.
 */
async function scoreStep(input: ScoreStepInput): Promise<StepScore> {
  const schemaValid = input.schemaValidationOk ?? (input.validatedOutput?.ok ?? true);
  const quality = schemaValid ? Math.min(1, 0.7 + (input.costUsd > 0 ? 0.1 : 0)) : 0;
  return {
    step_score_id: randomUUID(),
    cycle_id: input.cycleId,
    phase: 'execute',
    item_id: input.itemId,
    agent_id: input.agentId,
    model: (['opus', 'sonnet', 'haiku'] as const).includes(input.model as 'opus' | 'sonnet' | 'haiku')
      ? (input.model as 'opus' | 'sonnet' | 'haiku')
      : 'sonnet',
    capability_tags: [],
    skill_ids: [],
    output_schema_id: input.validatedOutput?.schemaName ?? null,
    quality,
    rubric_version: '1.0.0',
    signals: [
      {
        key: 'schema.valid',
        value: schemaValid ? 1 : 0,
        source: 'deterministic',
        weight: 1.0,
      },
    ],
    cost_usd: input.costUsd,
    latency_ms: input.latencyMs,
    tokens: input.tokens,
    llm_graded: false,
    created_at: new Date().toISOString(),
  };
}

// ---- Memory injection ----
// Reads tag-filtered past failure entries from .agentforge/memory/*.jsonl so
// each agent can avoid mistakes made on similar work in prior cycles.

/**
 * Memory entry shape used by the execute phase for prompt injection.
 *
 * This is an alias for the canonical `ParsedMemoryEntry` defined in
 * `memory/types.ts`. Historically this module declared its own permissive
 * shape to tolerate legacy JSONL entries that only carry a `key` slug
 * instead of the canonical UUID `id`. That shape now lives on
 * `ParsedMemoryEntry` alongside the strict write-side `CycleMemoryEntry`
 * so both read and write paths share a single source of truth.
 *
 * The `MemoryEntry` alias is preserved for backward compatibility with
 * existing tests and call sites (including `execute-phase-memory.test.ts`
 * and downstream imports from `autonomous/phase-handlers/index.ts`).
 * New code should prefer importing `ParsedMemoryEntry` directly from
 * `@agentforge/core`.
 */
export type MemoryEntry = ParsedMemoryEntry;

/** Types we prioritise when selecting entries to inject into a prompt.
 *  cycle-outcome is skipped — it's high-level and less actionable. */
const PRIORITY_TYPES = new Set(['failure-pattern', 'review-finding', 'gate-verdict', 'learned-fact']);

/**
 * Reads .agentforge/memory/*.jsonl, parses each JSONL line, filters to
 * entries whose tags overlap with `itemTags`, and returns up to `maxEntries`
 * of the most-recent, highest-priority results.
 *
 * Failures are silently tolerated — a missing or corrupt memory dir must
 * never block an execute phase run.
 */
export function readRelevantMemoryEntries(
  projectRoot: string,
  itemTags: string[],
  maxEntries: number = 5,
): MemoryEntry[] {
  const memoryDir = join(projectRoot, '.agentforge', 'memory');
  let files: string[];
  try {
    files = readdirSync(memoryDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    // Memory directory doesn't exist yet — that's fine.
    return [];
  }

  const tagSet = new Set(itemTags.map((t) => t.toLowerCase()));
  const all: MemoryEntry[] = [];

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(memoryDir, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as MemoryEntry;
        // Only include entries that share at least one tag with the item.
        const entryTags = (entry.tags ?? []).map((t: string) => t.toLowerCase());
        if (tagSet.size > 0 && !entryTags.some((t) => tagSet.has(t))) continue;
        all.push(entry);
      } catch {
        // Malformed line — skip.
      }
    }
  }

  // Prioritize failure-related types, then sort by recency (most recent first).
  all.sort((a, b) => {
    const aPriority = PRIORITY_TYPES.has(a.type) ? 0 : 1;
    const bPriority = PRIORITY_TYPES.has(b.type) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });

  return all.slice(0, maxEntries);
}

/** Formats a list of memory entries as a markdown section suitable for
 *  inclusion in an agent prompt.  Returns an empty string when the list
 *  is empty so callers can safely concatenate without extra whitespace. */
export function formatMemorySection(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => {
    // Value may be a raw string or a JSON-stringified object — normalise to string.
    const value = typeof e.value === 'string' ? e.value : JSON.stringify(e.value, null, 2);
    // Prefer the human-readable `key` slug (used by backlog generators and
    // test fixtures), then fall back to the canonical UUID `id`, then to the
    // entry type so the label is always non-empty.
    const label = e.key ?? e.id ?? e.type;
    return `- [${e.type}] **${label}**: ${value}`;
  });
  return `\n## Memory: Past Failures on Similar Work\n\nThe following entries from prior cycles matched this item's tags. Use them to avoid repeating past mistakes:\n\n${lines.join('\n')}\n`;
}

/** Default tools enabled for execute-phase agent runs. Task is intentionally
 *  excluded to prevent recursive subagent dispatch from burning quota. */
export const EXECUTE_PHASE_DEFAULT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
];

interface SprintItem {
  id: string;
  title: string;
  description?: string;
  assignee: string;
  status: string;
  source?: string;
  tags?: string[];
  runtimeMode?: RuntimeMode;
  preferredProvider?: ExecutionProviderKind;
  providerPreference?: ExecutionProviderKind[];
  /** v6.6.0 — Optional declared file paths the item will touch. If absent,
   *  the FileLockManager falls back to a heuristic regex over title +
   *  description, then to "empty" (conservative — serializes against all). */
  files?: string[];
  /** Per-item model tier chosen by the assign phase (static or adaptive). */
  tier?: ModelTier;
  /** Epic-decomposer fields (spec 2026-05-30). Read by the wave-aware
   *  execute loop. Absent on signal cycles. */
  parentEpicId?: string;
  wave?: number;
  predecessors?: string[];
  /** P0.5 — when true, the per-child verify bar requires ≥1 changed test file. */
  requiresTests?: boolean;
}

interface ExecutePhaseRunOptions {
  allowedTools: string[];
  cwd?: string;
  runtimeMode?: RuntimeMode;
  preferredProvider?: ExecutionProviderKind;
  providerPreference?: ExecutionProviderKind[];
  capabilityTier?: ModelTier;
}

/** v6.6.0 — File-aware lock manager used by the execute-phase dispatch loop.
 *  Items with overlapping file declarations serialize; disjoint items still
 *  run in parallel up to the numeric concurrency cap. Items with no declared
 *  or inferred files are conservative — they only run when nothing else is
 *  in flight. */
export class FileLockManager {
  private readonly heldFiles = new Map<string, string>(); // file → itemId
  private readonly itemsHoldingEmpty = new Set<string>();
  /**
   * v6.7.4: when true, items with no declared files run unconstrained
   * (no lock acquired) so they don't serialize against each other. The
   * old conservative behavior treated empty-files items as "could touch
   * anything", which serialized the entire execute phase down to 1
   * concurrent agent because the scoring agent rarely populates the
   * `files` field on backlog items. This was the root cause of cycles
   * showing only 1-2 active agents even with maxParallelism: 10.
   *
   * Trade-off: file conflicts between unconstrained items are now
   * possible. They surface as git stage failures or test failures and
   * the loop's retry/gate logic catches them. Worth the 5-10x speedup.
   */
  constructor(private readonly optimistic = true) {}

  canAcquire(_itemId: string, files: string[]): boolean {
    if (files.length === 0) {
      if (this.optimistic) return true;
      // Conservative fallback: empty files = "could touch anything" —
      // only run when nothing else is in flight.
      return this.heldFiles.size === 0 && this.itemsHoldingEmpty.size === 0;
    }
    // If any item is currently holding an empty (unknown-files) lock, we
    // must wait — that item could touch any file.
    if (!this.optimistic && this.itemsHoldingEmpty.size > 0) return false;
    return !files.some((f) => this.heldFiles.has(f));
  }

  acquire(itemId: string, files: string[]): void {
    if (files.length === 0) {
      // In optimistic mode, don't track empty-file items at all so they
      // never block other items.
      if (!this.optimistic) this.itemsHoldingEmpty.add(itemId);
      return;
    }
    for (const f of files) this.heldFiles.set(f, itemId);
  }

  release(itemId: string): void {
    this.itemsHoldingEmpty.delete(itemId);
    for (const [f, id] of this.heldFiles.entries()) {
      if (id === itemId) this.heldFiles.delete(f);
    }
  }

  pendingForItem(files: string[]): string[] {
    return files.filter((f) => this.heldFiles.has(f));
  }

  get inFlightCount(): number {
    // For introspection in tests.
    return this.itemsHoldingEmpty.size + new Set(this.heldFiles.values()).size;
  }
}

/** v6.6.0 — Heuristic file extraction. Scans title + description for tokens
 *  that look like file paths with common code/doc extensions. Returns an
 *  empty array if nothing matches. */
export function extractFilesFromItem(item: {
  files?: string[];
  title?: string;
  description?: string;
}): string[] {
  if (item.files && item.files.length > 0) return item.files;
  const haystack = `${item.title ?? ''}\n${item.description ?? ''}`;
  const regex = /[\w\-./]+\.(?:ts|tsx|js|jsx|mjs|cjs|md|ya?ml|json|svelte|css|scss|html)/g;
  const matches = haystack.match(regex);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

/**
 * Safeguard #2 — true when an item's declared file and a gate-finding file
 * refer to the same path. Matches on normalized equality or a clean path-suffix
 * (tolerates relative-vs-absolute). Deliberately strict (no basename-only match)
 * so a finding routes to exactly the item that owns it — an over-match would
 * re-run a non-faulted item and reintroduce the "no source changes" failure.
 */
export function fileMatchesFinding(itemFile: string, findingFile: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const a = norm(itemFile);
  const b = norm(findingFile);
  if (!a || !b) return false;
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

interface SprintFile {
  version?: string;
  items?: SprintItem[];
  // Newer wrapped format from sprint-generator: { sprints: [{...}] }
  sprints?: Array<{ version?: string; items?: SprintItem[] } & Record<string, unknown>>;
  [key: string]: unknown;
}

interface ItemResult {
  itemId: string;
  status: 'completed' | 'failed';
  costUsd: number;
  durationMs: number;
  response: string;
  attempts: number;
  model?: string;
  effort?: string;
  resolvedModelId?: string;
  resolvedEffort?: string;
  resolvedProvider?: ExecutionProviderKind;
  resolvedRuntimeMode?: RuntimeMode;
  capabilityTier?: ModelTier;
  /** Per-run cost breakdown (token attribution). Populated by Wave 2. */
  breakdown?: CostBreakdown;
  error?: string;
  /**
   * T4 — Populated when the agent had an `output_schema` and the run
   * returned valid JSON that passed schema validation. Used by downstream
   * phases (e.g. review, gate) to consume typed agent output without
   * re-parsing the raw response string.
   */
  validatedOutput?: ValidatedJsonOutput;
  /**
   * T2 — IDs of StepScore records written to step-scores.jsonl for this item.
   * Additive: preserves existing fields; one entry per successful/failed run.
   */
  step_score_ids?: string[];
  /**
   * Phase 0 lesson-attribution — stable lesson IDs (computeLessonId) of the
   * memory entries that were injected into this item's prompt via memoryEntries.
   * Omitted (not set to undefined) when no memory entries were injected.
   */
  appliedLessons?: string[];
}

export interface ProviderUsageEntry {
  items: number;
  costUsd: number;
}

export type ProviderUsage = Record<string, ProviderUsageEntry>;

function roundCostUsd(value: number): number {
  return Number(value.toFixed(6));
}

export function aggregateProviderUsage(
  items: Array<{ resolvedProvider?: string; costUsd?: number }>,
): ProviderUsage {
  if (items.length === 0) return {};
  const usage: ProviderUsage = {};

  for (const item of items) {
    const providerId =
      typeof item.resolvedProvider === 'string' && item.resolvedProvider.trim().length > 0
        ? item.resolvedProvider
        : 'unknown';
    const costUsd = typeof item.costUsd === 'number' && Number.isFinite(item.costUsd)
      ? item.costUsd
      : 0;
    const current = usage[providerId] ?? { items: 0, costUsd: 0 };
    current.items += 1;
    current.costUsd += costUsd;
    usage[providerId] = current;
  }

  for (const entry of Object.values(usage)) {
    entry.costUsd = roundCostUsd(entry.costUsd);
  }

  return usage;
}

/** Coder-class agent-id prefixes / tags.  An item is considered "agent code
 *  work" eligible for worktree isolation when:
 *    a) its `tags` array includes any of these role keywords, OR
 *    b) its `assignee` agent-id starts with any of these prefixes.
 *
 *  The heuristic deliberately errs on the side of inclusion: if an item might
 *  modify source files (coder, frontend-dev, backend-dev, etc.) it gets its
 *  own worktree.  Non-code items (scorer, auditor, reviewer, architect) stay
 *  on the shared tree since they typically only read files and write phase JSONs
 *  to .agentforge/cycles/ (which are already excluded from commits).
 */
export const CODER_CLASS_PATTERNS = [
  'architect',
  'architecture',
  'engine',
  'coder',
  'frontend',
  'backend',
  'fullstack',
  'svelte',
  'react',
  'fastify',
  'sqlite',
  'playwright',
  'vitest',
  'engineer',
  'developer',
  'dev',
];

function isModelTier(value: unknown): value is ModelTier {
  return value === 'opus' || value === 'sonnet' || value === 'haiku';
}

/**
 * The per-call capabilityTier override for an item: the assign-phase-chosen
 * tier when it is a valid ModelTier, else undefined (keep the agent's tier).
 */
export function selectCapabilityTier(item: { tier?: unknown }): ModelTier | undefined {
  return isModelTier(item.tier) ? item.tier : undefined;
}

/**
 * Returns true when the sprint item is "agent code work" and should be run
 * inside an isolated worktree when a pool is available.
 *
 * Decision logic (T4.2 heuristic):
 *   1. If any of the item's tags match a CODER_CLASS_PATTERN → true
 *   2. If the assignee id starts with / contains a CODER_CLASS_PATTERN → true
 *   3. Otherwise → false (e.g. scorer, auditor, ceo, reviewer)
 */
export function isCoderClassItem(item: { assignee: string; tags?: string[] }): boolean {
  const assigneeLower = item.assignee.toLowerCase();
  if (CODER_CLASS_PATTERNS.some((p) => assigneeLower.includes(p))) return true;
  const tagSet = (item.tags ?? []).map((t) => t.toLowerCase());
  return tagSet.some((t) => CODER_CLASS_PATTERNS.some((p) => t.includes(p)));
}

/**
 * P0.5 — Default per-child verify command runner: execFile (no shell), output
 * tailed by the caller. Distinct from the parent worktree-change helpers so the
 * runner can be swapped for a mock in unit tests via ExecutePhaseOptions.
 */
const defaultChildVerifyRunner: ChildVerifyCommandRunner = async (cmd, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, code: 0, output: `${stdout.toString()}${stderr.toString()}` };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
    return { ok: false, code: typeof e.code === 'number' ? e.code : null, output: out };
  }
};

/**
 * P0.5 — Whether the per-child verify bar should require a test among the
 * child's changed files. True when the item explicitly opts in
 * (`requiresTests`) or carries a tag signalling test-mandatory work. Defaults
 * to false so existing items aren't retroactively forced to add tests; the
 * iron-law scope/diff/typecheck/affected-test checks still run regardless.
 */
function childRequiresTests(item: { requiresTests?: boolean; tags?: string[] }): boolean {
  if (item.requiresTests === true) return true;
  const tags = (item.tags ?? []).map((t) => t.toLowerCase());
  return tags.includes('requires-tests') || tags.includes('tests-required');
}

const GENERATED_RUNTIME_PATHS = [
  '.agentforge/audit-worktrees/',
  '.agentforge/cycles/',
  '.agentforge/run-logs/',
  '.agentforge/worktrees/',
  '.agentforge/knowledge/entities.jsonl',
  '.agentforge/knowledge/embeddings.db',
  '.agentforge/memory/cycle-outcome.jsonl',
  '.agentforge/memory/step-scores.jsonl',
  '.agentforge/v5/agentforge-master.db',
  '.agentforge/v5/workspace-default.db',
  '.playwright-mcp/',
  '.pnpm-store/',
  '.svelte-kit/',
  'coverage/',
  'dist/',
  'node_modules/',
  'test-results/',
];
const MAX_RECORDED_WORKTREE_CHANGES = 200;

function parsePorcelainPath(line: string): string {
  const rest = line.slice(3).trim();
  const arrowIdx = rest.indexOf(' -> ');
  const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest;
  return path.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function isGeneratedRuntimePath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return GENERATED_RUNTIME_PATHS.some((entry) => (
    entry.endsWith('/')
      ? normalized.startsWith(entry)
      : normalized === entry
  ));
}

function comparablePath(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    resolved = resolve(path);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function assertWorktreeGitRoot(worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) {
    throw new Error(
      `Worktree path ${worktreePath} does not exist; cannot verify agent changes.`,
    );
  }

  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw new Error(
      `Worktree path ${worktreePath} is not a git worktree; cannot verify agent changes.`,
    );
  }

  const gitRoot = stdout.toString().trim();
  if (comparablePath(gitRoot) !== comparablePath(worktreePath)) {
    throw new Error(
      `Worktree path ${worktreePath} resolves git root ${gitRoot}; ` +
      'refusing to count changes outside the allocated worktree.',
    );
  }
}

async function gitChangedFiles(worktreePath: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: worktreePath,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.length > 0 && !isGeneratedRuntimePath(file))
    .slice(0, MAX_RECORDED_WORKTREE_CHANGES);
}

async function meaningfulWorktreeChanges(
  worktreePath: string,
  baseBranch = 'main',
  baselineHead?: string,
): Promise<string[]> {
  const strictWorktree = baselineHead !== undefined && baselineHead.trim().length > 0;
  if (!existsSync(worktreePath)) {
    if (strictWorktree) {
      throw new Error(
        `Worktree path ${worktreePath} does not exist; cannot verify agent changes.`,
      );
    }
    return ['__worktree_unverified__'];
  }

  try {
    await assertWorktreeGitRoot(worktreePath);
  } catch (err) {
    if (strictWorktree) throw err;
    return ['__worktree_unverified__'];
  }

  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    if (strictWorktree) {
      throw new Error(
        `Unable to read git status for worktree ${worktreePath}; cannot verify agent changes.`,
      );
    }
    return ['__worktree_unverified__'];
  }
  const worktreeStatusChanges = stdout
    .toString()
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parsePorcelainPath)
    .filter((file) => file.length > 0 && !isGeneratedRuntimePath(file))
    .slice(0, MAX_RECORDED_WORKTREE_CHANGES);
  if (worktreeStatusChanges.length > 0) return worktreeStatusChanges;

  if (baselineHead !== undefined && baselineHead.trim().length > 0) {
    try {
      return await gitChangedFiles(worktreePath, [
        'diff',
        '--name-only',
        `${baselineHead.trim()}...HEAD`,
      ]);
    } catch {
      return [];
    }
  }

  const baseRefs = [...new Set([`origin/${baseBranch}`, baseBranch])];
  for (const baseRef of baseRefs) {
    try {
      const branchChanges = await gitChangedFiles(worktreePath, [
        'diff',
        '--name-only',
        `${baseRef}...HEAD`,
      ]);
      if (branchChanges.length > 0) return branchChanges;
    } catch {
      // Try the next base ref candidate.
    }
  }
  return [];
}

type ExecuteWorktreeHandle = {
  id: string;
  path: string;
  branch: string;
  baselineHead?: string;
  deleteBranchOnRelease?: boolean;
  sourceRef?: string;
  allocatedAt: string;
  agentId: string;
  sessionId: string;
};

function worktreeSessionCandidates(ctx: PhaseContext, item: SprintItem): string[] {
  const runSession = ctx.cycleId ?? ctx.sprintId;
  const baseSession = `${runSession}-${item.id}`;
  const retryAttempt = typeof ctx.retryAttempt === 'number' && ctx.retryAttempt > 0
    ? ctx.retryAttempt
    : 0;
  if (retryAttempt === 0) return [baseSession];

  const retrySession = `${baseSession}-retry-${retryAttempt}`;
  return [baseSession, retrySession, `${retrySession}-resume-1`, `${retrySession}-resume-2`];
}

function shouldRetryWorktreeAllocation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('--[no-]track can only be used if a new branch is created') ||
    message.includes('can only be used if a new branch is created') ||
    message.includes('already exists')
  );
}

function normalizeRejectedBranch(branch: string): string {
  return branch
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '')
    .replace(/[.,;:)]+$/, '');
}

function shouldUseRejectedBranch(ctx: PhaseContext, item: SprintItem): string | undefined {
  const rejectedBranch = ctx.gateRetry?.rejectedBranch;
  if (!rejectedBranch) return undefined;
  const itemIds = (ctx.gateRetry?.itemIds ?? [])
    .filter((id) => typeof id === 'string' && id.length > 0);
  if (itemIds.length > 0 && !itemIds.includes(item.id)) return undefined;
  const normalized = normalizeRejectedBranch(rejectedBranch);
  return normalized.length > 0 ? normalized : undefined;
}

async function allocateWorktreeForItem(
  pool: WorktreePoolLike,
  ctx: PhaseContext,
  item: SprintItem,
  integrationBranch?: string,
): Promise<ExecuteWorktreeHandle> {
  const candidates = worktreeSessionCandidates(ctx, item);
  const rejectedBranch = shouldUseRejectedBranch(ctx, item);
  let lastErr: unknown;

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await pool.allocate({
        agentId: item.assignee,
        sessionId: candidates[i]!,
        ...(rejectedBranch
          ? {
              branchName: rejectedBranch,
              sourceRef: `origin/${rejectedBranch}`,
              deleteBranchOnRelease: false,
            }
          : integrationBranch && item.parentEpicId
            ? { sourceRef: integrationBranch }   // local ref — fork off the epic integration branch
            : {}),
      });
    } catch (err) {
      lastErr = err;
      if (i === candidates.length - 1 || !shouldRetryWorktreeAllocation(err)) {
        throw err;
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface ExecutePhaseOptions {
  /** Override the default Read/Write/Edit/Bash/Glob/Grep tool list. */
  allowedTools?: string[];
  /** Failure-rate threshold above which the phase returns 'failed'.
   *  Default 0.5. */
  maxFailureRate?: number;
  /** Max concurrent item dispatches. Default 3. */
  maxParallelism?: number;
  /** Max retries per failing item (additional attempts beyond the first).
   *  Default 1 (so each item gets up to 2 total tries). */
  maxItemRetries?: number;
  /**
   * T4.2 — When true, worktree allocation is disabled even when
   * `ctx.worktreePool` is provided. Use for smoke runs, unit tests, or any
   * environment where real `git worktree` operations are undesirable.
   */
  disableWorktrees?: boolean;
  /**
   * When true, coder-class items fail instead of falling back to the parent
   * worktree if isolated worktree allocation or commit/push fails.
   */
  requireWorktrees?: boolean;
  /**
   * When true, the self-eval prompt fragment is NOT appended to agent system
   * prompts and self-eval parsing/recording is skipped entirely.
   * Use as an escape hatch in unit tests that don't want the extra prompt
   * noise, or in smoke runs where learning overhead is undesirable.
   */
  selfEvalDisabled?: boolean;
  /**
   * Wave 5 T1 — When true, the phase reads the existing per-item checkpoint
   * (if any) and skips items whose IDs appear in `completedItemIds`. Intended
   * for `agentforge cycle run --resume` invocations.
   */
  resume?: boolean;
  /**
   * P0.5 — Injected command runner for the per-child deterministic verify bar
   * (typecheck + scoped affected tests inside the child's worktree). Defaults to
   * a real execFile wrapper. Unit tests pass a mock so no subprocess runs.
   */
  childVerifyRunner?: ChildVerifyCommandRunner;
  /**
   * P0.5 — Scoped typecheck/test command overrides for the per-child verify bar.
   * When omitted, child-verify uses its built-in defaults
   * (`corepack pnpm exec tsc -b --noEmit --pretty false` and
   * `corepack pnpm exec vitest`).
   */
  childVerifyTypeCheckCommand?: string;
  childVerifyTestCommand?: string;
  /**
   * Known-flaky / environment-specific test files excluded from the per-child
   * scoped test run (threaded from testing.knownFlakyTestFiles). See
   * VerifyChildWorktreeOptions.excludeTestFiles for the rationale (cycle
   * 4e451e22: a darwin-only realpath test failed 9 unrelated children).
   */
  childVerifyExcludeTestFiles?: string[];
  /**
   * P0.5 — Escape hatch: when true the per-child verify bar is skipped entirely
   * even in epic-mode. Used by tests that exercise unrelated epic behaviour and
   * don't want a real typecheck/vitest subprocess to run. The hook is ALSO
   * inherently skipped for flat (non-epic / non-worktree-isolated) cycles.
   */
  disableChildVerify?: boolean;
}

export function makeExecutePhaseHandler(options: ExecutePhaseOptions = {}) {
  return (ctx: PhaseContext) => runExecutePhase(ctx, options);
}

// T4.5 — Priority values for the ConcurrencyGate backpressure queue.
// Higher numbers run first (gate picks highest-priority queued caller).
export const CONCURRENCY_PRIORITY = {
  P0: 100,
  P1: 50,
  P2: 10,
} as const;

/** Map a sprint item's tag-based priority label to a ConcurrencyGate priority number. */
function itemPriority(item: { tags?: string[] }): number {
  const tags = (item.tags ?? []).map((t) => t.toLowerCase());
  if (tags.includes('p0') || tags.includes('critical')) return CONCURRENCY_PRIORITY.P0;
  if (tags.includes('p1') || tags.includes('high')) return CONCURRENCY_PRIORITY.P1;
  return CONCURRENCY_PRIORITY.P2;
}

export async function runExecutePhase(
  ctx: PhaseContext,
  options: ExecutePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'execute' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? EXECUTE_PHASE_DEFAULT_TOOLS;
  const maxFailureRate = options.maxFailureRate ?? 0.5;
  const ceilingParallelism = Math.max(1, options.maxParallelism ?? 3);
  const maxItemRetries = Math.max(0, options.maxItemRetries ?? 1);
  const selfEvalDisabled = options.selfEvalDisabled === true;
  // T4.2: worktree pool — disabled when either disableWorktrees flag is set or
  // the pool is not present in the context.
  const worktreePool = options.disableWorktrees ? undefined : ctx.worktreePool;
  const requireWorktrees = options.requireWorktrees === true;
  // P0.5 — per-child deterministic verify bar config. The hook only runs in
  // epic-mode (worktree-isolated) and can be disabled outright for tests that
  // exercise unrelated epic behaviour. `childVerifyRequiresFullGates` is flipped
  // by any child that touched a CI-config-class file and surfaced on the phase
  // result so the cycle-runner runs verify:gates once at the epic level.
  const childVerifyEnabled = options.disableChildVerify !== true;
  let childVerifyRequiresFullGates = false;

  // T4.5 — ConcurrencyGate enforces MAX_PARALLEL_AGENTS. The gate's cap is
  // independent from execute-phase's own ceilingParallelism: ceilingParallelism
  // is a per-phase load-assessment cap, while the gate enforces the global
  // machine-wide limit (env: MAX_PARALLEL_AGENTS, default 8, max 40).
  const concurrencyGate = new ConcurrencyGate();

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // ---- Read sprint/plan JSON ----
  // Prefer plan.json in the cycle dir (new format); fall back to the legacy
  // .agentforge/sprints/v{N}.json when plan.json is absent (e.g. in tests
  // that pre-date the plan.json migration or in legacy headless runs).
  const planPath = ctx.cycleId
    ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'plan.json')
    : null;
  const legacySprintPath = join(ctx.projectRoot, '.agentforge', 'sprints', `v${ctx.sprintVersion}.json`);
  const sprintPath =
    planPath && existsSync(planPath) ? planPath : legacySprintPath;

  let raw: string;
  try {
    raw = readFileSync(sprintPath, 'utf8');
  } catch (err) {
    const message = `execute phase: failed to read sprint file at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  let sprintFile: SprintFile;
  try {
    sprintFile = JSON.parse(raw) as SprintFile;
  } catch (err) {
    const message = `execute phase: sprint JSON parse error at ${sprintPath}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: new Date().toISOString(),
    });
    throw new Error(message);
  }

  // Locate items array (supports both flat and wrapped { sprints: [...] }).
  const sprintObj =
    sprintFile.items
      ? sprintFile
      : sprintFile.sprints && sprintFile.sprints.length > 0
        ? sprintFile.sprints[0]!
        : null;
  const items: SprintItem[] = (sprintObj?.items ?? []) as SprintItem[];

  // Wave 5 T1 — per-item checkpoint writer (single-concurrency serialized queue).
  // Instantiate once per phase run; shared across all parallel dispatchItem calls.
  const checkpointWriter = new ItemCheckpointWriter(ctx.projectRoot, items.length);
  const checkpointedItemIds = new Set<string>();
  const enqueueItemCheckpoint = (
    itemId: string,
    status: 'completed' | 'failed' | 'skipped',
    agentId: string,
  ): void => {
    if (!ctx.cycleId || checkpointedItemIds.has(itemId)) return;
    checkpointedItemIds.add(itemId);
    checkpointWriter.enqueue(
      ctx.cycleId,
      itemId,
      status,
      agentId,
      null,
    ).catch(() => { /* non-fatal */ });
  };

  // Wave 5 T1 — resume support: read completedItemIds from an existing checkpoint.
  // When options.resume is true and a valid schemaVersion:2 checkpoint exists,
  // items in completedItemIds are skipped without re-dispatching their agent.
  const resumeCompletedIds: Set<string> =
    options.resume === true && ctx.cycleId
      ? ItemCheckpointWriter.getCompletedItemIds(ctx.projectRoot, ctx.cycleId)
      : new Set();

  // ── v6.7.4 Load Assessment ──────────────────────────────────────────────
  // Pick a parallelism that respects BOTH the configured ceiling and the
  // sprint's actual workload. The "team should assess the load" — instead
  // of blindly running at the ceiling, look at item count, declared file
  // overlap, and complexity tags to pick a smarter starting parallelism.
  // Also wires a runtime circuit breaker that halves parallelism mid-phase
  // if items start failing with the rate-limit fingerprint.
  function assessLoad(): { initial: number; rationale: string } {
    const itemCount = items.length;
    if (itemCount === 0) return { initial: 1, rationale: 'no items' };

    // Cap A: never exceed item count
    let cap = Math.min(ceilingParallelism, itemCount);

    // Cap B: complex / heavy items need lower parallelism. Tags like
    // "heavy", "compute", "long-running", "p0" reduce the cap.
    const heavyTags = new Set(['heavy', 'compute', 'long-running', 'architecture']);
    const heavyCount = items.filter((i: any) =>
      Array.isArray(i.tags) && i.tags.some((t: string) => heavyTags.has(t))
    ).length;
    if (heavyCount > itemCount / 2) cap = Math.max(2, Math.floor(cap / 2));

    // Cap C: if MOST items declare overlapping files, dispatch fewer at once
    // (the FileLockManager would serialize them anyway). Cheap heuristic:
    // if every item touches the same directory, lower the cap.
    const allFiles = items.flatMap((i: any) => Array.isArray(i.files) ? i.files : []);
    if (allFiles.length > 0) {
      const dirs = new Set(allFiles.map((f: string) => f.split('/').slice(0, 2).join('/')));
      if (dirs.size <= 2) cap = Math.max(2, Math.min(cap, 3));
    }

    // Cap D: if there are fewer items than the ceiling, no point running at
    // a lower parallelism than item count — but never exceed the configured
    // ceiling (ceilingParallelism). Without the ceiling guard, a user-set
    // maxParallelism: 1 would be silently overridden for ≤3-item sprints.
    if (itemCount <= 3) cap = Math.min(ceilingParallelism, itemCount);

    const rationale = `${itemCount} items, ceiling ${ceilingParallelism}, ${heavyCount} heavy → ${cap} parallel`;
    return { initial: cap, rationale };
  }

  const loadAssessment = assessLoad();
  let maxParallelism = loadAssessment.initial;

  ctx.bus.publish('execute.parallelism.assessed', {
    sprintId: ctx.sprintId,
    phase: 'execute',
    cycleId: ctx.cycleId,
    itemCount: items.length,
    parallelism: loadAssessment.initial,
    ceiling: ceilingParallelism,
    heavyCount: items.filter((i: any) =>
      Array.isArray(i.tags) && i.tags.some((t: string) => new Set(['heavy', 'compute', 'long-running', 'architecture']).has(t))
    ).length,
    rationale: loadAssessment.rationale,
  });

  // Circuit breaker: track consecutive rate-limit-style failures.
  // If we see N in a row, halve parallelism (down to floor of 1).
  let consecutiveRateLimitFails = 0;
  const RATE_LIMIT_TRIP_THRESHOLD = 3;
  function stringifyExecuteError(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // Fall through to String(err).
    }
    return String(err);
  }
  function isQuotaExhaustion(message: string): boolean {
    const lower = message.toLowerCase();
    return /\b(?:insufficient[_\s-]?quota|quota[_\s-]?exceeded|quota exhausted|billing|credits?)\b/.test(lower);
  }
  function isTransientExecuteError(err: unknown): boolean {
    const lower = stringifyExecuteError(err).toLowerCase();
    if (!lower || isQuotaExhaustion(lower)) return false;
    return /\b(?:429|rate\s*limit(?:ed)?|rate-limit(?:ed)?|throttl(?:e|ed|ing)|timeout|timed out|temporar(?:y|ily)|transient|econnreset|etimedout|eai_again|503|502|504)\b/.test(lower);
  }
  function looksLikeRateLimit(err: string): boolean {
    const lower = err.toLowerCase();
    if (isQuotaExhaustion(lower)) return false;
    return /\b(?:429|rate\s*limit(?:ed)?|rate-limit(?:ed)?|throttl(?:e|ed|ing)|timeout|timed out|503|502|504)\b/.test(lower);
  }
  function recordItemResult(success: boolean, errStr?: string): void {
    if (success) {
      consecutiveRateLimitFails = 0;
      return;
    }
    if (errStr && looksLikeRateLimit(errStr)) {
      consecutiveRateLimitFails++;
      if (consecutiveRateLimitFails >= RATE_LIMIT_TRIP_THRESHOLD && maxParallelism > 1) {
        const newCap = Math.max(1, Math.floor(maxParallelism / 2));
        const failedItemIds = Array.from(liveResults.entries())
          .filter(([, r]) => r.status === 'failed')
          .map(([id]) => id);
        ctx.bus.publish('execute.circuit-breaker.tripped', {
          sprintId: ctx.sprintId,
          phase: 'execute',
          cycleId: ctx.cycleId,
          reason: `${consecutiveRateLimitFails} consecutive rate-limit failures`,
          failedItems: failedItemIds,
          parallelism: newCap,
        });
        maxParallelism = newCap;
        consecutiveRateLimitFails = 0;
      }
    } else {
      consecutiveRateLimitFails = 0;
    }
  }

  let totalCost = 0;
  let phaseBreakdown: CostBreakdown | undefined;
  const liveResults = new Map<string, ItemResult>();
  // Phase 0 — lesson-attribution: maps "<itemId>:<lessonId>" → lessonText
  // so the post-phase attribution writer can reconstruct the full entry.
  const itemLessonTexts = new Map<string, string>();

  // Write an incremental execute.json snapshot so the dashboard can show
  // live cost + agent runs during the (long) execute phase instead of
  // waiting until every item finishes. Without this, the cycle detail
  // page's Cost stat stays frozen at ~$0.20 for 20-40 minutes while
  // execute is in flight. Called from the dispatchItem finally block.
  function snapshotExecuteProgress(): void {
    if (!ctx.cycleId) return;
    const snapshotPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    try {
      mkdirSync(dirname(snapshotPath), { recursive: true });
      const runs = Array.from(liveResults.values());
      const providerUsage = aggregateProviderUsage(runs);
      writeFileSync(
        snapshotPath,
        JSON.stringify(
          {
            phase: 'execute',
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status: 'in_progress',
            totalItems: items.length,
            completedItems: runs.filter((r) => r.status === 'completed').length,
            failedItems: runs.filter((r) => r.status === 'failed').length,
            costUsd: totalCost,
            providerUsage,
            agentRuns: runs,
            itemResults: runs,
            snapshotAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch { /* non-fatal */ }
  }

  // ---- Dispatch items in parallel with numeric + file-lock concurrency ----
  // v6.6.0 — FileLockManager serializes items whose declared (or inferred)
  // files overlap, while still running disjoint items in parallel up to
  // maxParallelism.
  const lockMgr = new FileLockManager();
  const itemFiles = new Map<string, string[]>();
  for (const it of items) itemFiles.set(it.id, extractFilesFromItem(it));

  const dispatchItem = async (item: SprintItem): Promise<ItemResult> => {
    const itemStartedAt = Date.now();
    let lastError: string | undefined;
    let attempts = 0;
    // Mark the item as in_progress and persist immediately so the dashboard
    // Items kanban shows it moving from Planned → In Progress the moment
    // the agent starts. Without this, items jump straight from planned to
    // completed and the "In Progress" column always looks empty even when
    // multiple agents are actively working.
    item.status = 'in_progress';
    try {
      writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
    } catch { /* non-fatal */ }

    // T4.2: allocate a worktree ONCE per item (before the retry loop) so all
    // retry attempts reuse the same isolated branch.  Released in the item-level
    // finally block so it's always freed regardless of success or failure.
    let worktreeHandle: ExecuteWorktreeHandle | undefined;
    let worktreeAllocationError: string | undefined;
    const itemRequiresWorktree = requireWorktrees || isCoderClassItem(item);
    const retryRejectedBranch = shouldUseRejectedBranch(ctx, item);
    if (worktreePool !== undefined && itemRequiresWorktree) {
      try {
        worktreeHandle = await allocateWorktreeForItem(worktreePool, ctx, item, integrationBranch);
        itemBranchById.set(item.id, worktreeHandle.branch);
        branchOwnerById.set(worktreeHandle.branch, item.id);
        ctx.bus.publish('execute.worktree.allocated', {
          sprintId: ctx.sprintId,
          phase,
          cycleId: ctx.cycleId,
          itemId: item.id,
          agentId: item.assignee,
          worktreeId: worktreeHandle.id,
          worktreePath: worktreeHandle.path,
          branch: worktreeHandle.branch,
        });
      } catch (allocErr) {
        // Allocation failure is non-fatal: fall back to main-tree execution.
        // This prevents a pool exhaustion or git error from blocking the item.
        ctx.bus.publish('execute.worktree.alloc-failed', {
          sprintId: ctx.sprintId,
          phase,
          cycleId: ctx.cycleId,
          itemId: item.id,
          agentId: item.assignee,
          error: allocErr instanceof Error ? allocErr.message : String(allocErr),
        });
        const rawError = allocErr instanceof Error ? allocErr.message : String(allocErr);
        worktreeAllocationError = retryRejectedBranch
          ? `Rejected branch checkout failed for ${retryRejectedBranch}: ${rawError}`
          : rawError;
        worktreeHandle = undefined;
      }
    } else if (requireWorktrees && itemRequiresWorktree) {
      worktreeAllocationError =
        'worktree pool unavailable while isolated worktrees are required';
    }

    try {
      if (worktreeAllocationError && (requireWorktrees || retryRejectedBranch)) {
        const durationMs = Date.now() - itemStartedAt;
        item.status = 'failed';
        const failedResult = {
          itemId: item.id,
          status: 'failed' as const,
          costUsd: 0,
          durationMs,
          response: '',
          attempts: 0,
          error:
            `Worktree allocation failed for ${item.assignee} on ${item.id}: ` +
            worktreeAllocationError,
          agentId: item.assignee,
        };
        liveResults.set(item.id, failedResult as ItemResult);
        return failedResult;
      }

      // Read tag-filtered memory entries once per item (before retry loop) so
      // every attempt benefits from the same historical context.
      const tagFilteredEntries = readRelevantMemoryEntries(
        ctx.projectRoot,
        item.tags ?? [],
      );
      // Gem #2 — semantically rerank if the real embedding model is available.
      // Falls back to tag-match order (byte-identical) when @xenova/transformers
      // is absent or on any error — never degrades below the deterministic floor.
      const itemText = item.description
        ? `${item.title} ${item.description}`
        : item.title;
      const memoryEntries = await rankMemoriesBySemantic(itemText, tagFilteredEntries);
      // Phase 0 — compute stable lesson IDs for each injected memory entry.
      // Using entry.value as the lesson text (the same text formatMemorySection
      // renders into the prompt). Deduplicate so the same lesson isn't counted
      // twice if it appears in multiple files.
      // Guard: skip entries without a value (e.g. StepScore records that land
      // in the memory dir but have no 'value' field — ParsedMemoryEntry.value
      // is typed as string but callers may read arbitrary JSONL).
      const appliedLessonsMap = new Map<string, string>(); // lessonId → lessonText
      for (const e of memoryEntries) {
        if (typeof e.value !== 'string' || e.value.length === 0) continue;
        const lessonId = computeLessonId(e.value);
        appliedLessonsMap.set(lessonId, e.value);
        // Populate outer map for post-phase attribution writer
        itemLessonTexts.set(`${item.id}:${lessonId}`, e.value);
      }
      const appliedLessons: string[] = [...appliedLessonsMap.keys()];
      for (let attempt = 0; attempt <= maxItemRetries; attempt++) {
        attempts = attempt + 1;
        const runtimeCwd = worktreeHandle?.path ?? ctx.projectRoot;
        const task = buildItemPrompt(
          item,
          runtimeCwd,
          attempt,
          lastError,
          memoryEntries,
          selfEvalDisabled,
          ctx.gateRetry,
        );
        ctx.bus.publish('sprint.phase.item.started', {
          sprintId: ctx.sprintId,
          phase,
          cycleId: ctx.cycleId,
          itemId: item.id,
          agentId: item.assignee,
          title: item.title,
          attempt: attempts,
          filesHinted: item.files ?? [],
        });
        try {
          const runOptions: ExecutePhaseRunOptions = { allowedTools };
          if (worktreeHandle) {
            // T4.2: pass cwd so the runtime runs the agent inside the isolated
            // worktree rather than the main project root.
            runOptions.cwd = worktreeHandle.path;
          }
          if (item.runtimeMode !== undefined) {
            runOptions.runtimeMode = item.runtimeMode;
          }
          if (item.preferredProvider !== undefined) {
            runOptions.preferredProvider = item.preferredProvider;
          }
          if (item.providerPreference !== undefined) {
            runOptions.providerPreference = item.providerPreference;
          }
          const capabilityTier = selectCapabilityTier(item);
          if (capabilityTier !== undefined) {
            runOptions.capabilityTier = capabilityTier;
          }
          const result = await ctx.runtime.run(item.assignee, task, runOptions);

          // ---- Self-eval parse + record (non-blocking) ----
          if (!selfEvalDisabled) {
            const agentOutput = typeof result?.output === 'string' ? result.output : '';
            const grade = parseSelfEval(agentOutput);
            if (grade !== null) {
              try {
                await recordSelfEval({
                  projectRoot: ctx.projectRoot,
                  record: {
                    agentId: item.assignee,
                    cycleId: ctx.cycleId ?? ctx.sprintId,
                    sprintItemId: item.id,
                    grade,
                    recordedAt: new Date().toISOString(),
                  },
                });
              } catch {
                // recordSelfEval failure must NEVER fail the cycle.
              }
            }
          }

          const durationMs = Date.now() - itemStartedAt;
          const costUsd =
            typeof result?.costUsd === 'number' ? result.costUsd : 0;
          const responseText = typeof result?.output === 'string' ? result.output : '';
          totalCost += costUsd;
          let worktreeChangedFiles: string[] = [];
          if (worktreeHandle) {
            worktreeChangedFiles = await meaningfulWorktreeChanges(
              worktreeHandle.path,
              ctx.baseBranch ?? 'main',
              worktreeHandle.baselineHead,
            );
            if (worktreeChangedFiles.length === 0) {
              throw new Error(
                `Agent ${item.assignee} produced no source changes for item ${item.id}. ` +
                `Response was: ${responseText.slice(0, 240) || '(empty)'}`,
              );
            }
          }

          // P0.5 — DETERMINISTIC per-child completion bar (epic-mode only).
          // Before an epic child is counted completed/merged, gate it in code:
          // iron-law checks + scoped typecheck + scoped affected tests INSIDE the
          // child's worktree. A failure throws here, so the catch below marks the
          // item failed with the structured failures in its error — the same
          // failed-item accounting the wave-merge step and any fix-up loop reads.
          // Flat (non-epic) cycles skip this entirely (epicParentId === undefined).
          if (
            childVerifyEnabled &&
            epicParentId !== undefined &&
            worktreeHandle !== undefined
          ) {
            const changedForVerify = worktreeChangedFiles.filter(
              (f) => f !== '__worktree_unverified__',
            );
            const childResult = await verifyChildWorktree({
              worktreePath: worktreeHandle.path,
              changedFiles: changedForVerify,
              declaredFiles: itemFiles.get(item.id) ?? [],
              requiresTests: childRequiresTests(item),
              runner: options.childVerifyRunner ?? defaultChildVerifyRunner,
              ...(options.childVerifyTypeCheckCommand !== undefined
                ? { typeCheckCommand: options.childVerifyTypeCheckCommand }
                : {}),
              ...(options.childVerifyTestCommand !== undefined
                ? { testCommand: options.childVerifyTestCommand }
                : {}),
              ...(options.childVerifyExcludeTestFiles !== undefined
                ? { excludeTestFiles: options.childVerifyExcludeTestFiles }
                : {}),
            });
            if (childResult.requiresFullGates) {
              childVerifyRequiresFullGates = true;
            }
            ctx.bus.publish('execute.child.verified', {
              sprintId: ctx.sprintId,
              phase,
              cycleId: ctx.cycleId,
              itemId: item.id,
              agentId: item.assignee,
              ok: childResult.ok,
              requiresFullGates: childResult.requiresFullGates,
              affectedTests: childResult.affectedTests,
              failures: childResult.failures,
            });
            if (!childResult.ok) {
              throw new Error(formatChildVerifyError(childResult));
            }
          }
          item.status = 'completed';
          const runModel =
            typeof (result as any)?.model === 'string' ? (result as any).model : 'sonnet';
          const runCapabilityTier = isModelTier((result as any)?.capabilityTier)
            ? (result as any).capabilityTier as ModelTier
            : undefined;
          const runEffort =
            typeof (result as any)?.effort === 'string' ? (result as any).effort : undefined;
          const resolvedProvider =
            typeof (result as any)?.resolvedProvider === 'string'
              ? (result as any).resolvedProvider as ExecutionProviderKind
              : typeof (result as any)?.providerKind === 'string'
              ? (result as any).providerKind as ExecutionProviderKind
              : undefined;
          const resolvedRuntimeMode =
            typeof (result as any)?.resolvedRuntimeMode === 'string'
              ? (result as any).resolvedRuntimeMode as RuntimeMode
              : typeof (result as any)?.runtimeModeResolved === 'string'
              ? (result as any).runtimeModeResolved as RuntimeMode
              : undefined;

          // Wave 2: extract per-run CostBreakdown and accumulate into phase total.
          // Use the breakdown already computed by RuntimeAdapter when available;
          // fall back to re-deriving it from usage fields so the path is always safe.
          const runBreakdown: CostBreakdown =
            (result as any)?.breakdown != null
              ? (result as any).breakdown as CostBreakdown
              : extractBreakdownFromAgentRun({
                  model: runModel,
                  ...(runCapabilityTier ? { capabilityTier: runCapabilityTier } : {}),
                  // Price the fallback path by the provider/model that actually
                  // ran so Codex/OpenAI runs aren't mispriced as Anthropic.
                  ...(resolvedProvider ? { resolvedProvider } : {}),
                  resolvedModelId: runModel,
                  usage: {
                    input_tokens: (result as any)?.usage?.input_tokens ?? 0,
                    output_tokens: (result as any)?.usage?.output_tokens ?? 0,
                    cache_creation_input_tokens: (result as any)?.usage?.cache_creation_input_tokens,
                    cache_read_input_tokens: (result as any)?.usage?.cache_read_input_tokens,
                  },
                });
          phaseBreakdown = phaseBreakdown === undefined
            ? runBreakdown
            : mergeBreakdowns(phaseBreakdown, runBreakdown);

          // T4 — Structured-output handling.
          // When the agent's item has an output_schema declared (passed through
          // via RunRequest.outputSchema), check RunResult.schemaValidation and
          // build a ValidatedJsonOutput. The keyword-search fallback path is
          // retained when no output_schema is present (backward compat).
          let validatedOutput: ValidatedJsonOutput | undefined;
          const itemOutputSchema = (item as any).outputSchema as
            | { name: string; strict?: boolean }
            | undefined;
          if (itemOutputSchema) {
            const sv = (result as any)?.schemaValidation as
              | { ok: boolean; error?: string }
              | undefined;
            const svOk = sv ? sv.ok : false;
            let parsedValue: unknown = undefined;
            if (svOk) {
              try {
                parsedValue = JSON.parse(responseText);
              } catch {
                // JSON.parse failed despite transport saying ok — treat as not-ok.
              }
            }
            validatedOutput = {
              agentId: item.assignee,
              schemaName: itemOutputSchema.name,
              raw: responseText,
              parsed: parsedValue,
              ok: svOk,
              ...(sv && !sv.ok && sv.error ? { validationError: sv.error } : {}),
              capturedAt: new Date().toISOString(),
            };
          }

          // T2 — Score the step non-blocking: call scoreStep, append to JSONL.
          let stepScoreIds: string[] = [];
          try {
            const stepScoreFilePath = join(
              ctx.projectRoot,
              '.agentforge',
              'memory',
              'step-scores.jsonl',
            );
            // NOTE: T2 ships with a local `scoreStep` stub (defined above in
            // this file). T1 ships the real scorer at packages/core/src/scoring/.
            // Wiring T1's scorer through this callsite is deferred to Wave 5 —
            // requires a small adapter (camelCase ↔ snake_case ScoreInput).
            const validatedForScore: ValidatedJsonOutput = validatedOutput ?? {
              agentId: item.assignee,
              schemaName: 'no-schema',
              raw: responseText,
              parsed: null,
              ok: true,
              capturedAt: new Date().toISOString(),
            };
            const score = await scoreStep({
              cycleId: ctx.cycleId ?? ctx.sprintId,
              itemId: item.id,
              agentId: item.assignee,
              model: runCapabilityTier ?? runModel,
              costUsd,
              latencyMs: durationMs,
              tokens: {
                input: (result as any)?.usage?.input_tokens ?? 0,
                output: (result as any)?.usage?.output_tokens ?? 0,
                cache_read: (result as any)?.usage?.cache_read_input_tokens ?? 0,
                cache_write: (result as any)?.usage?.cache_creation_input_tokens ?? 0,
              },
              validatedOutput: validatedForScore,
              schemaValidationOk: validatedOutput?.ok ?? true,
            });
            await appendStepScore(score, stepScoreFilePath);
            stepScoreIds = [score.step_score_id];
          } catch {
            // Scoring failure must NEVER block the cycle — log warning only.
            console.warn(`[execute-phase] scoreStep warning for item ${item.id}`);
          }

          const completedResult = {
            itemId: item.id,
            status: 'completed' as const,
            costUsd,
            durationMs,
            response: responseText,
            attempts,
            agentId: item.assignee,
            // Wave 2: attach per-run breakdown for downstream accumulation.
            breakdown: runBreakdown,
            // v6.7.4: surface model + effort to the Agents tab
            model: runModel,
            ...(runEffort ? { effort: runEffort } : {}),
            resolvedModelId: runModel,
            ...(runEffort ? { resolvedEffort: runEffort } : {}),
            ...(resolvedProvider ? { resolvedProvider } : {}),
            ...(resolvedRuntimeMode ? { resolvedRuntimeMode } : {}),
            ...(runCapabilityTier ? { capabilityTier: runCapabilityTier } : {}),
            // T4.2: surface the worktree path/branch for downstream diff capture
            worktreePath: worktreeHandle?.path,
            worktreeBranch: worktreeHandle?.branch,
            ...(worktreeChangedFiles.length > 0 ? { worktreeChangedFiles } : {}),
            // T4: attach structured output when present
            ...(validatedOutput ? { validatedOutput } : {}),
            // T2: step score IDs for downstream traceability
            ...(stepScoreIds.length > 0 ? { step_score_ids: stepScoreIds } : {}),
            // Phase 0: lesson IDs injected into this item's prompt
            ...(appliedLessons.length > 0 ? { appliedLessons } : {}),
          };
          liveResults.set(item.id, completedResult as ItemResult);
          // Flush execute.json immediately so dashboard consumers (e.g. the
          // Epic tab) see this item's costUsd as soon as the agent finishes —
          // before the finally block's worktree git operations and before the
          // sprint.phase.item.completed event fires.
          snapshotExecuteProgress();
          // Wave 5 T1 — write per-item checkpoint after each successful completion.
          // Fire-and-forget: checkpoint write is non-blocking and never fails the phase.
          enqueueItemCheckpoint(item.id, 'completed', item.assignee);
          return completedResult;
        } catch (err) {
          lastError = stringifyExecuteError(err);
          const shouldRetry = attempt < maxItemRetries && isTransientExecuteError(err);
          if (!shouldRetry) {
            const durationMs = Date.now() - itemStartedAt;
            item.status = 'failed';

            // T2 — Write a failure StepScore (quality: 0, schema.valid: 0) non-blocking.
            let failStepScoreIds: string[] = [];
            try {
              const stepScoreFilePath = join(
                ctx.projectRoot,
                '.agentforge',
                'memory',
                'step-scores.jsonl',
              );
              const failScore = await scoreStep({
                cycleId: ctx.cycleId ?? ctx.sprintId,
                itemId: item.id,
                agentId: item.assignee,
                model: 'sonnet',
                costUsd: 0,
                latencyMs: durationMs,
                tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                schemaValidationOk: false,
              });
              await appendStepScore(failScore, stepScoreFilePath);
              failStepScoreIds = [failScore.step_score_id];
            } catch {
              // Non-fatal — scoring failure must never block the cycle.
              console.warn(`[execute-phase] scoreStep warning (fail) for item ${item.id}`);
            }

            const failedResult = {
              itemId: item.id,
              status: 'failed' as const,
              costUsd: 0,
              durationMs,
              response: '',
              attempts,
              error: lastError,
              agentId: item.assignee,
              ...(failStepScoreIds.length > 0 ? { step_score_ids: failStepScoreIds } : {}),
              // Phase 0: lesson IDs injected into this item's prompt
              ...(appliedLessons.length > 0 ? { appliedLessons } : {}),
            };
            liveResults.set(item.id, failedResult as ItemResult);
            // Flush execute.json immediately on failure so the snapshot is
            // up-to-date before the finally block's event publish.
            snapshotExecuteProgress();
            // Wave 5 T1 — write per-item checkpoint after each failure (final attempt).
            enqueueItemCheckpoint(item.id, 'failed', item.assignee);
            return failedResult;
          }
        }
      }
      // unreachable
      const durationMs = Date.now() - itemStartedAt;
      item.status = 'failed';
      const fallthroughResult = {
        itemId: item.id,
        status: 'failed' as const,
        costUsd: 0,
        durationMs,
        response: '',
        attempts,
        error: lastError ?? 'unknown',
        agentId: item.assignee,
      };
      liveResults.set(item.id, fallthroughResult as ItemResult);
      return fallthroughResult;
    } finally {
      // T4.3: commit + push agent work BEFORE releasing the worktree so the
      // branch is persisted to origin before the path is cleaned up.
      // commitAgentWork is a no-op when: AGENT_AUTOCOMMIT_DISABLED is set,
      // no worktree was allocated, or there are no changes in the worktree.
      let commitFailure: Error | undefined;
      if (worktreeHandle) {
        try {
          const { commitAgentWork } = await import('../../runtime/agent-commit.js');
          await commitAgentWork({
            worktreePath: worktreeHandle.path,
            projectRoot: ctx.projectRoot,
            branch: worktreeHandle.branch,
            baseBranch: ctx.baseBranch ?? 'main',
            agentId: item.assignee,
            itemIds: [item.id],
            ...(ctx.cycleId !== undefined ? { sessionId: ctx.cycleId, cycleId: ctx.cycleId } : { sessionId: ctx.sprintId }),
            bus: ctx.bus,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          commitFailure = new Error(
            `Worktree commit/push failed for ${item.assignee} on ${item.id}: ${message}`,
          );
          ctx.bus.publish('execute.worktree.commit-failed', {
            sprintId: ctx.sprintId,
            phase,
            cycleId: ctx.cycleId,
            itemId: item.id,
            agentId: item.assignee,
            worktreeId: worktreeHandle.id,
            worktreePath: worktreeHandle.path,
            branch: worktreeHandle.branch,
            error: message,
          });
        }
      }
      // T4.2: release the worktree (if any) before any other finalisation so
      // the slot is returned to the pool as soon as the agent finishes.
      if (worktreeHandle) {
        try {
          await worktreePool!.release(worktreeHandle.id);
          ctx.bus.publish('execute.worktree.released', {
            sprintId: ctx.sprintId,
            phase,
            cycleId: ctx.cycleId,
            itemId: item.id,
            agentId: item.assignee,
            worktreeId: worktreeHandle.id,
          });
        } catch { /* release errors are non-fatal */ }
      }
      if (commitFailure && requireWorktrees) {
        item.status = 'failed';
        const liveResult = liveResults.get(item.id);
        if (liveResult) {
          liveResult.status = 'failed';
          liveResult.error = commitFailure.message;
        }
      }
      const terminalResult = liveResults.get(item.id);
      if (terminalResult?.status === 'completed' || terminalResult?.status === 'failed') {
        enqueueItemCheckpoint(item.id, terminalResult.status, item.assignee);
      }
      ctx.bus.publish('sprint.phase.item.completed', {
        sprintId: ctx.sprintId,
        phase,
        cycleId: ctx.cycleId,
        itemId: item.id,
        status: item.status,
        completedAt: new Date().toISOString(),
      });
      try {
        writeFileSync(sprintPath, JSON.stringify(sprintFile, null, 2));
      } catch {
        // Non-fatal
      }
      // Update the live execute.json snapshot so the dashboard sees
      // real-time cost + per-agent activity as items complete.
      snapshotExecuteProgress();
      const currentRuns = Array.from(liveResults.values());
      const providerUsage = aggregateProviderUsage(currentRuns);
      ctx.bus.publish('execute.snapshot', {
        sprintId: ctx.sprintId,
        phase: 'execute',
        cycleId: ctx.cycleId,
        completedItems: currentRuns.filter((r) => r.status === 'completed').length,
        failedItems: currentRuns.filter((r) => r.status === 'failed').length,
        inFlightCount: inFlight.size,
        totalItems: items.length,
        costUsd: totalCost,
        providerUsage,
      });
      // v6.7.4: feed result into the circuit breaker so a streak of
      // rate-limit failures dynamically halves parallelism.
      const liveResult = liveResults.get(item.id);
      recordItemResult(
        liveResult?.status === 'completed',
        liveResult?.error ?? lastError,
      );
    }
  };

  // Epic cycle detection (spec §8.2): any item carrying parentEpicId means this
  // is an epic; we maintain a local integration branch so each wave forks off
  // the previous wave's merged code. Flat cycles skip all of this.
  const epicParentId = items.find((it) => it.parentEpicId)?.parentEpicId;
  const integrationBranch = epicParentId ? epicIntegrationBranchName(epicParentId) : undefined;
  let integrationWorktreePath: string | undefined;
  if (integrationBranch && worktreePool) {
    try {
      integrationWorktreePath = await ensureIntegrationWorktree(
        ctx.projectRoot,
        integrationBranch,
        ctx.baseBranch ?? 'main',
      );
    } catch (err) {
      // Non-fatal: fall back to flat behavior (children fork off origin/main).
      ctx.bus.publish('execute.epic.integration-setup-failed', {
        sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId,
        branch: integrationBranch,
        error: err instanceof Error ? err.message : String(err),
      });
      integrationWorktreePath = undefined;
    }
  }

  // Scheduling loop: for each item, wait until both numeric capacity AND
  // the file-lock manager allow dispatch, then launch.
  const inFlight = new Map<Promise<unknown>, string>();
  const settledResults: Array<PromiseSettledResult<ItemResult>> = [];
  const indexById = new Map<string, number>();
  items.forEach((it, idx) => indexById.set(it.id, idx));
  // PR-2c2 — epic wave integration: track which branch each item is allocated to,
  // plus the reverse map (branch → owning itemId) so a conflicted wave-merge can
  // attribute the failure back to the exact child item (PR-2d / P0.4).
  const itemBranchById = new Map<string, string>();
  const branchOwnerById = new Map<string, string>();
  // PR-2d / P0.4 — child branches successfully merged into the integration branch,
  // accumulated across all waves. Surfaced on the phase result so the release path
  // can name them in the single epic PR narrative.
  const mergedIntoIntegration: string[] = [];
  let integrationHadConflicts = false;

  // === safeguard #2 === Gate-retry finding routing.
  // On a gate-rejection retry, re-execute ONLY the items whose declared files
  // match the gate findings; keep the rest (their attempt-1 branch/PR stands).
  // The cycle-level retry used to tell EVERY item to fix the one finding, so
  // non-owning agents made no edit and failed "produced no source changes",
  // blocking the whole cycle (observed in live cycle c6954dbe). If no item
  // matches the findings, fall back to re-executing all (no regression).
  let retryImplicatedIds: Set<string> | null = null;
  const planItemIds = new Set(items.map((it) => it.id));
  const gateRetryItemIds = (ctx.gateRetry?.itemIds ?? [])
    .filter((id) => typeof id === 'string' && planItemIds.has(id));
  if (gateRetryItemIds.length > 0) {
    retryImplicatedIds = new Set(gateRetryItemIds);
  }
  const gateRetryFiles = ctx.gateRetry?.files ?? [];
  if (!retryImplicatedIds && gateRetryFiles.length > 0) {
    const implicated = new Set<string>();
    for (const it of items) {
      const declared = itemFiles.get(it.id) ?? [];
      if (declared.some((f) => gateRetryFiles.some((ff) => fileMatchesFinding(f, ff)))) {
        implicated.add(it.id);
      }
    }
    if (implicated.size > 0) retryImplicatedIds = implicated;
  }

  for (const waveItems of groupItemsByWave(items)) {
    for (const item of waveItems) {
    // Wave 5 T1 — skip items that were completed in a prior (crashed) run.
    if (resumeCompletedIds.has(item.id)) {
      item.status = 'completed';
      const skippedResult: ItemResult = {
        itemId: item.id,
        status: 'completed',
        costUsd: 0,
        durationMs: 0,
        response: '[skipped — already completed in prior run]',
        attempts: 0,
      };
      liveResults.set(item.id, skippedResult);
      settledResults[indexById.get(item.id)!] = { status: 'fulfilled', value: skippedResult };
      continue;
    }

    // Safeguard #2 — on a gate retry, keep items the gate did not fault.
    if (retryImplicatedIds && !retryImplicatedIds.has(item.id)) {
      item.status = 'completed';
      const keptResult: ItemResult = {
        itemId: item.id,
        status: 'completed',
        costUsd: 0,
        durationMs: 0,
        response: '[kept — not faulted by the gate retry; prior attempt branch/PR stands]',
        attempts: 0,
      };
      liveResults.set(item.id, keptResult);
      settledResults[indexById.get(item.id)!] = { status: 'fulfilled', value: keptResult };
      continue;
    }

    const files = itemFiles.get(item.id) ?? [];
    while (
      inFlight.size >= maxParallelism ||
      !lockMgr.canAcquire(item.id, files)
    ) {
      await Promise.race(inFlight.keys());
    }
    lockMgr.acquire(item.id, files);

    // T4.5: acquire a global concurrency-gate slot (MAX_PARALLEL_AGENTS cap).
    // Higher-priority items (P0=100, P1=50, P2=10) unblock first when slots
    // are freed. The gate.acquire() resolves immediately when under cap.
    const gateRelease = await concurrencyGate.acquire(itemPriority(item));

    const p: Promise<unknown> = dispatchItem(item).then(
      (value) => {
        settledResults[indexById.get(item.id)!] = { status: 'fulfilled', value };
        lockMgr.release(item.id);
        inFlight.delete(p);
      },
      (reason) => {
        settledResults[indexById.get(item.id)!] = { status: 'rejected', reason };
        lockMgr.release(item.id);
        inFlight.delete(p);
      },
    ).finally(() => {
      // T4.5: release the gate slot — idempotent, always called regardless of outcome.
      gateRelease();
    });
    inFlight.set(p, item.id);
    }
    // Wave barrier (spec §8.1): block until every item in this wave settles
    // before starting the next wave. For flat (non-epic) cycles there is a
    // single wave, so this is exactly the prior end-of-loop barrier.
    await Promise.allSettled(inFlight.keys());

    // Epic integration (PR-2c2): merge this wave's completed children into the
    // integration branch so the next wave forks off their code.
    if (integrationWorktreePath) {
      const waveBranches = waveItems
        .filter((it) => liveResults.get(it.id)?.status === 'completed')
        .map((it) => itemBranchById.get(it.id))
        .filter((b): b is string => typeof b === 'string');
      if (waveBranches.length > 0) {
        const { merged, conflicted } = await mergeBranchesIntoIntegration(
          integrationWorktreePath,
          waveBranches,
        );
        mergedIntoIntegration.push(...merged);
        if (conflicted.length > 0) {
          // PR-2d / P0.4 — a conflicted child is a HARD signal, not a silent drop.
          // Mark the owning item failed with an explicit conflict error so the
          // existing failed-item accounting (and the gate-retry / fix-up loop)
          // sees it, in addition to the bus event below. Without this the epic
          // PR would ship missing a child's work with no trace.
          integrationHadConflicts = true;
          for (const branch of conflicted) {
            const itemId = branchOwnerById.get(branch);
            if (!itemId) continue;
            const conflictError =
              `Epic wave-merge conflict: branch ${branch} could not be merged into ` +
              `integration branch ${integrationBranch}. The child's work is excluded ` +
              `from the epic PR until the conflict is resolved.`;
            const idx = indexById.get(itemId);
            const targetItem = idx !== undefined ? items[idx] : undefined;
            if (targetItem) targetItem.status = 'failed';
            const prior = liveResults.get(itemId);
            const failedResult: ItemResult = {
              ...(prior ?? {
                itemId,
                status: 'failed',
                costUsd: 0,
                durationMs: 0,
                response: '',
                attempts: 0,
              }),
              status: 'failed',
              error: conflictError,
            };
            liveResults.set(itemId, failedResult);
            if (idx !== undefined) {
              settledResults[idx] = { status: 'fulfilled', value: failedResult };
            }
          }
          ctx.bus.publish('execute.epic.wave-merge-conflict', {
            sprintId: ctx.sprintId, phase, cycleId: ctx.cycleId,
            branch: integrationBranch, conflicted,
          });
        }
      }
    }
  }
  await checkpointWriter.flush();
  // P0.4 — KEYSTONE: do NOT remove the integration worktree here. The integrated
  // waves must survive until the cycle's release stage pushes codex/epic-<id> and
  // opens ONE PR from it. The cycle-runner removes the worktree after release via
  // removeIntegrationWorktree(projectRoot, branch). (Previously this block deleted
  // the worktree, stranding all integrated work with no push and no PR.)
  const settled = settledResults;
  const itemResults: ItemResult[] = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    const item = items[i]!;
    item.status = 'failed';
    return {
      itemId: item.id,
      status: 'failed',
      costUsd: 0,
      durationMs: 0,
      response: '',
      attempts: 0,
      error: s.reason instanceof Error ? s.reason.message : String(s.reason),
    };
  });

  // ---- Phase 0: write lesson-attribution rows (one per item × appliedLesson) ----
  // This is non-fatal: attribution failures never block the cycle.
  if (ctx.cycleId) {
    try {
      const attributionRows: Parameters<typeof appendLessonAttributions>[1] = [];
      for (const result of itemResults) {
        const itemR = result as ItemResult & { agentId?: string };
        const agentId = (itemR.agentId ?? '') as string;
        const lessons = Array.isArray(result.appliedLessons) ? result.appliedLessons : [];
        for (const lessonId of lessons) {
          // Find the original lesson text for this lessonId from the collected
          // memory entries. We stored all (itemId → appliedLessons[]) as IDs;
          // we need the text too. Re-derive from the flat attribution map built
          // per item above. Since this loop is outside the per-item closure,
          // we search the full itemLessonTexts map.
          const lessonText = itemLessonTexts.get(`${result.itemId}:${lessonId}`) ?? '';
          attributionRows.push({
            cycleId: ctx.cycleId,
            itemId: result.itemId,
            agentId,
            lessonId,
            lessonText,
            scope: 'cycle',
          });
        }
      }
      if (attributionRows.length > 0) {
        appendLessonAttributions(ctx.projectRoot, attributionRows);
      }
    } catch {
      // non-fatal
    }
  }

  // ---- Compute phase status ----
  const total = itemResults.length;
  const failed = itemResults.filter((r) => r.status === 'failed').length;
  const completed = total - failed;
  let status: PhaseResult['status'];
  if (total === 0) {
    status = 'completed';
  } else if (failed === total) {
    status = 'blocked';
  } else if (failed / total > maxFailureRate) {
    status = 'failed';
  } else {
    status = 'completed';
  }

  const durationMs = Date.now() - startedAt;
  const providerUsage = aggregateProviderUsage(itemResults);
  // P0.4 — KEYSTONE: surface the epic integration branch on the phase result so
  // the cycle-runner's release stage pushes codex/epic-<id> and opens ONE PR from
  // it, instead of committing to the operator's main tree. Only present when this
  // was an epic cycle and the integration worktree was actually established.
  const epicIntegration: EpicIntegrationResult | undefined =
    integrationBranch && epicParentId && integrationWorktreePath
      ? {
          branch: integrationBranch,
          epicId: epicParentId,
          mergedBranches: [...mergedIntoIntegration],
          hadConflicts: integrationHadConflicts,
          // P0.5 — surface CI-config-class touch so the cycle-runner runs
          // verify:gates once at the epic level (never per child).
          ...(childVerifyRequiresFullGates ? { requiresFullGates: true } : {}),
        }
      : undefined;
  const phaseResult: PhaseResult & { providerUsage: ProviderUsage } = {
    phase,
    status,
    durationMs,
    costUsd: totalCost,
    providerUsage,
    agentRuns: itemResults,
    itemResults,
    ...(epicIntegration ? { epicIntegration } : {}),
  };

  // ---- Write phase JSON to cycle log dir ----
  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    try {
      mkdirSync(dirname(phaseJsonPath), { recursive: true });
      writeFileSync(
        phaseJsonPath,
        JSON.stringify(
          {
            phase,
            sprintId: ctx.sprintId,
            sprintVersion: ctx.sprintVersion,
            cycleId: ctx.cycleId,
            status,
            totalItems: total,
            completedItems: completed,
            failedItems: failed,
            costUsd: totalCost,
            providerUsage,
            durationMs,
            itemResults,
            // Wave 2: accumulated CostBreakdown across all completed agent runs.
            ...(phaseBreakdown !== undefined ? { breakdown: phaseBreakdown } : {}),
            // P0.4 — epic integration branch (present only on epic cycles).
            ...(epicIntegration ? { epicIntegration } : {}),
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // Non-fatal — phase result is still emitted via the bus.
    }
  }
  // Suppress unused-import warning for existsSync — kept for future use.
  void existsSync;

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}

// Exported for unit tests (repo-neutral tooling + declared-scope contract).
export function buildItemPrompt(
  item: SprintItem,
  cwd: string,
  attempt: number = 0,
  lastError?: string,
  memoryEntries: MemoryEntry[] = [],
  selfEvalDisabled = false,
  gateRetry?: GateRetryContext,
): string {
  const tags =
    item.tags && item.tags.length > 0 ? item.tags.join(', ') : 'none';
  const description = item.description || item.title;
  const source = item.source || 'manual';
  const memorySec = formatMemorySection(memoryEntries);
  const gateRetrySec = formatGateRetrySection(gateRetry);
  // Append self-eval fragment unless explicitly disabled.
  const selfEvalSec = selfEvalDisabled || !SELF_EVAL_FRAGMENT ? '' : `\n\n${SELF_EVAL_FRAGMENT}`;
  // Repo-neutral tooling: detect the target repo's package manager from its
  // lockfile. The previous prompt hardcoded AgentForge's `corepack pnpm`
  // toolchain, which instructed agents to run pnpm inside npm/yarn projects
  // (observed on acceptance cycle 11955f95 against an npm repo).
  const pkg = detectPackageCommands(cwd);
  // Declared file scope: the deterministic per-child verifier (P0.5) FAILS any
  // epic child that edits a file outside item.files — so the agent must be
  // told its scope explicitly. Without this section, children innocently
  // touched shared barrels (src/index.ts) and were auto-failed.
  const declaredFiles = (item.files ?? []).filter((f) => typeof f === 'string' && f.length > 0);
  const scopeSec =
    declaredFiles.length > 0
      ? `\n## Declared file scope — ENFORCED by a deterministic verifier
This item declares exactly these files:
${declaredFiles.map((f) => `- ${f}`).join('\n')}
Edit ONLY these files (creating a declared file is fine). A change to ANY other file fails this item automatically. If the task truly cannot be completed without touching an undeclared file, STOP and report the blocker instead of editing it.\n`
      : '';
  const base = `${gateRetrySec}You are working on sprint item "${item.title}" in the repository at ${cwd}.

Description: ${description}
Source: ${source} (e.g., TODO(autonomous) marker)
Tags: ${tags}
${memorySec}
Your job: use the Read, Write, Edit, Bash, Glob, and Grep tools to make the code change required to resolve this item. Do not delegate this item to another agent or return a plan-only response. If you cannot make a concrete repository change, report the blocker clearly. Do NOT commit anything — the autonomous cycle's Git stage will commit everything that changed in the working tree after all items are done.

Tooling: ${pkg.toolingNote} Prefer targeted checks first, then broader checks when risk warrants it.
${scopeSec}
## Scope — keep the diff minimal
Produce the smallest diff that resolves this item. Do not refactor, reformat, or "improve" unrelated code, and do not touch files outside this item's scope. Add or adjust at least one test that fails without your change and passes with it.

## Self-verify before you report done
Before you report completion you MUST verify your own work and paste the passing output:
1. Type-check: \`${pkg.typeCheckCommand}\`
2. Run the targeted tests you added or touched: \`${pkg.testCommand} run <files>\`
If either check fails, fix it before finishing. Never report done on unverified work.

Work efficiently. Report what you changed when done.${selfEvalSec}`;

  if (attempt > 0 && lastError) {
    return `${base}

PREVIOUS ATTEMPT FAILED:
${lastError}

Please take a different approach. Read the relevant files carefully before making changes.`;
  }
  return base;
}

function formatGateRetrySection(gateRetry?: GateRetryContext): string {
  if (!gateRetry) return '';
  const lines = [
    '## Gate Rejection Retry',
    `This is a gate-rejection retry (attempt ${gateRetry.attempt}). Your first priority is to fix the gate finding that rejected the prior PR or branch before continuing the original sprint item.`,
  ];
  if (gateRetry.prNumber !== undefined) {
    lines.push(`Rejected PR: #${gateRetry.prNumber}`);
  }
  if (gateRetry.prUrl) {
    lines.push(`Rejected PR URL: ${gateRetry.prUrl}`);
  }
  if (gateRetry.rejectedBranch) {
    lines.push(`Rejected branch: ${gateRetry.rejectedBranch}`);
  }
  if (gateRetry.files && gateRetry.files.length > 0) {
    lines.push(`Files mentioned by the gate: ${gateRetry.files.join(', ')}`);
  }
  if (gateRetry.itemIds && gateRetry.itemIds.length > 0) {
    lines.push(`Sprint items mapped from the rejected branch: ${gateRetry.itemIds.join(', ')}`);
  }
  if (gateRetry.findings && gateRetry.findings.length > 0) {
    lines.push('Gate findings:');
    for (const finding of gateRetry.findings) {
      lines.push(`- ${finding}`);
    }
  } else {
    lines.push('Gate rationale:');
    lines.push(gateRetry.rationale);
  }
  lines.push('Do not broaden the scope or start unrelated work until the rejected finding is fixed and covered by tests.');
  return `${lines.join('\n')}\n\n`;
}
