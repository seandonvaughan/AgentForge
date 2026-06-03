// packages/core/src/autonomous/cycle-runner.ts
//
// Top-level orchestrator for the AgentForge autonomous development cycle.
//
// Drives all six cycle stages in order:
//   STAGE 1 — PLAN    : ProposalToBacklog → ScoringPipeline → BudgetApproval
//   STAGE 2 — STAGE   : SprintGenerator
//   STAGE 3 — RUN     : PhaseScheduler (audit→plan→assign→execute→test→review→gate→release→learn)
//   STAGE 3.5 — TYPECHECK : pnpm build + tsc --noEmit (fail-fast before VERIFY)
//   STAGE 4 — VERIFY  : RealTestRunner + KillSwitch.checkPostVerify
//   STAGE 5 — COMMIT  : GitOps.verifyPreconditions/createBranch/stage/commit/push
//   STAGE 6 — REVIEW  : renderPrBody → PROpener.open
//
// Errors are caught at the top level. CycleKilledError → stage=KILLED. Any
// other error → stage=FAILED. The terminal cycle.json is ALWAYS written via
// CycleLogger.logCycleResult before returning, regardless of outcome.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §6 and
// docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md Task 21.

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

// CycleCheckpoint type + readCheckpoint helper live in
// `./cycle-artifacts/cycle-checkpoint.ts` (Wave 3 T5). Re-export here so the
// public surface that T6 wired up (`import { readCheckpoint } from '@agentforge/core'`)
// keeps working without owning the canonical definitions.
import { writeCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';
export { readCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';

const execFileAsync = promisify(execFile);

// v6.5.1: the TEST_POLLUTION_PATTERNS workaround from v6.4.4 has been removed.
// Tests that previously mutated the real repo's .agentforge/ now use
// os.tmpdir() workspaces (see tests/e2e/cli.test.ts), so collectChangedFiles
// can rely on git status alone — no path-based denylist needed.
import {
  CycleStage,
  CycleKilledError,
  PhaseFailedError,
} from './types.js';
import { GateRejectedError } from './phase-handlers/gate-phase.js';
import { assertLoopNotHalted, persistCycleOutcome } from './loop-guard.js';
import type { CycleConfig, CycleResult, KillSwitchTrip } from './types.js';
import {
  ProposalToBacklog,
  type ProposalAdapter,
} from './proposal-to-backlog.js';
import {
  ScoringPipeline,
  type AdapterForScoring,
  type RuntimeForScoring,
  type ScoringPipelineResult,
} from './scoring-pipeline.js';
import { BudgetApproval } from './budget-approval.js';
import { SprintGenerator, type SprintPlan } from './sprint-generator.js';
import {
  PhaseScheduler,
  type GateRetryContext,
  type PhaseHandler,
  type PhaseName,
  type SprintRunSummary,
} from './phase-scheduler.js';
import { KillSwitch } from './kill-switch.js';
import { CycleLogger } from './cycle-logger.js';
import { renderPrBody } from './pr-body-renderer.js';
import type { RealTestRunner } from './exec/real-test-runner.js';
import type { GitOps } from './exec/git-ops.js';
import type { PROpener } from './exec/pr-opener.js';
import { runAutoReforge, extractInvolvedAgentIds } from './auto-reforge.js';
import {
  runPreVerifyTypeCheck,
  type PreVerifyTypeCheckResult,
} from './pre-verify-typecheck.js';
import { parseCommandArgs, resolveCommandForExecFile } from './subprocess-command.js';
export { parseCommandArgs } from './subprocess-command.js';
import { assertUnattendedSafe } from './audit/unattended-guard.js';
import { buildVerificationSubprocessEnv } from './verification-env.js';
import { mergeBreakdowns, type CostBreakdown } from './cost-breakdown.js';
import { exportCycleTelemetry } from '../telemetry/cycle-telemetry-export.js';
import { resolveTelemetryConfig } from '../telemetry/config.js';
// T4.6 — WorktreeGc: schedule GC at cycle start (clean stale worktrees) and
// cycle end (clean this cycle's worktrees, keep last 20 for forensics).
// TODO(T4.6-BB): once Workstream BB lands the worktreePool in CycleRunnerOptions,
// replace the inline import with a proper typed import and remove the TODO.
import { WorktreeGc } from '../runtime/worktree-gc.js';
import type { WorktreePool } from '../runtime/worktree-pool.js';
import { MergeQueue } from '../runtime/merge-queue.js';
import type { DrainAndMergeResult } from '../runtime/merge-queue.js';
import type { MessageBusV2 } from '../message-bus/message-bus.js';
import type { CycleCheckpoint } from './cycle-artifacts/cycle-checkpoint.js';
import {
  appendLessonAttributions,
  readLessonAttributions,
} from '../memory/lesson-attribution.js';
import type { TestResult } from './types.js';

/**
 * Build a PR title that's safe for `gh pr create` and never truncated mid-word.
 *
 * Why this is a pure exported function: the autonomous loop's first
 * end-to-end successful cycle (b8755f16) crashed at the very last step
 * because the inline title-building logic produced "autonomous(v6.7.0): All
 * three items are well within the $50 cycle budg" — gh's arg parser choked
 * on the unquoted parens, and slice(0, 50) cut a word in half. Extracting
 * this lets the test suite pin both behaviors directly without spinning up
 * a CycleRunner.
 *
 * Rules:
 *   1. Strip parens (gh CLI parses unquoted (...) as option groups)
 *   2. Collapse newlines into single spaces
 *   3. Truncate at 65 chars on the nearest word boundary (ellipsis appended)
 */
export function sanitizePrTitle(version: string, summary: string): string {
  const prefix = `autonomous v${version}: `;
  const room = 65 - prefix.length;
  const oneLine = summary.replace(/[\r\n]+/g, ' ').replace(/[()]/g, '').trim();
  if (oneLine.length <= room) return prefix + oneLine;
  const cut = oneLine.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return prefix + (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
}

export function shouldOpenSingleCyclePr(filesChanged: string[], commitSha: string | null): boolean {
  return filesChanged.length > 0 && commitSha !== null;
}

export function shouldRunAggregateCommit(
  prMode: CycleConfig['prMode'] | undefined,
  filesChanged: string[],
): boolean {
  return prMode !== 'multi' && filesChanged.length > 0;
}

interface AgentPrRecord {
  prNumber?: number;
  number?: number;
  prUrl?: string;
  url?: string;
  branch?: string;
  itemIds?: string[];
  status?: string;
  openedAt?: string;
}

function parsePrNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractPrNumbers(rationale: string): number[] {
  const numbers = new Set<number>();
  for (const match of rationale.matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b/gi)) {
    const parsed = parsePrNumber(match[1]);
    if (parsed !== undefined) numbers.add(parsed);
  }
  for (const match of rationale.matchAll(/\/pull\/(\d+)\b/gi)) {
    const parsed = parsePrNumber(match[1]);
    if (parsed !== undefined) numbers.add(parsed);
  }
  return [...numbers];
}

function extractBranchName(rationale: string): string | undefined {
  const match = rationale.match(/\b(?:target\s+branch|branch)\s+([A-Za-z0-9._/-]+)/i);
  const candidate = match?.[1]?.replace(/[.,;:)]+$/, '');
  if (!candidate) return undefined;
  // Avoid treating ordinary prose such as "target branch diff" as a branch.
  // Agent PR branches are namespaced; unqualified words are not actionable for
  // retry checkout and should fall through to the cycle ledger.
  return candidate.includes('/') ? candidate : undefined;
}

function recordPrNumber(record: AgentPrRecord): number | undefined {
  const candidate = record.prNumber ?? record.number;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined;
}

function isBranchTokenChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9._/-]$/.test(char);
}

function isUrlTokenChar(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9._~:/?#@!$&*+,;=%-]$/.test(char);
}

function containsExactToken(
  text: string,
  token: string,
  isTokenChar: (char: string | undefined) => boolean,
  allowGitRangeSeparator = false,
): boolean {
  if (token.length === 0) return false;
  let index = text.indexOf(token);
  while (index !== -1) {
    const end = index + token.length;
    const before = index > 0 ? text[index - 1] : undefined;
    const after = end < text.length ? text[end] : undefined;
    const hasBeforeGitRange =
      allowGitRangeSeparator && text.slice(Math.max(0, index - 3), index) === '...';
    const hasAfterGitRange = allowGitRangeSeparator && text.slice(end, end + 3) === '...';
    const startsOnBoundary = index === 0 || !isTokenChar(before) || hasBeforeGitRange;
    const endsOnBoundary = end >= text.length || !isTokenChar(after) || hasAfterGitRange;

    if (startsOnBoundary && endsOnBoundary) return true;
    index = text.indexOf(token, index + 1);
  }
  return false;
}

function recordPrUrls(record: AgentPrRecord): string[] {
  return [record.prUrl, record.url]
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

function rationaleMentionsPrUrl(rationale: string, record: AgentPrRecord): boolean {
  return recordPrUrls(record).some((url) => containsExactToken(rationale, url, isUrlTokenChar));
}

function rationaleMentionsBranch(rationale: string, branch: string): boolean {
  return [branch, `origin/${branch}`, `refs/heads/${branch}`]
    .some((token) => containsExactToken(rationale, token, isBranchTokenChar, true));
}

function tokenIndexes(
  text: string,
  token: string,
  isTokenChar: (char: string | undefined) => boolean,
  allowGitRangeSeparator = false,
): number[] {
  const indexes: number[] = [];
  if (token.length === 0) return indexes;

  let index = text.indexOf(token);
  while (index !== -1) {
    const end = index + token.length;
    const before = index > 0 ? text[index - 1] : undefined;
    const after = end < text.length ? text[end] : undefined;
    const hasBeforeGitRange =
      allowGitRangeSeparator && text.slice(Math.max(0, index - 3), index) === '...';
    const hasAfterGitRange = allowGitRangeSeparator && text.slice(end, end + 3) === '...';
    const startsOnBoundary = index === 0 || !isTokenChar(before) || hasBeforeGitRange;
    const endsOnBoundary = end >= text.length || !isTokenChar(after) || hasAfterGitRange;
    if (startsOnBoundary && endsOnBoundary) indexes.push(index);
    index = text.indexOf(token, index + 1);
  }

  return indexes;
}

function branchMentionContexts(rationale: string, branch: string): string[] {
  const mentions = [
    branch,
    `origin/${branch}`,
    `refs/heads/${branch}`,
  ].flatMap((token) => tokenIndexes(rationale, token, isBranchTokenChar, true));

  if (mentions.length === 0) return [];

  const targetStarts = [...rationale.matchAll(/\bTarget\s+\d+\b/gi)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);

  return [...new Set(mentions)].map((index) => {
    const previousTarget = targetStarts
      .filter((targetStart) => targetStart <= index)
      .at(-1);
    const nextTarget = targetStarts.find((targetStart) => targetStart > index);
    const fallbackStart = Math.max(0, index - 180);
    const fallbackEnd = Math.min(rationale.length, index + branch.length + 360);
    const start = previousTarget ?? fallbackStart;
    const end = nextTarget ?? fallbackEnd;
    return rationale.slice(start, end);
  });
}

function branchFindingContextScore(context: string): number {
  let score = 0;
  if (/\b(has\s+)?no\s+unresolved\b/i.test(context)) score -= 100;
  if (/\bdoes\s+not\s+reproduce\b/i.test(context)) score -= 100;
  if (/\bnot\s+faulted\b/i.test(context)) score -= 100;

  if (/\bstill\s+reproduces?\b/i.test(context)) score += 50;
  if (/\brelease\s+blockers?\b/i.test(context)) score += 35;
  if (/\bapproval\s+is\s+disallowed\b/i.test(context)) score += 35;
  if (/\brejected\b/i.test(context)) score += 30;
  if (/\bCRITICAL\b/.test(context)) score += 25;
  if (/\bMAJOR\b/.test(context)) score += 20;
  if (/\bfailed\b/i.test(context)) score += 20;
  if (/\bmust\s+fix\b/i.test(context)) score += 20;
  return score;
}

function findAgentPrRecordByBranchFindingContext(
  records: AgentPrRecord[],
  rationale: string,
): AgentPrRecord | undefined {
  const scored = records
    .map((record) => {
      if (typeof record.branch !== 'string' || record.branch.length === 0) {
        return undefined;
      }
      const contexts = branchMentionContexts(rationale, record.branch);
      if (contexts.length === 0) return undefined;
      const score = Math.max(...contexts.map(branchFindingContextScore));
      return { record, score };
    })
    .filter((entry): entry is { record: AgentPrRecord; score: number } => entry !== undefined);

  const positive = scored.filter((entry) => entry.score > 0);
  if (positive.length === 0) return undefined;

  positive.sort((a, b) => b.score - a.score);
  const best = positive[0]!;
  const second = positive[1];
  if (second !== undefined && second.score === best.score) return undefined;
  return best.record;
}

function mentionedBranchRecords(
  records: AgentPrRecord[],
  rationale: string,
): AgentPrRecord[] {
  const seen = new Set<string>();
  const matches: AgentPrRecord[] = [];
  for (const record of records) {
    if (
      typeof record.branch !== 'string' ||
      record.branch.length === 0 ||
      seen.has(record.branch) ||
      !rationaleMentionsBranch(rationale, record.branch)
    ) {
      continue;
    }
    seen.add(record.branch);
    matches.push(record);
  }
  return matches;
}

function findAgentPrRecord(
  records: AgentPrRecord[],
  rationale: string,
  branchFromRationale: string | undefined,
  prNumbersFromRationale: number[],
): AgentPrRecord | undefined {
  const prUrlMatch = records.find((record) => rationaleMentionsPrUrl(rationale, record));
  if (prUrlMatch !== undefined) return prUrlMatch;

  const prNumberMatch = records.find((record) => {
    const number = recordPrNumber(record);
    return number !== undefined && prNumbersFromRationale.includes(number);
  });
  if (prNumberMatch !== undefined) return prNumberMatch;

  const branchFindingMatch = findAgentPrRecordByBranchFindingContext(records, rationale);
  if (branchFindingMatch !== undefined) return branchFindingMatch;

  const mentionedBranchMatches = mentionedBranchRecords(records, rationale);

  if (branchFromRationale !== undefined) {
    const branchMatch = records.find((record) => record.branch === branchFromRationale);
    if (branchMatch !== undefined && mentionedBranchMatches.length <= 1) return branchMatch;
  }

  return mentionedBranchMatches.length === 1 ? mentionedBranchMatches[0] : undefined;
}

function extractMentionedFiles(rationale: string): string[] {
  const matches = rationale.matchAll(/\b(?:packages|tests|docs|scripts|plugins|apps)\/[A-Za-z0-9._/-]+\b/g);
  return [...new Set(Array.from(matches, (match) => match[0]))].slice(0, 12);
}

function extractFindingLines(rationale: string): string[] {
  return rationale
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function readAgentPrRecords(projectRoot: string, cycleId: string): AgentPrRecord[] {
  const path = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed as AgentPrRecord[] : [];
  } catch {
    return [];
  }
}

function latestAgentPr(records: AgentPrRecord[]): AgentPrRecord | undefined {
  return [...records]
    .filter((record) => record.branch || record.prNumber || record.number)
    .sort((a, b) => (a.openedAt ?? '').localeCompare(b.openedAt ?? ''))
    .at(-1);
}

export function buildGateRetryContext(
  projectRoot: string,
  cycleId: string,
  attempt: number,
  rationale: string,
): GateRetryContext {
  const records = readAgentPrRecords(projectRoot, cycleId);
  const branchFromRationale = extractBranchName(rationale);
  const prNumbersFromRationale = extractPrNumbers(rationale);
  const prFromRationale = prNumbersFromRationale[0];
  const matchingRecord = findAgentPrRecord(
    records,
    rationale,
    branchFromRationale,
    prNumbersFromRationale,
  );
  const fallbackRecord = matchingRecord ?? (records.length === 1 ? latestAgentPr(records) : undefined);
  const selectedRecord = matchingRecord ?? fallbackRecord;
  const selectedPrNumber = selectedRecord !== undefined ? recordPrNumber(selectedRecord) : undefined;
  const rejectedBranch = selectedRecord?.branch ?? (records.length === 0 ? branchFromRationale : undefined);
  const prNumber = selectedPrNumber ?? (records.length === 0 ? prFromRationale : undefined);
  const prUrl = selectedRecord?.prUrl ?? selectedRecord?.url;
  const itemIds = selectedRecord?.itemIds?.filter((id) => typeof id === 'string' && id.length > 0);
  return {
    attempt,
    rationale,
    ...(rejectedBranch !== undefined ? { rejectedBranch } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(itemIds !== undefined && itemIds.length > 0 ? { itemIds } : {}),
    files: extractMentionedFiles(rationale),
    findings: extractFindingLines(rationale),
  };
}

/**
 * Extract a useful error message from a failed execFileAsync call.
 *
 * Critical fix: TypeScript (and most build tools) write compilation errors to
 * stdout, not stderr. Prior code used `??` which only falls through on null/
 * undefined — an empty stderr Buffer toString() returns `""` which is NOT
 * nullish, so the stdout fallback never fired and operators saw an empty
 * "build failed: " message. Cycle a84ea768 was killed by 2 fixable TS errors
 * that this bug hid.
 */
function extractSubprocessError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderrStr = (e.stderr?.toString() ?? '').trim();
  const stdoutStr = (e.stdout?.toString() ?? '').trim();
  const text = stderrStr || stdoutStr || e.message || String(err);
  return text.slice(0, 2000);
}

export interface CycleRunnerOptions {
  cwd: string;
  config: CycleConfig;
  runtime: RuntimeForScoring;
  proposalAdapter: ProposalAdapter;
  scoringAdapter: AdapterForScoring;
  phaseHandlers: Record<PhaseName, PhaseHandler>;
  testRunner: RealTestRunner;
  gitOps: GitOps;
  prOpener: PROpener;
  bus: {
    publish: (topic: string, payload: any) => void;
    subscribe: (topic: string, cb: (event: any) => void) => () => void;
  };
  dryRun?: { prOpener?: boolean };
  /**
   * Pre-allocated cycle ID. When provided, the runner uses this value instead
   * of reading AUTONOMOUS_CYCLE_ID from env or generating a fresh UUID. Use
   * this when the caller has already created a CycleLogger (e.g. to pass to
   * GitOps) so both share the same directory.
   */
  cycleId?: string;
  /**
   * Optional pre-verify type-checker injected between STAGE 3 (RUN) and
   * STAGE 4 (VERIFY). When omitted, a built-in implementation runs
   * `config.testing.buildCommand` then `config.testing.typeCheckCommand`
   * via execFileAsync. Inject a controlled mock in unit tests to avoid
   * executing real build commands in tmpdir environments.
   *
   * The runner respects `config.quality.requireBuildSuccess` and
   * `config.quality.requireTypeCheckSuccess` — a failure only trips the
   * kill switch when the corresponding flag is true.
   */
  preVerifyTypeCheck?: (cwd: string, testing: CycleConfig['testing']) => Promise<PreVerifyTypeCheckResult>;
  /**
   * Optional branch-level verifier for prMode='multi'. Production defaults to
   * checking each recorded agent branch in an isolated temporary git worktree.
   * Tests inject this so the runner behavior can be verified without shelling
   * out to package managers.
   */
  multiPrBranchVerifier?: MultiPrBranchVerifier;
  /**
   * T4.2/T4.6 — Optional WorktreePool. When provided:
   *   - T4.2: execute phase allocates a fresh isolated git worktree per
   *     coder-class sprint item, preventing main-tree branch ping-pong.
   *   - T4.6: WorktreeGc runs at cycle start + end to clean up stale worktrees.
   *
   * When absent, the runner falls back to single-tree execution (legacy behavior).
   * Disable explicitly with `disableWorktrees: true` for tests/smoke runs.
   *
   * NOTE: WorktreePool is typed as 'any' until Workstream AA lands
   * packages/core/src/runtime/worktree-pool.ts — the pre-existing T4.6 import
   * already covers the class type once AA ships.
   */
  worktreePool?: WorktreePool;
  /**
   * T4.2 — When true, worktree allocation is completely disabled for this
   * cycle, even if a `worktreePool` is provided. Use for smoke runs, CI
   * environments without git worktree support, or unit tests that don't need
   * real isolation.
   */
  disableWorktrees?: boolean;
  /**
   * Full `MessageBusV2` instance required for multi-PR mode (prMode='multi').
   *
   * The `bus` field above uses a simplified `(topic, payload)` facade that is
   * sufficient for most internal event publishing, but `MergeQueue` needs the
   * full typed bus API (subscribe with typed envelopes, etc.). Provide this
   * when constructing a cycle with `prMode='multi'`.
   *
   * When absent and prMode='multi', the MergeQueue will not be started and
   * the cycle falls back to single-PR behavior with a console warning.
   */
  messageBus?: MessageBusV2;
  /**
   * Resume checkpoint (Wave 3 T5+T6). When provided:
   *   - The runner reuses `resumeCheckpoint.cycleId` instead of generating a new one.
   *   - `totalCostUsd` is seeded from `resumeCheckpoint.spentUsd`.
   *   - PhaseScheduler is told to skip phases in `completedPhases` and start at `resumeFromPhase`.
   * Supplied by the CLI when `--resume <cycleId>` is passed.
   */
  resumeCheckpoint?: CycleCheckpoint;
  /** Epic-decomposer: operator objective threaded to the plan phase's epic path. */
  objective?: string;
}

export interface MultiPrBranchVerificationRun {
  branch: string;
  agentId?: string;
  itemId?: string;
}

export interface MultiPrBranchVerificationEntry {
  branch: string;
  agentId?: string;
  itemId?: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  currentStep?: string;
  command?: string;
  commandIndex?: number;
  commandsCompleted?: number;
  cleanupCompleted?: boolean;
  durationMs: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface MultiPrBranchVerificationResult {
  passed: boolean;
  results: MultiPrBranchVerificationEntry[];
  parallelism?: number;
  skipped?: boolean;
  reason?: string;
}

export type MultiPrBranchVerifier = (opts: {
  cwd: string;
  cycleId: string;
  baseBranch: string;
  testing: CycleConfig['testing'];
}) => Promise<MultiPrBranchVerificationResult>;

// ---------------------------------------------------------------------------
// Exported helper: collectFilesFromAgentBranches
//
// Extracted from CycleRunner so it can be unit-tested without spinning up the
// full runner (which requires a live git repo, KillSwitch, CycleLogger, etc.).
// CycleRunner.collectFilesFromAgentBranches() delegates here.
// ---------------------------------------------------------------------------

/**
 * Collect changed files from agent worktree branches recorded in
 * `.agentforge/cycles/<cycleId>/phases/execute.json`.
 *
 * For each completed agent run that recorded a `worktreeBranch`, run:
 *   git diff --name-only origin/<baseBranch>...<worktreeBranch>
 * inside `cwd` (the main repo working tree). File-discovery only — the actual
 * git add/commit/push continues to run against the main tree using the paths
 * returned here.
 *
 * - Worktrees may already have been released by the time this helper runs;
 *   use the recorded branch as source of truth instead of the checkout path.
 * - Files under `.agentforge/cycles/` are excluded.
 * - Results are de-duplicated across all branches and returned sorted.
 */
export async function collectFilesFromAgentBranches(opts: {
  cwd: string;
  cycleId: string;
  baseBranch: string;
}): Promise<string[]> {
  const { cwd, cycleId, baseBranch } = opts;
  const execPath = join(cwd, '.agentforge/cycles', cycleId, 'phases/execute.json');
  if (!existsSync(execPath)) return [];

  let execData: unknown;
  try {
    execData = JSON.parse(readFileSync(execPath, 'utf8'));
  } catch {
    return [];
  }

  const agentRuns: Array<Record<string, unknown>> =
    (execData as { agentRuns?: Array<Record<string, unknown>> }).agentRuns ?? [];

  const allFiles = new Set<string>();

  for (const run of agentRuns) {
    const branch = typeof run['worktreeBranch'] === 'string' ? run['worktreeBranch'] : undefined;

    if (!branch) continue;

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', `origin/${baseBranch}...${branch}`],
        { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      );
      const files = stdout
        .toString()
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.length > 0)
        .filter(f => !f.includes('.agentforge/cycles/'));
      for (const f of files) allFiles.add(f);
    } catch {
      // Branch may not be pushed yet or remote may not know it; skip silently.
    }
  }

  return [...allFiles].sort();
}

const DEFAULT_MULTI_PR_VERIFY_INSTALL_COMMAND =
  'corepack pnpm install --frozen-lockfile --prefer-offline';

const REQUIRED_MULTI_PR_VERIFY_BOOTSTRAP_COMMANDS = [
  'node -e "require(\'better-sqlite3\'); console.log(\'better-sqlite3 ok\')"',
  'corepack pnpm --filter @agentforge/dashboard exec svelte-kit sync',
] as const;

function parseMultiPrVerifyCommandOverride(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((cmd) => typeof cmd === 'string')) {
      return parsed;
    }
  } catch {
    // Fall through to newline-delimited parsing for ad-hoc shell use.
  }

  return trimmed
    .split(/\r?\n/)
    .map((cmd) => cmd.trim())
    .filter((cmd) => cmd.length > 0);
}

function readMultiPrBranchRuns(cwd: string, cycleId: string): MultiPrBranchVerificationRun[] {
  const execPath = join(cwd, '.agentforge/cycles', cycleId, 'phases/execute.json');
  if (!existsSync(execPath)) return [];

  let execData: unknown;
  try {
    execData = JSON.parse(readFileSync(execPath, 'utf8'));
  } catch {
    return [];
  }

  const agentRuns: Array<Record<string, unknown>> =
    (execData as {
      agentRuns?: Array<Record<string, unknown>>;
      itemResults?: Array<Record<string, unknown>>;
    }).agentRuns ?? (execData as {
      itemResults?: Array<Record<string, unknown>>;
    }).itemResults ?? [];
  const seen = new Set<string>();
  const runs: MultiPrBranchVerificationRun[] = [];

  for (const run of agentRuns) {
    const branch = typeof run['worktreeBranch'] === 'string' ? run['worktreeBranch'].trim() : '';
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    const agentId = typeof run['agentId'] === 'string' ? run['agentId'] : undefined;
    const itemId = typeof run['itemId'] === 'string' ? run['itemId'] : undefined;
    runs.push({
      branch,
      ...(agentId !== undefined ? { agentId } : {}),
      ...(itemId !== undefined ? { itemId } : {}),
    });
  }

  return runs;
}

export function multiPrVerifyCommands(testing: CycleConfig['testing']): string[] {
  const installOverride = process.env['AGENTFORGE_MULTI_PR_VERIFY_INSTALL_COMMAND']?.trim();
  const installCommand = installOverride && installOverride.length > 0
    ? installOverride
    : DEFAULT_MULTI_PR_VERIFY_INSTALL_COMMAND;
  const envVerificationCommands = parseMultiPrVerifyCommandOverride(
    process.env['AGENTFORGE_MULTI_PR_VERIFY_COMMANDS'],
  );
  const configuredVerificationCommands = Array.isArray(testing.multiPrVerifyCommands)
    ? testing.multiPrVerifyCommands
    : undefined;
  const verificationCommands =
    envVerificationCommands && envVerificationCommands.length > 0
      ? envVerificationCommands
      : configuredVerificationCommands && configuredVerificationCommands.length > 0
      ? configuredVerificationCommands
      : [testing.buildCommand, testing.typeCheckCommand, testing.command];

  return [
    installCommand,
    ...REQUIRED_MULTI_PR_VERIFY_BOOTSTRAP_COMMANDS,
    ...verificationCommands,
  ]
    .map((cmd) => cmd?.trim() ?? '')
    .filter((cmd) => cmd.length > 0);
}

function writeMultiPrBranchVerificationArtifact(
  cwd: string,
  cycleId: string,
  payload: unknown,
): void {
  try {
    const cycleDir = join(cwd, '.agentforge/cycles', cycleId);
    mkdirSync(cycleDir, { recursive: true });
    const body =
      typeof payload === 'object' && payload !== null
        ? payload as Record<string, unknown>
        : { value: payload };
    writeFileSync(
      join(cycleDir, 'multi-pr-branch-verification.json'),
      JSON.stringify({
        ...body,
        capturedAt: new Date().toISOString(),
      }, null, 2),
    );
  } catch {
    // Observability-only.
  }
}

function formatMultiPrBranchVerificationFailure(result: MultiPrBranchVerificationResult): string {
  const failed = result.results
    .filter((entry) => entry.status === 'failed')
    .slice(0, 5)
    .map((entry) => {
      const parts = [
        `branch ${entry.branch}`,
        entry.agentId ? `agent ${entry.agentId}` : undefined,
        entry.itemId ? `item ${entry.itemId}` : undefined,
        entry.command ? `command ${entry.command}` : undefined,
      ].filter((part): part is string => part !== undefined);
      const details = (entry.error ?? entry.stderr ?? entry.stdout ?? '').trim();
      return details.length > 0
        ? `${parts.join(', ')} failed: ${details.slice(0, 800)}`
        : `${parts.join(', ')} failed`;
    });

  return [
    'Multi-PR branch verification rejected the cycle after gate approval.',
    'Retry the implicated branch in place and fix the failing verification command before changing unrelated files.',
    failed.length > 0
      ? `Failed branch verification: ${failed.join(' | ')}`
      : `Failed branch verification: ${result.reason ?? 'unknown branch failure'}`,
  ].join(' ');
}

function safePathWithin(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel));
}

export function verificationWorktreeName(cycleId: string, index: number, branch: string): string {
  const hash = createHash('sha256')
    .update(`${cycleId}\0${branch}`)
    .digest('hex')
    .slice(0, 12);
  return `verify-${index + 1}-${hash}`;
}

export async function execCommandInDir(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  const parts = parseCommandArgs(command);
  if (parts.length === 0) return { stdout: '', stderr: '' };
  const invocation = resolveCommandForExecFile(parts[0]!, parts.slice(1));
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 50 * 1024 * 1024,
    env: buildVerificationSubprocessEnv(),
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function resolveBranchRef(cwd: string, branch: string): Promise<string> {
  try {
    await execFileAsync(
      'git',
      ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`],
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
  } catch {
    // Local-only branches are valid in dry-run/dev workflows.
  }

  for (const ref of [branch, `origin/${branch}`]) {
    try {
      await execFileAsync(
        'git',
        ['rev-parse', '--verify', `${ref}^{commit}`],
        { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      return ref;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`branch ref not found: ${branch}`);
}

function safeRemoveVerificationWorktree(worktreePath: string, worktreesRoot: string): void {
  const resolved = resolve(worktreePath);
  const root = resolve(worktreesRoot);
  const rel = relative(root, resolved);
  if (!safePathWithin(resolved, root) || !rel.startsWith('verify-')) {
    return;
  }
  rmSync(resolved, { recursive: true, force: true });
}

function createAsyncMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function resolveMultiPrVerifyParallelism(
  runCount: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (runCount <= 0) return 0;
  const raw = env['AGENTFORGE_MULTI_PR_VERIFY_PARALLELISM']?.trim()
    ?? env['AUTONOMOUS_MAX_AGENTS']?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(runCount, Math.max(1, parsed));
  }
  return Math.min(runCount, 3);
}

/**
 * Verify every completed agent branch recorded in execute.json by checking it
 * out into an isolated temporary git worktree and running the real project
 * verification commands. This prevents a multi-PR cycle from treating the base
 * checkout's green test run as proof that each agent PR branch is green.
 */
export async function verifyMultiPrAgentBranches(opts: {
  cwd: string;
  cycleId: string;
  baseBranch: string;
  testing: CycleConfig['testing'];
}): Promise<MultiPrBranchVerificationResult> {
  const runs = readMultiPrBranchRuns(opts.cwd, opts.cycleId);
  if (runs.length === 0) {
    const skipped = {
      passed: true,
      results: [],
      skipped: true,
      reason: 'no agent worktree branches recorded',
    };
    writeMultiPrBranchVerificationArtifact(opts.cwd, opts.cycleId, skipped);
    return skipped;
  }

  const commands = multiPrVerifyCommands(opts.testing);
  if (commands.length === 0) {
    const skipped = {
      passed: true,
      results: [],
      skipped: true,
      reason: 'no verification commands configured',
    };
    writeMultiPrBranchVerificationArtifact(opts.cwd, opts.cycleId, skipped);
    return skipped;
  }

  const worktreesRoot = resolve(opts.cwd, '.agentforge', 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });
  const timeoutMs = Math.max(5, opts.testing.timeoutMinutes) * 60_000;
  const results: MultiPrBranchVerificationEntry[] = new Array(runs.length);
  const parallelism = resolveMultiPrVerifyParallelism(runs.length);
  const withGitMutation = createAsyncMutex();

  const snapshot = (detail?: Record<string, unknown>) => {
    const orderedResults = results.filter(
      (result): result is MultiPrBranchVerificationEntry => result !== undefined,
    );
    writeMultiPrBranchVerificationArtifact(opts.cwd, opts.cycleId, {
      passed: orderedResults.length === runs.length && orderedResults.every((result) => result.status === 'passed'),
      results: orderedResults,
      parallelism,
      totalBranches: runs.length,
      commands,
      ...(detail ?? {}),
    });
  };

  const verifyRun = async (
    run: MultiPrBranchVerificationRun,
    index: number,
  ): Promise<void> => {
    const startedAt = Date.now();
    const worktreePath = join(
      worktreesRoot,
      verificationWorktreeName(opts.cycleId, index, run.branch),
    );
    const baseEntry = {
      branch: run.branch,
      ...(run.agentId !== undefined ? { agentId: run.agentId } : {}),
      ...(run.itemId !== undefined ? { itemId: run.itemId } : {}),
    };
    const update = (entry: MultiPrBranchVerificationEntry, detail?: Record<string, unknown>) => {
      results[index] = entry;
      snapshot({
        activeBranch: run.branch,
        ...(detail ?? {}),
      });
    };

    try {
      update({
        ...baseEntry,
        status: 'running',
        currentStep: 'prepare-worktree',
        durationMs: Date.now() - startedAt,
      });
      safeRemoveVerificationWorktree(worktreePath, worktreesRoot);
      const ref = await withGitMutation(() => resolveBranchRef(opts.cwd, run.branch));
      update({
        ...baseEntry,
        status: 'running',
        currentStep: 'add-worktree',
        durationMs: Date.now() - startedAt,
      });
      await withGitMutation(() =>
        execFileAsync(
          'git',
          ['worktree', 'add', '--detach', worktreePath, ref],
          { cwd: opts.cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
        ),
      );

      for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
        const command = commands[commandIndex]!;
        try {
          update({
            ...baseEntry,
            status: 'running',
            currentStep: 'command',
            command,
            commandIndex,
            commandsCompleted: commandIndex,
            durationMs: Date.now() - startedAt,
          });
          await execCommandInDir(worktreePath, command, timeoutMs);
          update({
            ...baseEntry,
            status: 'running',
            currentStep: 'command-complete',
            command,
            commandIndex,
            commandsCompleted: commandIndex + 1,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
          update({
            ...baseEntry,
            status: 'failed',
            currentStep: 'command',
            command,
            commandIndex,
            commandsCompleted: commandIndex,
            durationMs: Date.now() - startedAt,
            stdout: (e.stdout?.toString() ?? '').slice(0, 10_000),
            stderr: (e.stderr?.toString() ?? '').slice(0, 10_000),
            error: extractSubprocessError(err),
          });
          return;
        }
      }

      update({
        ...baseEntry,
        status: 'passed',
        commandsCompleted: commands.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      update({
        ...baseEntry,
        status: 'failed',
        currentStep: 'prepare-worktree',
        durationMs: Date.now() - startedAt,
        error: extractSubprocessError(err),
      });
    } finally {
      const current = results[index];
      if (current?.status === 'running') {
        update({
          ...current,
          currentStep: 'cleanup-worktree',
          durationMs: Date.now() - startedAt,
        });
      }
      try {
        await withGitMutation(() =>
          execFileAsync(
            'git',
            ['worktree', 'remove', '--force', worktreePath],
            { cwd: opts.cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
          ),
        );
      } catch {
        safeRemoveVerificationWorktree(worktreePath, worktreesRoot);
        try {
          await withGitMutation(() =>
            execFileAsync(
              'git',
              ['worktree', 'prune'],
              { cwd: opts.cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
            ),
          );
        } catch {
          // Best-effort metadata cleanup only.
        }
      }
      const afterCleanup = results[index];
      if (afterCleanup) {
        update({
          ...afterCleanup,
          cleanupCompleted: true,
          durationMs: Date.now() - startedAt,
        }, { currentStep: 'cleanup-complete' });
      }
    }
  };

  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    results[index] = {
      branch: run.branch,
      ...(run.agentId !== undefined ? { agentId: run.agentId } : {}),
      ...(run.itemId !== undefined ? { itemId: run.itemId } : {}),
      status: 'pending',
      currentStep: 'queued',
      durationMs: 0,
    };
  }
  snapshot({ currentStep: 'queued' });

  let next = 0;
  const workers = Array.from({ length: parallelism }, async () => {
    while (next < runs.length) {
      const index = next;
      next++;
      await verifyRun(runs[index]!, index);
    }
  });
  await Promise.all(workers);

  const orderedResults = results.filter(
    (result): result is MultiPrBranchVerificationEntry => result !== undefined,
  );

  const finalResult = {
    passed: orderedResults.every((result) => result.status === 'passed'),
    results: orderedResults,
    parallelism,
  };
  writeMultiPrBranchVerificationArtifact(opts.cwd, opts.cycleId, finalResult);
  return finalResult;
}

/**
 * The CycleRunner is constructed once per autonomous cycle and immediately
 * generates a cycleId, instantiates the per-cycle CycleLogger, and primes the
 * KillSwitch. All wiring is dependency-injected so the orchestrator is fully
 * unit-testable with mocks.
 */
export class CycleRunner {
  private readonly cycleId: string;
  private readonly logger: CycleLogger;
  private readonly killSwitch: KillSwitch;
  private readonly startedAt: number;

  // State accumulated across stages so the catch handler can include partial
  // information in the terminal CycleResult written to cycle.json.
  private sprintVersion = '';
  private branch = '';
  private commitSha: string | null = null;
  private filesChanged: string[] = [];
  private prUrl: string | null = null;
  private prNumber: number | null = null;
  private prDraft = false;
  private totalCostUsd = 0;
  private testStats: CycleResult['tests'] = {
    passed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
    passRate: 0,
    newFailures: [],
  };
  private scoringFallback: 'static' | 'effort-estimator' | undefined;
  private gateVerdict: 'APPROVE' | 'REJECT' | undefined = undefined;
  /** Set in runStages() when prMode='multi'; used to drain at cycle end. */
  private mergeQueue: MergeQueue | null = null;
  /** Accumulated CostBreakdown from the execute phase (Wave 2). */
  private executionBreakdown: CostBreakdown | undefined = undefined;

  constructor(private readonly options: CycleRunnerOptions) {
    // Resolve cycleId in priority order:
    //   1. options.resumeCheckpoint.cycleId — resume path reuses the existing cycle dir
    //   2. options.cycleId — caller pre-allocated (CLI creates logger+gitOps first)
    //   3. AUTONOMOUS_CYCLE_ID env — server's POST /api/v5/cycles pre-allocates
    //      the id and pre-creates the dir, then spawns the CLI with this env var
    //      so the CLI writes to the same dir the API client already has a pointer to
    //   4. fresh UUID — direct CLI use with no coordination
    const envId = process.env['AUTONOMOUS_CYCLE_ID'];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    // Wave 3 T5+T6 — resumeCheckpoint takes priority for cycleId so durability
    // is end-to-end. Use match-then-use on the checkpoint id.
    const CKPT_ID_RE = /^[a-zA-Z0-9-]{8,64}$/;
    const resumeId = options.resumeCheckpoint?.cycleId;
    const safeResumeId = resumeId && CKPT_ID_RE.test(resumeId) ? resumeId : undefined;
    this.cycleId = safeResumeId
      ?? ((options.cycleId && UUID_RE.test(options.cycleId))
        ? options.cycleId
        : (envId && UUID_RE.test(envId) ? envId : randomUUID()));
    this.startedAt = Date.now();
    // Seed accumulated spend from checkpoint so budget gates account for prior spend.
    if (options.resumeCheckpoint) {
      this.totalCostUsd = options.resumeCheckpoint.spentUsd;
    }
    this.logger = new CycleLogger(options.cwd, this.cycleId);
    this.killSwitch = new KillSwitch(
      options.config,
      this.cycleId,
      this.startedAt,
      options.cwd,
    );
  }

  /**
   * Run the cycle to completion. Always returns a `CycleResult`; never throws.
   * Always writes the terminal cycle.json before returning.
   */
  async start(): Promise<CycleResult> {
    // === wave5:T5 === Unattended pre-flight guard.
    // Must run before any phase starts (heartbeat, stages, etc.).
    if (process.env['AGENTFORGE_UNATTENDED'] === '1') {
      await assertUnattendedSafe(
        this.options.cwd,
        this.options.config.budget.perCycleUsd,
        this.totalCostUsd,
      );
    }
    // === end wave5:T5 ===

    // === safeguard #1 === Cross-cycle loop guard — prevents the multi-day spin.
    // If the previous N cycles all failed to complete, HALT before starting
    // another one. State persists in .agentforge/loop-state.json and is updated
    // at the end of every cycle below. Override the threshold with
    // AGENTFORGE_MAX_FAILED_CYCLES (default 3). Throws LoopHaltedError so an
    // external repeat-invoker sees a non-zero exit and stops re-spinning.
    {
      const envMax = Number(process.env['AGENTFORGE_MAX_FAILED_CYCLES']);
      assertLoopNotHalted(this.options.cwd, {
        maxConsecutiveFailedCycles:
          Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : 3,
      });
    }
    // === end safeguard #1 ===

    let final: CycleResult;
    // Heartbeat: every 30s, stamp lastHeartbeatAt on cycle.json so dashboards
    // can detect runners that died at the OS level (SIGKILL/OOM/terminal-close)
    // where the try/catch below never gets a chance to flush a terminal stage.
    // See memory/feedback_cycle_heartbeat_required.md for the post-mortem.
    this.logger.flushHeartbeat();
    const heartbeatTimer = setInterval(() => {
      this.logger.flushHeartbeat();
    }, 30_000);
    // Don't keep the event loop alive just for the heartbeat.
    heartbeatTimer.unref?.();
    try {
      final = await this.runStages();
    } catch (err) {
      if (err instanceof CycleKilledError) {
        this.logger.logKillSwitch(err.trip);
        final = this.buildResult(CycleStage.KILLED, { killSwitch: err.trip });
      } else if (err instanceof GateRejectedError) {
        // Gate phase explicitly rejected the sprint — record the verdict so
        // the cycle-outcome memory entry surfaces it for the next audit phase.
        this.gateVerdict = 'REJECT';
        final = this.buildResult(CycleStage.FAILED, {
          error: `gate: ${err.rationale}`,
          gateVerdict: 'REJECT',
        });
      } else if (err instanceof PhaseFailedError) {
        // PhaseFailedError from the PhaseScheduler is a hard failure but is
        // distinct from a kill-switch trip. We surface it as FAILED so the
        // operator can investigate without conflating it with a safety stop.
        final = this.buildResult(CycleStage.FAILED, {
          error: `${err.phase}: ${err.reason}`,
        });
      } else {
        final = this.buildResult(CycleStage.FAILED, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Stop the heartbeat before the terminal write so the two writers don't
    // race on cycle.json (last-writer-wins on the file would otherwise wipe
    // the terminal stage with a heartbeat-only payload).
    clearInterval(heartbeatTimer);
    this.mergeQueue?.stop();

    // ALWAYS write cycle.json — that's the contract this module guarantees to
    // every operator and downstream tool that watches .agentforge/cycles/.
    try {
      this.logger.logCycleResult(final);
    } catch {
      // Best-effort: if cycle.json cannot be written we still return the
      // result. The operator will see the missing file and know something
      // catastrophic happened to the logger itself.
    }

    // === safeguard #1 === Record this cycle's outcome for the cross-cycle guard
    // so the next start() can HALT if the loop is failing repeatedly.
    try {
      persistCycleOutcome(this.options.cwd, {
        cycleId: this.cycleId,
        completed: final.stage === CycleStage.COMPLETED,
      });
    } catch {
      // Guard bookkeeping must never fail or alter a cycle's own result.
    }
    // === end safeguard #1 ===

    if (this.shouldRunAutoReforgeAfterTerminalResult(final)) {
      await this.runAutoReforgeStep();
    }
    return final;
  }

  /**
   * Internal driver. Runs all six stages in sequence and returns the final
   * COMPLETED result. Throws CycleKilledError or other errors which `start()`
   * translates into the appropriate terminal stage.
   */
  private async runStages(): Promise<CycleResult> {
    const effectiveWorktreePool = this.getEffectiveWorktreePool();

    if (this.options.config.prMode === 'multi') {
      if (this.options.disableWorktrees) {
        throw new Error(
          'prMode=multi requires isolated worktrees. Remove disableWorktrees or use prMode=single.',
        );
      }
      if (!effectiveWorktreePool) {
        throw new Error(
          'prMode=multi requires options.worktreePool so execute items cannot modify the parent working tree.',
        );
      }
      if (!this.options.messageBus) {
        throw new Error(
          'prMode=multi requires options.messageBus so agent branches can be pushed and opened as PRs.',
        );
      }
    } else if (effectiveWorktreePool) {
      throw new Error(
        'options.worktreePool currently requires prMode=multi. Use disableWorktrees for single-PR cycles until merge-back is implemented.',
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // T6 — RESUME: if a checkpoint was provided, emit an audit entry
    // and log the resume event before anything else runs.
    // ─────────────────────────────────────────────────────────────────
    if (this.options.resumeCheckpoint) {
      const cp = this.options.resumeCheckpoint;
      this.logger.appendEvent({
        type: 'cycle.resumed',
        cycleId: this.cycleId,
        fromPhase: cp.resumeFromPhase,
        byUser: process.env['USER'] ?? 'cli',
        at: new Date().toISOString(),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] resuming cycleId=${this.cycleId} fromPhase=${cp.resumeFromPhase} spentUsd=${cp.spentUsd}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────
    // T4.6 — WORKTREE GC (START): clean up stale worktrees from prior
    // cycles before we begin so disk usage doesn't accumulate unbounded.
    // Errors are swallowed — a GC failure must never block a new cycle.
    // ─────────────────────────────────────────────────────────────────
    await this.runWorktreeGc('start');

    // ─────────────────────────────────────────────────────────────────
    // MULTI-PR MODE SETUP
    // When prMode='multi', start the MergeQueue now so it subscribes to
    // agent.branch.pushed events emitted by coder-class agents during
    // STAGE 3 (RUN). The queue opens one draft PR per agent branch in
    // real-time, recording each in the cycle ledger at
    // .agentforge/cycles/<cycleId>/agent-prs.json.
    //
    // The baseBranch is the cycle's git.baseBranch (typically 'main' or the
    // autonomous cycle branch set by GitOps). We read it from config here
    // because the autonomous branch itself is not yet created (STAGE 5).
    // ─────────────────────────────────────────────────────────────────
    if (this.options.config.prMode === 'multi') {
      if (!this.options.messageBus) {
        // eslint-disable-next-line no-console
        console.warn(
          '[autonomous:cycle] multi-pr: prMode=multi requires options.messageBus to be set. ' +
          'Falling back to single-PR behavior.',
        );
      } else {
        this.mergeQueue = new MergeQueue({
          projectRoot: this.options.cwd,
          bus: this.options.messageBus,
          parentBranch: this.options.config.git.baseBranch,
          cycleId: this.cycleId,
          dryRun: this.options.dryRun?.prOpener === true,
        });
        this.mergeQueue.start();
        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] multi-pr: MergeQueue started (base=${this.options.config.git.baseBranch})`);
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 1 — PLAN
    // Build a backlog from project signals, score it, and gate on budget.
    // ─────────────────────────────────────────────────────────────────
    const bridge = new ProposalToBacklog(
      this.options.proposalAdapter,
      this.options.cwd,
      this.options.config,
    );
    const backlog = await bridge.build();

    if (backlog.length === 0) {
      throw new Error('No backlog items to work on — nothing to do');
    }

    const scoring = new ScoringPipeline(
      this.options.runtime,
      this.options.scoringAdapter,
      this.options.config,
      this.logger,
      this.options.cwd,
    );
    const scored: ScoringPipelineResult = await scoring.scoreWithFallback(
      backlog,
    );
    this.scoringFallback = scored.fallback;
    this.checkKillSwitch();

    // BUDGET APPROVAL GATE
    // If everything fits within budget, this short-circuits with auto-approval.
    // Otherwise it blocks on TTY prompt or approval-decision.json file.
    const approval = new BudgetApproval(
      this.options.cwd,
      this.cycleId,
      this.logger,
    );
    const approved = await approval.collect({
      withinBudget: scored.withinBudget,
      requiresApproval: scored.requiresApproval,
      budgetUsd: this.options.config.budget.perCycleUsd,
      summary: scored.summary,
    });

    // ─────────────────────────────────────────────────────────────────
    // STAGE 2 — STAGE
    // Convert the approved ranked items into a SprintPlan and write
    // cycles/{cycleId}/plan.json — single source of truth (Track D migration).
    // ─────────────────────────────────────────────────────────────────
    const generator = new SprintGenerator(this.options.cwd, this.options.config);
    const plan: SprintPlan = await generator.generate(approved.approvedItems, this.cycleId);
    this.sprintVersion = plan.version;
    // Log sprint assignment in events.jsonl so the dashboard can resolve the
    // sprint version without timestamp matching.
    this.logger.logSprintAssigned(plan.version);
    this.persistPreAuditCheckpoint();
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3 — RUN (with auto-retry on gate rejection)
    // Drive the 9-phase sprint sequence (audit → … → learn) via
    // PhaseScheduler. If the gate rejects, extract the findings and
    // retry from execute→test→review→gate up to maxAutoRetries times.
    // After requireApprovalAfter retries, block on human approval.
    // ─────────────────────────────────────────────────────────────────
    const retryConfig = this.options.config.retry;
    let retryAttempt = 0;
    let gateRetry: GateRetryContext | undefined;
    let runSummary!: SprintRunSummary;
    let branchVerificationCompletedInRetryLoop = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // T4.2: resolve the worktree pool for the phase context.
      // worktreePool is undefined when disableWorktrees is set OR when the
      // caller provided neither a pool nor we can auto-construct one (AA not
      // yet landed). The execute phase falls back to single-tree behavior when
      // worktreePool is absent.
      const phaseWorktreePool = this.getEffectiveWorktreePool();

      // T6: on first attempt, honour the resume checkpoint's phase (if any).
      // On retry attempts, always jump to 'execute' (existing retry logic).
      const skipToPhase: PhaseName | undefined = retryAttempt > 0
        ? 'execute'
        : (this.options.resumeCheckpoint?.resumeFromPhase as PhaseName | undefined);

      const scheduler = new PhaseScheduler(
        {
          sprintId: plan.sprintId,
          sprintVersion: plan.version,
          projectRoot: this.options.cwd,
          adapter: this.options.scoringAdapter,
          bus: this.options.bus,
          runtime: this.options.runtime,
          cycleId: this.cycleId,
          baseBranch: this.options.config.git.baseBranch,
          ...(this.options.objective ? { objective: this.options.objective } : {}),
          ...(retryAttempt > 0 ? { retryAttempt, skipToPhase: 'execute' as PhaseName } : {}),
          ...(gateRetry !== undefined ? { gateRetry } : {}),
          ...(retryAttempt === 0 && skipToPhase !== undefined ? { skipToPhase } : {}),
          // T4.2: pass the pool (or undefined) through so the execute phase
          // can allocate per-item worktrees when coder-class items are dispatched.
          ...(phaseWorktreePool !== undefined ? { worktreePool: phaseWorktreePool } : {}),
          // Wave 3 T5: forward checkpoint resume only on the FIRST attempt;
          // gate-retries (retryAttempt > 0) re-run from 'execute' explicitly.
          ...(retryAttempt === 0 && this.options.resumeCheckpoint
            ? { resumeCheckpoint: this.options.resumeCheckpoint }
            : {}),
          budgetUsd: this.options.config.budget.perCycleUsd,
        },
        this.killSwitch,
        this.logger,
        this.options.phaseHandlers,
      );

      try {
        runSummary = await scheduler.run();
        this.totalCostUsd += runSummary.totalCostUsd;
        // Gate approved — break out of retry loop
        this.gateVerdict = 'APPROVE';
        // Reconcile sprint file: mark all executed items as completed
        // based on execute.json (fixes stale in_progress after retries)
        this.reconcileSprintStatus(plan.version);
        // Wave 2: load the per-item/phase CostBreakdown from execute.json.
        this.loadExecutionBreakdownFromDisk();
        await this.verifyMultiPrBranches();
        branchVerificationCompletedInRetryLoop = true;
        break;
      } catch (err) {
        if (!(err instanceof GateRejectedError)) throw err;

        // Capture the failed attempt's cost before retrying — the scheduler
        // tracked phase costs even though the gate threw. Sum them from the
        // phase files on disk since the scheduler's internal state is lost.
        this.totalCostUsd += this.sumPhaseCostsFromDisk();
        // Flush accumulated cost so operators see live spend even when the
        // gate rejects and we loop back for another attempt.
        this.logger.flushCycleCost(this.totalCostUsd);

        retryAttempt++;
        gateRetry = buildGateRetryContext(
          this.options.cwd,
          this.cycleId,
          retryAttempt,
          err.rationale,
        );
        this.logger.logPhaseFailure('gate', `retry ${retryAttempt}/${retryConfig.maxAutoRetries}: ${err.rationale.slice(0, 500)}`);

        // Check if we've exhausted auto-retries
        if (retryAttempt > retryConfig.maxAutoRetries) {
          throw err; // Propagate to start() → FAILED
        }

        // Check if we need human approval to continue retrying
        if (retryAttempt > retryConfig.requireApprovalAfter) {
          const retryApproval = new BudgetApproval(
            this.options.cwd,
            this.cycleId,
            this.logger,
          );
          await retryApproval.collect({
            withinBudget: [],
            requiresApproval: [],
            budgetUsd: this.options.config.budget.perCycleUsd,
            summary: `Gate retry ${retryAttempt}: ${err.rationale.slice(0, 200)}`,
          });
        }

        // Inject gate findings into memory so the next execute pass sees them
        this.logger.logPhaseFailure('gate', `findings for retry: ${err.rationale.slice(0, 1000)}`);

        // Check budget/duration kill switch before retrying
        this.checkKillSwitch();

        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] gate rejected (attempt ${retryAttempt}/${retryConfig.maxAutoRetries}) — retrying from execute phase`);
      }
    }

    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.25 — AUTO-REFORGE
    // After gate approval, run the learning-curator + mutator so agents
    // absorb the lessons from this cycle before it is marked COMPLETED.
    // Errors are swallowed — a reforge failure must never kill a passed
    // cycle. Honoured by config.autoReforge (default true).
    // ─────────────────────────────────────────────────────────────────
    await this.runAutoReforgeStep();
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.3 — TELEMETRY EXPORT (T5.7)
    // Optionally export anonymized cycle telemetry after learnings are
    // applied. Honour the opt-in config; errors are swallowed.
    // ─────────────────────────────────────────────────────────────────
    await this.runTelemetryExport();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 3.5 — TYPECHECK (fail-fast pre-verify)
    // Run pnpm build + tsc --noEmit before the full test suite. TypeScript
    // compilation errors introduced during execute are caught here rather
    // than surviving to the gate phase, where each rejection costs $15-30
    // in agent spend. The step no-ops when the corresponding command string
    // is empty or the quality flag is false.
    // ─────────────────────────────────────────────────────────────────
    await this.runPreVerifyTypeCheck();
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 4 — VERIFY
    // Run the project's real test command, derive a TestResult, then check
    // the kill switch's post-verify gate (test floor + regression policy).
    // ─────────────────────────────────────────────────────────────────
    this.logger.flushCycleStatus({
      stage: CycleStage.VERIFY,
      status: 'running',
      currentStep: 'verify',
      detail: 'running project test command',
    });
    this.options.bus.publish('sprint.phase.verify.step', {
      cycleId: this.cycleId,
      step: 'tests-started',
      detail: this.options.config.testing.command,
    });
    const testResult = await this.options.testRunner.run(this.cycleId);
    this.logger.logTestRun(testResult);
    this.logger.flushCycleStatus({
      stage: CycleStage.VERIFY,
      status: 'tests-complete',
      currentStep: 'verify',
      extra: {
        tests: {
          passed: testResult.passed,
          failed: testResult.failed,
          skipped: testResult.skipped,
          total: testResult.total,
          passRate: testResult.passRate,
        },
      },
    });
    this.options.bus.publish('sprint.phase.verify.step', {
      cycleId: this.cycleId,
      step: 'tests-complete',
      passed: testResult.passed,
      failed: testResult.failed,
      total: testResult.total,
      passRate: testResult.passRate,
    });
    this.testStats = {
      passed: testResult.passed,
      failed: testResult.failed,
      skipped: testResult.skipped,
      total: testResult.total,
      passRate: testResult.passRate,
      newFailures: testResult.newFailures,
    };
    this.augmentLessonAttributionsWithVerifyResult(testResult);

    const regression = {
      detected: testResult.newFailures.length > 0,
      reason:
        testResult.newFailures.length > 0
          ? `${testResult.newFailures.length} new failures: ${testResult.newFailures
              .slice(0, 3)
              .join(', ')}`
          : '',
    };
    const verifyTrip = this.killSwitch.checkPostVerify(testResult, regression);
    if (verifyTrip) {
      throw new CycleKilledError(verifyTrip);
    }
    if (this.options.config.prMode === 'multi' && !branchVerificationCompletedInRetryLoop) {
      this.logger.flushCycleStatus({
        stage: CycleStage.VERIFY,
        status: 'running',
        currentStep: 'branch-verify',
        detail: 'verifying agent PR branches',
      });
      this.options.bus.publish('sprint.phase.verify.step', {
        cycleId: this.cycleId,
        step: 'branch-verify-started',
      });
    }
    if (!branchVerificationCompletedInRetryLoop) {
      await this.verifyMultiPrBranches();
    }
    this.checkKillSwitch();

    // ─────────────────────────────────────────────────────────────────
    // STAGE 5 — COMMIT
    // Verify git/gh preconditions, create the autonomous feature branch,
    // stage the changed files, commit (with secret scan), and push.
    // ─────────────────────────────────────────────────────────────────
    const filesToCommit = await this.collectChangedFiles(runSummary);
    this.filesChanged = filesToCommit;

    if (this.options.config.prMode === 'multi') {
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'skipped',
        detail: 'multi-PR mode uses agent branches directly — skipping aggregate commit',
      });
    } else if (shouldRunAggregateCommit(this.options.config.prMode, filesToCommit)) {
      await this.options.gitOps.verifyPreconditions();
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'preconditions',
        detail: 'git/gh preconditions verified',
      });

      this.branch = await this.options.gitOps.createBranch(plan.version);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'branch-created',
        detail: this.branch,
      });

      await this.options.gitOps.stage(filesToCommit);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'staged',
        detail: `${filesToCommit.length} file(s) staged`,
      });

      // v15.0.0: guard commit + push behind filesToCommit.length > 0. Cycle
      // b555cca4 crashed at this exact point: all 5 items produced text-only
      // analysis (no file edits), git commit -F - exited code 1 because
      // nothing was staged. Now we treat "no work product" as a clean
      // no-op rather than a fatal error.
      const message = this.buildCommitMessage(plan.version, scored.summary);
      this.commitSha = await this.options.gitOps.commit(message);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'committed',
        detail: this.commitSha ?? '',
      });

      await this.options.gitOps.push(this.branch);
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'pushed',
        detail: this.branch,
      });
    } else {
      this.options.bus.publish('sprint.phase.commit.step', {
        cycleId: this.cycleId,
        step: 'skipped',
        detail: 'no file changes produced by execute phase — skipping branch, commit, push, and PR',
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // STAGE 6 — REVIEW
    // Two modes:
    //
    //   single (default): render PR body, open one squash-PR for the entire
    //   autonomous branch via PROpener. This is the legacy path and remains
    //   fully intact for backward compatibility.
    //
    //   multi: skip the single squash-PR entirely. Agent PRs were already
    //   opened in real-time by MergeQueue during STAGE 3 (RUN). Drain the
    //   queue here to await any in-flight handlers, log a per-PR summary
    //   from the ledger, and optionally call drainAndMerge() when
    //   autoMergePRs=true.
    // ─────────────────────────────────────────────────────────────────
    if (this.options.config.prMode === 'multi') {
      // ── multi-PR path ──────────────────────────────────────────────
      await this.runMultiPrDrain(plan.version, scored.summary);
    } else {
      // ── single-PR path (default) ────────────────────────────────────
      if (shouldOpenSingleCyclePr(filesToCommit, this.commitSha)) {
        const intermediate = this.buildResult(CycleStage.REVIEW, {
          sprintVersion: plan.version,
          cost: {
            totalUsd: this.totalCostUsd,
            budgetUsd: this.options.config.budget.perCycleUsd,
            byAgent: {},
            byPhase: {},
          },
          tests: this.testStats,
          git: {
            branch: this.branch,
            commitSha: this.commitSha,
            filesChanged: filesToCommit,
          },
        });

        const prBody = renderPrBody({
          sprint: {
            version: plan.version,
            items: plan.items.map((i) => ({
              id: i.id,
              priority: i.priority,
              title: i.title,
              assignee: i.assignee,
            })),
          },
          result: intermediate,
          testResult,
          scoringResult: {
            rankings: [...scored.withinBudget, ...scored.requiresApproval],
            totalEstimatedCostUsd: scored.totalEstimatedCostUsd,
            budgetOverflowUsd: scored.budgetOverflowUsd,
            summary: scored.summary,
            warnings: scored.warnings,
          },
        });

        // Build the PROpener request — only include `reviewers` if we have one,
        // and only include `dryRun` if it's truthy. `exactOptionalPropertyTypes`
        // forbids `undefined` for optional fields, so use conditional spreads.
        const prRequest = {
          branch: this.branch,
          baseBranch: this.options.config.git.baseBranch,
          title: sanitizePrTitle(plan.version, scored.summary),
          body: prBody,
          draft: this.options.config.pr.draft,
          labels: this.options.config.pr.labels,
          ...(this.options.config.pr.assignReviewer
            ? { reviewers: [this.options.config.pr.assignReviewer] }
            : {}),
          ...(this.options.dryRun?.prOpener ? { dryRun: true } : {}),
        };
        const prResult = await this.options.prOpener.open(prRequest);

        this.prUrl = prResult.url;
        this.prNumber = prResult.number;
        this.prDraft = prResult.draft;

        this.logger.logPREvent({
          type: 'opened',
          url: prResult.url,
          number: prResult.number,
          title: `autonomous(v${plan.version})`,
        });
      } else {
        this.options.bus.publish('sprint.phase.review.step', {
          cycleId: this.cycleId,
          step: 'skipped',
          detail: 'no commit was produced — skipping single-PR open',
        });
      }
    }

    // ─────────────────────────────────────────────────────────────────
    // T4.6 — WORKTREE GC (END): clean up this cycle's worktrees, keeping
    // the last 20 for forensics. Errors are swallowed — same policy as
    // the start-of-cycle GC pass.
    // ─────────────────────────────────────────────────────────────────
    await this.runWorktreeGc('end');

    // ─────────────────────────────────────────────────────────────────
    // COMPLETED
    // ─────────────────────────────────────────────────────────────────
    // `scoringFallback` is only added when defined to satisfy
    // `exactOptionalPropertyTypes`.
    const completedOverrides: Partial<CycleResult> = {
      sprintVersion: plan.version,
      cost: {
        totalUsd: this.totalCostUsd,
        budgetUsd: this.options.config.budget.perCycleUsd,
        byAgent: {},
        byPhase: {},
      },
      tests: this.testStats,
      git: {
        branch: this.branch,
        commitSha: this.commitSha,
        filesChanged: filesToCommit,
      },
      pr: {
        url: this.prUrl,
        number: this.prNumber,
        draft: this.prDraft,
      },
    };
    if (this.scoringFallback) {
      completedOverrides.scoringFallback = this.scoringFallback;
    }
    return this.buildResult(CycleStage.COMPLETED, completedOverrides);
  }

  /**
   * Between-stage kill switch check. Used at the boundaries between PLAN
   * substages and STAGE/RUN. The PhaseScheduler does its own per-phase check
   * during STAGE 3 — this only covers the gaps the scheduler doesn't see.
   */
  private checkKillSwitch(): void {
    const trip = this.killSwitch.checkBetweenPhases({
      cumulativeCostUsd: this.totalCostUsd,
      consecutiveFailures: 0,
    });
    if (trip) throw new CycleKilledError(trip);
  }

  /**
   * Phase-0.5: after VERIFY, append augmented lesson-attribution rows for this
   * cycle with the deterministic verifyPassed (failed===0). Dedup (latest wins)
   * is handled by aggregateLessonOutcomes. Non-fatal — never blocks the cycle.
   */
  private augmentLessonAttributionsWithVerifyResult(testResult: TestResult): void {
    try {
      const verifyPassed = testResult.failed === 0;
      const rows = readLessonAttributions(this.options.cwd).filter(
        (r) => r.cycleId === this.cycleId,
      );
      if (rows.length === 0) return;
      appendLessonAttributions(
        this.options.cwd,
        rows.map((r) => ({
          cycleId: r.cycleId,
          itemId: r.itemId,
          agentId: r.agentId,
          lessonId: r.lessonId,
          lessonText: r.lessonText,
          scope: 'cycle' as const,
          // Preserve gateVerdict so aggregateLessonOutcomes can index this row
          // (it skips rows without gateVerdict). exactOptionalPropertyTypes:
          // conditional-spread to never assign `undefined`.
          ...(r.gateVerdict !== undefined ? { gateVerdict: r.gateVerdict } : {}),
          verifyPassed,
        })),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[autonomous:cycle] verifyPassed augmentation failed (non-fatal):', err);
    }
  }

  /**
   * Persist a resume point after planning but before the PhaseScheduler starts.
   * Without this, an interrupted cycle can be stranded after plan.json exists
   * but before the first phase-level checkpoint is written.
   */
  private persistPreAuditCheckpoint(): void {
    try {
      writeCheckpoint(join(this.options.cwd, '.agentforge', 'cycles', this.cycleId), {
        v: 1,
        cycleId: this.cycleId,
        capturedAt: new Date().toISOString(),
        resumeFromPhase: 'audit',
        completedPhases: [],
        budgetUsd: this.options.config.budget.perCycleUsd,
        spentUsd: this.totalCostUsd,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[autonomous:cycle] pre-audit checkpoint write failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Dispatch the pre-verify typecheck step (STAGE 3.5). Uses the injected
   * `preVerifyTypeCheck` when provided; falls back to running the real build
   * and typecheck commands via execFileAsync. Trips the kill switch and throws
   * CycleKilledError on failure (subject to the quality flags).
   */
  private async runPreVerifyTypeCheck(): Promise<void> {
    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] stage 3.5: running pre-verify typecheck');
    const result = this.options.preVerifyTypeCheck
      ? await this.options.preVerifyTypeCheck(this.options.cwd, this.options.config.testing)
      : await runPreVerifyTypeCheck(this.options.cwd, this.options.config.testing, this.logger);

    if (!result.buildOk) {
      // eslint-disable-next-line no-console
      console.error(`[autonomous:cycle] build failed: ${(result.buildError ?? '').slice(0, 200)}`);
      this.logger.logPhaseFailure('typecheck', `build failed: ${result.buildError ?? 'unknown'}`);
    }
    const buildTrip = this.killSwitch.checkBuildResult({
      success: result.buildOk,
      ...(result.buildError !== undefined ? { error: result.buildError } : {}),
    });
    if (buildTrip) throw new CycleKilledError(buildTrip);

    if (!result.typeCheckOk) {
      // eslint-disable-next-line no-console
      console.error(`[autonomous:cycle] typecheck failed: ${(result.typeCheckError ?? '').slice(0, 200)}`);
      this.logger.logPhaseFailure('typecheck', `tsc failed: ${result.typeCheckError ?? 'unknown'}`);
    }
    const typeCheckTrip = this.killSwitch.checkTypeCheckResult({
      success: result.typeCheckOk,
      ...(result.typeCheckError !== undefined ? { error: result.typeCheckError } : {}),
    });
    if (typeCheckTrip) throw new CycleKilledError(typeCheckTrip);
  }

  private async verifyMultiPrBranches(): Promise<void> {
    if (this.options.config.prMode !== 'multi') return;

    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] multi-pr: verifying agent branches');
    this.logger.flushCycleStatus({
      stage: CycleStage.VERIFY,
      status: 'running',
      currentStep: 'branch-verify',
      detail: 'multi-PR branch verification started',
    });
    const verifier = this.options.multiPrBranchVerifier ?? verifyMultiPrAgentBranches;
    const result = await verifier({
      cwd: this.options.cwd,
      cycleId: this.cycleId,
      baseBranch: this.options.config.git.baseBranch,
      testing: this.options.config.testing,
    });
    writeMultiPrBranchVerificationArtifact(this.options.cwd, this.cycleId, result);

    this.logger.appendEvent({
      type: 'multi-pr.branch-verification',
      passed: result.passed,
      branches: result.results.length,
      skipped: result.skipped === true,
      at: new Date().toISOString(),
    });
    this.logger.flushCycleStatus({
      stage: CycleStage.VERIFY,
      status: result.passed ? 'branch-verify-passed' : 'branch-verify-failed',
      currentStep: 'branch-verify',
      extra: {
        branchVerification: {
          passed: result.passed,
          branches: result.results.length,
          skipped: result.skipped === true,
          reason: result.reason ?? null,
        },
      },
    });
    this.options.bus.publish('sprint.phase.verify.step', {
      cycleId: this.cycleId,
      step: 'branch-verify-complete',
      passed: result.passed,
      branches: result.results.length,
      skipped: result.skipped === true,
    });

    if (result.passed) return;

    throw new GateRejectedError(formatMultiPrBranchVerificationFailure(result));
  }

  /**
   * Run the auto-reforge step (STAGE 3.25). Extracts the unique agent IDs
   * that ran in this cycle from phases/execute.json, then calls
   * runAutoReforge so those agents absorb the cycle's learnings.
   *
   * Honoured by `config.autoReforge` (default true when the field is absent).
   * Any error is caught and logged — a reforge failure MUST NOT kill a cycle.
   */
  private async runAutoReforgeStep(): Promise<void> {
    // Default true: existing configs without the field still trigger reforge.
    const shouldReforge = this.options.config.autoReforge !== false;
    if (!shouldReforge) {
      // eslint-disable-next-line no-console
      console.log('[autonomous:cycle] stage 3.25: auto-reforge skipped (autoReforge=false)');
      return;
    }

    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] stage 3.25: running auto-reforge');
    try {
      const involvedAgentIds = extractInvolvedAgentIds(this.options.cwd, this.cycleId);
      const result = await runAutoReforge({
        projectRoot: this.options.cwd,
        cycleId: this.cycleId,
        involvedAgentIds,
        bus: this.options.bus,
      });
      if (result.skipped) {
        // eslint-disable-next-line no-console
        console.log('[autonomous:cycle] stage 3.25: auto-reforge skipped (no proposed learnings)');
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[autonomous:cycle] stage 3.25: auto-reforge complete in ${result.durationMs}ms` +
          ` (applied=${result.mutatorReport?.totalApplied ?? 0})`,
        );
      }
    } catch (err) {
      // Swallow — reforge errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] stage 3.25: auto-reforge error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private shouldRunAutoReforgeAfterTerminalResult(result: CycleResult): boolean {
    if (result.stage !== CycleStage.FAILED) return false;
    return this.hasExecutePhaseArtifact();
  }

  private hasExecutePhaseArtifact(): boolean {
    return existsSync(join(
      this.options.cwd,
      '.agentforge/cycles',
      this.cycleId,
      'phases',
      'execute.json',
    ));
  }

  /**
   * T5.7 — Optionally export anonymized cycle telemetry.
   * Reads telemetry config from environment / .agentforge/telemetry.yaml.
   * Errors are swallowed — telemetry failures must NEVER kill a cycle.
   */
  private async runTelemetryExport(): Promise<void> {
    try {
      const telConfig = resolveTelemetryConfig(this.options.cwd);
      if (!telConfig.enabled) return;

      // eslint-disable-next-line no-console
      console.log('[autonomous:cycle] stage 3.3: exporting cycle telemetry');
      const result = await exportCycleTelemetry({
        projectRoot: this.options.cwd,
        cycleId: this.cycleId,
        enabled: true,
        ...(telConfig.endpoint !== undefined ? { endpoint: telConfig.endpoint } : {}),
      });
      if (result.exported) {
        // eslint-disable-next-line no-console
        console.log(`[autonomous:cycle] stage 3.3: telemetry saved to ${result.localPath}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[autonomous:cycle] stage 3.3: telemetry not exported — ${result.reason}`);
      }
    } catch (err) {
      // Swallow — telemetry errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] stage 3.3: telemetry export error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Collect the file paths that the cycle modified during the RUN stage.
   *
   * v6.4.1: queries `git status --porcelain` for all working-tree changes
   * (modified, added, untracked). Filters out `.agentforge/cycles/**` because
   * those are the cycle's own log files, not "work product" to be committed.
   *
   * Limitation: this approach assumes the working tree was clean at cycle
   * start. If the user has other uncommitted changes when the cycle runs,
   * those will also be captured. A future improvement is to track per-agent
   * file writes via runtime hooks so we don't depend on the git working tree.
   */
  /**
   * Sum phase costs from disk — used when the scheduler throws (gate rejection)
   * and we need to capture the failed attempt's costs before retrying.
   */
  /**
   * After the retry loop, reconcile the sprint file so all items that the
   * execute phase completed are marked 'completed' — not left as 'in_progress'
   * due to stale writes from parallel execution or retry re-reads.
   */
  private reconcileSprintStatus(_sprintVersion: string): void {
    // plan.json lives inside the cycle directory — reconcile directly there.
    const cycleDir = join(this.options.cwd, '.agentforge/cycles', this.cycleId);
    const execPath = join(cycleDir, 'phases/execute.json');
    const planPath = join(cycleDir, 'plan.json');
    if (!existsSync(execPath) || !existsSync(planPath)) return;

    try {
      const execData = JSON.parse(readFileSync(execPath, 'utf8'));
      const planData = JSON.parse(readFileSync(planPath, 'utf8'));
      const runs: Array<{ itemId: string; status: string }> = execData.agentRuns ?? [];
      const completedIds = new Set(runs.filter(r => r.status === 'completed').map(r => r.itemId));

      // plan.json is a flat SprintPlan (no sprints[] wrapper)
      for (const item of planData.items ?? []) {
        if (completedIds.has(item.id) && item.status !== 'completed') {
          item.status = 'completed';
        }
      }
      writeFileSync(planPath, JSON.stringify(planData, null, 2));
    } catch { /* non-fatal — dashboard will show stale data but cycle continues */ }
  }

  private sumPhaseCostsFromDisk(): number {
    const phasesDir = join(this.options.cwd, '.agentforge/cycles', this.cycleId, 'phases');
    let total = 0;
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review', 'gate']) {
      const f = join(phasesDir, `${name}.json`);
      if (existsSync(f)) {
        try {
          const d = JSON.parse(readFileSync(f, 'utf8'));
          total += Number(d.costUsd ?? 0);
        } catch { /* skip corrupt files */ }
      }
    }
    return total;
  }

  /**
   * Wave 2 — Read the accumulated CostBreakdown from execute.json and set
   * `this.executionBreakdown`. Called after STAGE 3 (RUN) completes so the
   * breakdown is available for `buildResult()`.
   *
   * Reads `phases/execute.json` and accumulates the per-item `breakdown`
   * objects via `mergeBreakdowns`. If the file is absent or malformed the
   * field stays undefined — never throws.
   */
  private loadExecutionBreakdownFromDisk(): void {
    const execPath = join(
      this.options.cwd, '.agentforge/cycles', this.cycleId, 'phases/execute.json',
    );
    if (!existsSync(execPath)) return;
    try {
      const data = JSON.parse(readFileSync(execPath, 'utf8'));
      // Prefer the phase-level breakdown if it was pre-computed.
      if (data.breakdown && typeof data.breakdown === 'object') {
        this.executionBreakdown = data.breakdown as CostBreakdown;
        return;
      }
      // Otherwise accumulate from per-item breakdowns.
      const runs: Array<Record<string, unknown>> = data.agentRuns ?? data.itemResults ?? [];
      let acc: CostBreakdown | undefined;
      for (const run of runs) {
        if (run.breakdown && typeof run.breakdown === 'object') {
          acc = acc === undefined
            ? (run.breakdown as CostBreakdown)
            : mergeBreakdowns(acc, run.breakdown as CostBreakdown);
        }
      }
      if (acc !== undefined) this.executionBreakdown = acc;
    } catch { /* non-fatal */ }
  }

  private async collectChangedFiles(_runSummary: SprintRunSummary): Promise<string[]> {
    // When a worktreePool is available, collect files from individual agent
    // worktree branches via git diff rather than git status on the main tree.
    if (this.options.config.prMode === 'multi' && this.getEffectiveWorktreePool()) {
      return this.collectFilesFromAgentBranches();
    }

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: this.options.cwd,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout
        .toString()
        .split('\n')
        .filter(line => line.length > 0)
        // Porcelain format: "XY path" where XY is 2-char status and path is tab/space-separated
        // For renames: "R  old -> new" — we only care about the new path
        .map(line => {
          const rest = line.slice(3);
          const arrowIdx = rest.indexOf(' -> ');
          return arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest.trim();
        })
        .filter(file => file.length > 0)
        .filter(file => !file.startsWith('.agentforge/cycles/'));
    } catch {
      return [];
    }
  }

  /**
   * Collect changed files from agent worktree branches recorded in execute.json.
   * Delegates to the exported `collectFilesFromAgentBranches()` helper so it can
   * be tested in isolation without spinning up a full CycleRunner.
   */
  private async collectFilesFromAgentBranches(): Promise<string[]> {
    return collectFilesFromAgentBranches({
      cwd: this.options.cwd,
      cycleId: this.cycleId,
      baseBranch: this.options.config.git.baseBranch,
    });
  }

  /**
   * Render a deterministic commit message for the autonomous commit.
   * The Co-Authored-By trailer is required by the AgentForge git policy.
   */
  private buildCommitMessage(version: string, summary: string): string {
    return `autonomous(v${version}): ${summary}

Cycle: ${this.cycleId}

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
`;
  }

  /**
   * Build a CycleResult with sane defaults for every field, then apply the
   * caller's overrides on top. Used for both intermediate (REVIEW) and
   * terminal (COMPLETED/KILLED/FAILED) results.
   */
  private buildResult(
    stage: CycleStage,
    overrides: Partial<CycleResult> = {},
  ): CycleResult {
    const base: CycleResult = {
      cycleId: this.cycleId,
      sprintVersion: this.sprintVersion,
      stage,
      startedAt: new Date(this.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      cost: {
        totalUsd: this.totalCostUsd,
        budgetUsd: this.options.config.budget.perCycleUsd,
        byAgent: {},
        byPhase: {},
        // Wave 2: attach granular token/tool breakdown when available.
        ...(this.executionBreakdown !== undefined
          ? { breakdown: this.executionBreakdown }
          : {}),
      },
      tests: { ...this.testStats },
      git: {
        branch: this.branch,
        commitSha: this.commitSha,
        filesChanged: [...this.filesChanged],
      },
      pr: {
        url: this.prUrl,
        number: this.prNumber,
        draft: this.prDraft,
      },
    };
    if (this.scoringFallback) {
      base.scoringFallback = this.scoringFallback;
    }
    if (this.gateVerdict !== undefined) {
      base.gateVerdict = this.gateVerdict;
    }
    const merged: CycleResult = { ...base, ...overrides };
    // v6.4.4 bug #2: propagate `error` field so FAILED cycles surface the
    // reason in cycle.json rather than forcing consumers to reconstruct it
    // from events.jsonl. `exactOptionalPropertyTypes` forbids assigning
    // `undefined`, so only attach when present.
    if (overrides.error !== undefined) {
      merged.error = overrides.error;
    }
    if (overrides.gateVerdict !== undefined) {
      merged.gateVerdict = overrides.gateVerdict;
    }
    return merged;
  }

  /**
   * STAGE 6 multi-PR path.
   *
   * - Drains in-flight MergeQueue handlers.
   * - Logs a one-line summary for each PR recorded in the ledger.
   * - If `config.autoMergePRs === true`, calls drainAndMerge({ autoMerge: true })
   *   to promote CI-green PRs to ready and squash-merge them.
   * - If `config.autoMergePRs` is false/absent (default), calls
   *   drainAndMerge({ autoMerge: false }) which only promotes drafts → ready.
   *
   * The single-PR (PROpener) step is NOT called in this path.
   * Errors from drainAndMerge are swallowed — a merge failure must never
   * kill a cycle that passed all quality gates.
   */
  private async runMultiPrDrain(_version: string, _summary: string): Promise<void> {
    if (!this.mergeQueue) return;

    // Stop accepting new events before draining.
    this.mergeQueue.stop();

    // eslint-disable-next-line no-console
    console.log('[autonomous:cycle] multi-pr: draining MergeQueue...');

    // Drain in-flight handlers and read the ledger summary.
    let drainResult: Awaited<ReturnType<MergeQueue['drain']>>;
    try {
      drainResult = await this.mergeQueue.drain();
    } catch (err) {
      this.writeMultiPrMergeDrainArtifact({
        ok: false,
        stage: 'drain',
        error: err instanceof Error ? err.message : String(err),
      });
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] multi-pr: drain error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Log per-PR summary (one line each).
    for (const pr of drainResult.prs) {
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] multi-pr: PR #${pr.prNumber} agent=${pr.agentId} branch=${pr.branch}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[autonomous:cycle] multi-pr: ${drainResult.pushed} branch(es) pushed, ${drainResult.prs.length} open PR(s)`,
    );

    // Optionally call drainAndMerge.
    try {
      const autoMerge = this.options.config.autoMergePRs === true;
      const dmResult: DrainAndMergeResult = await this.mergeQueue.drainAndMerge({ autoMerge });
      this.writeMultiPrMergeDrainArtifact({
        ok: true,
        stage: 'drainAndMerge',
        drain: drainResult,
        drainAndMerge: dmResult,
        autoMerge,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[autonomous:cycle] multi-pr: drainAndMerge complete — ` +
        `ready=${dmResult.ready.length} merged=${dmResult.merged.length} ` +
        `failing=${dmResult.failing.length} pending=${dmResult.pending.length} ` +
        `unknown=${dmResult.unknown.length}`,
      );
    } catch (err) {
      this.writeMultiPrMergeDrainArtifact({
        ok: false,
        stage: 'drainAndMerge',
        drain: drainResult,
        error: err instanceof Error ? err.message : String(err),
      });
      // Swallow — merge errors must never fail the cycle.
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] multi-pr: drainAndMerge error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private writeMultiPrMergeDrainArtifact(payload: Record<string, unknown>): void {
    try {
      const cycleDir = join(this.options.cwd, '.agentforge/cycles', this.cycleId);
      mkdirSync(cycleDir, { recursive: true });
      writeFileSync(
        join(cycleDir, 'multi-pr-merge-drain.json'),
        JSON.stringify({
          cycleId: this.cycleId,
          recordedAt: new Date().toISOString(),
          ...payload,
        }, null, 2) + '\n',
      );
    } catch {
      // Best-effort artifact only; merge-drain telemetry must not fail cycles.
    }
  }

  /**
   * T4.6 — Run WorktreeGc at cycle start and end.
   * - start: aggressive cleanup (olderThanMs=24h, keepLast=20, maxDiskMb=5000)
   * - end:   keepLast=20 so forensics are preserved, no age filter override
   *
   * Any error is caught and logged — GC failures must never kill a cycle.
   */
  private async runWorktreeGc(when: 'start' | 'end'): Promise<void> {
    const pool = this.getEffectiveWorktreePool();
    if (!pool) return;
    try {
      const gc = new WorktreeGc({
        pool,
        projectRoot: this.options.cwd,
        keepLast: 20,
        ...(when === 'start' ? { olderThanMs: 24 * 60 * 60 * 1000 } : {}),
        maxDiskMb: 5000,
      });
      const result = await gc.run();
      if (result.removed.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[autonomous:cycle] worktree-gc (${when}): removed ${result.removed.length} worktrees` +
          ` (~${result.diskFreedMb.toFixed(1)} MB freed)`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[autonomous:cycle] worktree-gc (${when}) error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Read-only accessor for tests/operators that want to inspect the cycleId
   * before `start()` is called (e.g., to set up an external monitor).
   */
  getCycleId(): string {
    return this.cycleId;
  }

  private getEffectiveWorktreePool(): WorktreePool | undefined {
    return this.options.disableWorktrees ? undefined : this.options.worktreePool;
  }

  /**
   * Read-only accessor for the kill switch trip state. Useful for external
   * dashboards/healthchecks that want to surface the kill reason without
   * waiting for `start()` to return.
   */
  getKillSwitchTrip(): KillSwitchTrip | null {
    return this.killSwitch.getTrip();
  }
}
