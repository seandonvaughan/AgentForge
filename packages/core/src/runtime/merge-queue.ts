/**
 * MergeQueue — Cycle 4 / T4.4
 *
 * Subscribes to `agent.branch.pushed` events emitted by Workstream CC
 * (agent-commit.ts), opens a draft GitHub PR per agent branch, and maintains
 * an append-only ledger at:
 *
 *   .agentforge/cycles/<cycleId>/agent-prs.json
 *
 * Ledger schema (one object per element in the top-level array):
 * {
 *   prNumber:  number | null,
 *   prUrl:     string | null,
 *   branch:    string,
 *   agentId:   string,
 *   cycleId:   string,
 *   itemIds:   string[],
 *   status:    'open' | 'dry-run' | 'skipped-no-gh',
 *   openedAt:  string  (ISO 8601)
 * }
 *
 * Atomic writes: write to <file>.tmp then rename over the real path so
 * concurrent readers never see a partial JSON file.
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { MessageBusV2 } from '../message-bus/message-bus.js';
import type { AgentBranchPushedPayload, MergeQueuePrOpenedPayload } from '../message-bus/types.js';
import type { MessageEnvelopeV2 } from '../message-bus/types.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeQueueOptions {
  projectRoot: string;
  bus: MessageBusV2;
  /** Target branch for draft PRs. Defaults to reading cycle.json, then 'main'. */
  parentBranch?: string;
  /** When true, never call gh; record entries with status='dry-run'. */
  dryRun?: boolean;
  /**
   * Cycle ID to scope drainAndMerge ledger reads to a specific cycle.
   * When omitted, drainAndMerge reads all cycle ledgers (same as drain()).
   */
  cycleId?: string;
  /** Test seam for opening draft PRs without invoking the GitHub CLI. */
  draftPrOpener?: DraftPrOpener;
}

export interface DraftPrOpenRequest {
  parentBranch: string;
  branch: string;
  agentId: string;
  itemIds: string[];
  diffSummary: string;
  cycleId: string;
  projectRoot: string;
}

export interface DraftPrOpenResult {
  prNumber: number;
  prUrl: string;
}

export type DraftPrOpener = (opts: DraftPrOpenRequest) => Promise<DraftPrOpenResult>;

export interface AgentBranchPushedEvent extends AgentBranchPushedPayload {
  topic: 'agent.branch.pushed';
}

export interface LedgerEntry {
  prNumber: number | null;
  prUrl: string | null;
  branch: string;
  agentId: string;
  cycleId: string;
  itemIds: string[];
  status: 'open' | 'dry-run' | 'skipped-no-gh' | 'merged';
  openedAt: string;
}

export interface DrainResult {
  pushed: number;
  prs: Array<{ prNumber: number; branch: string; agentId: string }>;
}

/** Options accepted by {@link MergeQueue.drainAndMerge}. */
export interface DrainAndMergeOptions {
  /**
   * When `true`, CI-green PRs are squash-merged automatically after being
   * promoted to ready. Defaults to `false` (only promotes drafts → ready).
   */
  autoMerge?: boolean;
  /**
   * Order in which PRs are processed.
   * - `'priority'`: by prNumber ascending (lower number = earlier open = higher priority)
   * - `'time'`: by openedAt ISO timestamp ascending
   * Defaults to `'time'`.
   */
  sequenceBy?: 'priority' | 'time';
}

/** Result returned by {@link MergeQueue.drainAndMerge}. */
export interface DrainAndMergeResult {
  /** PR numbers that were promoted from draft → ready (and NOT auto-merged). */
  ready: number[];
  /** PR numbers that were promoted and then squash-merged. */
  merged: number[];
  /** PR numbers where one or more CI checks are failing. */
  failing: number[];
  /** PR numbers where CI checks are still pending (not yet finished). */
  pending: number[];
  /** PR numbers where CI state could not be determined safely. */
  unknown: number[];
}

type CiStatus = 'green' | 'pending' | 'failing' | 'unknown';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readLedger(ledgerPath: string): LedgerEntry[] {
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, 'utf-8').trim();
    if (!raw) return [];
    return JSON.parse(raw) as LedgerEntry[];
  } catch {
    return [];
  }
}

function writeLedger(ledgerPath: string, entries: LedgerEntry[]): void {
  const tmpPath = ledgerPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, ledgerPath);
}

function appendToLedger(ledgerPath: string, entry: LedgerEntry): void {
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const entries = readLedger(ledgerPath);
  entries.push(entry);
  writeLedger(ledgerPath, entries);
}

function findLedgerEntryByBranch(ledgerPath: string, branch: string): LedgerEntry | null {
  const entries = readLedger(ledgerPath);
  for (const entry of entries) {
    if (entry.branch === branch) return entry;
  }
  return null;
}

function resolveCycleDir(projectRoot: string, cycleId: string): string {
  return join(projectRoot, '.agentforge', 'cycles', cycleId);
}

function resolveParentBranchFromCycleJson(
  projectRoot: string,
  cycleId: string,
): string | null {
  const cycleJsonPath = join(resolveCycleDir(projectRoot, cycleId), 'cycle.json');
  if (!existsSync(cycleJsonPath)) return null;
  try {
    const json = JSON.parse(readFileSync(cycleJsonPath, 'utf-8')) as Record<string, unknown>;
    // cycle.json stores the autonomous branch under git.branch
    const gitBranch = (json['git'] as Record<string, unknown> | undefined)?.['branch'];
    if (typeof gitBranch === 'string' && gitBranch) return gitBranch;
  } catch {
    // ignore
  }
  return null;
}

async function openDraftPr(opts: DraftPrOpenRequest): Promise<DraftPrOpenResult> {
  const title = `agent(${opts.agentId}): ${opts.itemIds.join(', ')}`;
  const body = [
    `## Agent PR — ${opts.agentId}`,
    '',
    `**Cycle:** ${opts.cycleId}`,
    `**Branch:** \`${opts.branch}\``,
    `**Base:** \`${opts.parentBranch}\``,
    `**Items:** ${opts.itemIds.join(', ')}`,
    '',
    '### Diff summary',
    '```',
    opts.diffSummary.slice(0, 2000),
    '```',
    '',
    '_Auto-generated by MergeQueue (T4.4)_',
  ].join('\n');

  const { stdout } = await execFile(
    'gh',
    [
      'pr',
      'create',
      '--draft',
      '--base',
      opts.parentBranch,
      '--head',
      opts.branch,
      '--title',
      title,
      '--body',
      body,
    ],
    { cwd: opts.projectRoot, windowsHide: true },
  );

  // `gh pr create` prints the PR URL on the last non-empty line
  const lines = stdout.trim().split('\n').filter(Boolean);
  const prUrl = lines[lines.length - 1] ?? '';

  // Extract number from URL like https://github.com/owner/repo/pull/42
  const match = prUrl.match(/\/pull\/(\d+)$/);
  const prNumber = match ? parseInt(match[1]!, 10) : NaN;

  if (isNaN(prNumber) || prNumber === 0) {
    throw new Error(`gh pr create returned an unexpected URL: ${prUrl}`);
  }

  return { prNumber, prUrl };
}

// ---------------------------------------------------------------------------
// MergeQueue
// ---------------------------------------------------------------------------

export class MergeQueue {
  private readonly projectRoot: string;
  private readonly bus: MessageBusV2;
  private readonly parentBranchOverride: string | undefined;
  private readonly dryRun: boolean;
  private readonly cycleId: string | undefined;
  private readonly draftPrOpener: DraftPrOpener;

  private unsubscribe: (() => void) | null = null;
  /** Tracks in-flight handler promises so drain() can await them. */
  private readonly inFlight = new Set<Promise<void>>();
  /** In-memory dedupe for concurrent duplicate branch-pushed events. */
  private readonly inFlightBranchKeys = new Set<string>();

  constructor(opts: MergeQueueOptions) {
    this.projectRoot = opts.projectRoot;
    this.bus = opts.bus;
    this.parentBranchOverride = opts.parentBranch;
    this.dryRun = opts.dryRun ?? false;
    this.cycleId = opts.cycleId;
    this.draftPrOpener = opts.draftPrOpener ?? openDraftPr;
  }

  /** Subscribe to agent.branch.pushed topic and begin processing. */
  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = this.bus.subscribe<AgentBranchPushedPayload>(
      'agent.branch.pushed',
      (envelope: MessageEnvelopeV2<AgentBranchPushedPayload>) => {
        const p = this.handleEvent(envelope.payload).catch((err) => {
          console.error('[MergeQueue] Unhandled error in handler:', err);
        });
        this.inFlight.add(p);
        void p.finally(() => {
          this.inFlight.delete(p);
        });
      },
    );
  }

  /** Unsubscribe from the bus — new events will be ignored. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Wait for all in-flight event handlers to complete.
   * Returns a summary of pushed branches and opened PRs from the ledger.
   */
  async drain(): Promise<DrainResult> {
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }

    // Aggregate from the current cycle when this queue was scoped with a cycle
    // id. Falling back to all ledgers is kept only for legacy callers that do
    // not pass cycleId.
    const ledgerPaths: string[] = [];
    const prs: Array<{ prNumber: number; branch: string; agentId: string }> = [];
    let pushed = 0;

    if (this.cycleId) {
      ledgerPaths.push(join(resolveCycleDir(this.projectRoot, this.cycleId), 'agent-prs.json'));
    } else {
      const cyclesDir = join(this.projectRoot, '.agentforge', 'cycles');
      if (existsSync(cyclesDir)) {
        const { readdirSync } = await import('node:fs');
        for (const cycleId of readdirSync(cyclesDir)) {
          ledgerPaths.push(join(cyclesDir, cycleId, 'agent-prs.json'));
        }
      }
    }

    for (const ledgerPath of ledgerPaths) {
      const entries = readLedger(ledgerPath);
      pushed += entries.length;
      for (const e of entries) {
        if (e.status === 'open' && e.prNumber != null) {
          prs.push({ prNumber: e.prNumber, branch: e.branch, agentId: e.agentId });
        }
      }
    }

    return { pushed, prs };
  }

  /**
   * Promote and optionally merge all open PRs recorded in the ledger.
   *
   * For each entry with `status === 'open'`:
   *   1. Query CI status via `gh pr checks <number> --json bucket`.
   *   2. If all checks pass:
   *      - Always: `gh pr ready <number>` (promote draft → ready for review).
   *      - If `autoMerge === true`: `gh pr merge <number> --squash --delete-branch`.
   *        Updates ledger entry to `status = 'merged'`.
   *   3. If any check is failing: log and leave `status = 'open'`.
   *   4. If any check is pending: leave for next drain call.
   *
   * Ledger is updated atomically (tmp → rename) after processing all entries.
   *
   * Returns a summary categorised by outcome.
   */
  async drainAndMerge(opts: DrainAndMergeOptions = {}): Promise<DrainAndMergeResult> {
    const { autoMerge = false, sequenceBy = 'time' } = opts;

    // Wait for all in-flight handlers before touching the ledger.
    if (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }

    const result: DrainAndMergeResult = {
      ready: [],
      merged: [],
      failing: [],
      pending: [],
      unknown: [],
    };

    // Collect (cycleId, ledgerPath) pairs to read.
    const ledgerPaths: Array<{ cycleId: string; ledgerPath: string }> = [];

    if (this.cycleId) {
      ledgerPaths.push({
        cycleId: this.cycleId,
        ledgerPath: join(resolveCycleDir(this.projectRoot, this.cycleId), 'agent-prs.json'),
      });
    } else {
      const cyclesDir = join(this.projectRoot, '.agentforge', 'cycles');
      if (existsSync(cyclesDir)) {
        const { readdirSync } = await import('node:fs');
        for (const cid of readdirSync(cyclesDir)) {
          ledgerPaths.push({
            cycleId: cid,
            ledgerPath: join(cyclesDir, cid, 'agent-prs.json'),
          });
        }
      }
    }

    for (const { ledgerPath } of ledgerPaths) {
      const entries = readLedger(ledgerPath);
      if (entries.length === 0) continue;

      // Sort entries according to sequenceBy
      const openEntries = entries.filter((e) => e.status === 'open' && e.prNumber != null);
      const sortedOpen = [...openEntries].sort((a, b) => {
        if (sequenceBy === 'priority') {
          return (a.prNumber ?? 0) - (b.prNumber ?? 0);
        }
        // default: 'time'
        return a.openedAt.localeCompare(b.openedAt);
      });

      for (const entry of sortedOpen) {
        const prNum = entry.prNumber!;
        const ciStatus = await this.getCiStatus(prNum);

        if (ciStatus === 'failing') {
          console.warn(`[MergeQueue:drainAndMerge] PR #${prNum} has failing checks — leaving open`);
          result.failing.push(prNum);
          continue;
        }

        if (ciStatus === 'pending') {
          console.log(`[MergeQueue:drainAndMerge] PR #${prNum} has pending checks — skipping for now`);
          result.pending.push(prNum);
          continue;
        }

        if (ciStatus === 'unknown') {
          console.warn(`[MergeQueue:drainAndMerge] PR #${prNum} has unknown CI state — leaving open`);
          result.unknown.push(prNum);
          continue;
        }

        // Explicitly green checks — promote draft → ready.
        try {
          await execFile('gh', ['pr', 'ready', String(prNum)], { cwd: this.projectRoot, windowsHide: true });
          console.log(`[MergeQueue:drainAndMerge] PR #${prNum} promoted to ready`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[MergeQueue:drainAndMerge] gh pr ready #${prNum} failed: ${msg}`);
          result.failing.push(prNum);
          continue;
        }

        if (autoMerge) {
          try {
            await execFile(
              'gh',
              ['pr', 'merge', String(prNum), '--squash', '--delete-branch'],
              { cwd: this.projectRoot, windowsHide: true },
            );
            // Atomically update ledger entry to 'merged'
            const updatedEntries = readLedger(ledgerPath).map((e) =>
              e.prNumber === prNum ? { ...e, status: 'merged' as const } : e,
            );
            writeLedger(ledgerPath, updatedEntries);
            console.log(`[MergeQueue:drainAndMerge] PR #${prNum} merged (squash)`);
            result.merged.push(prNum);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[MergeQueue:drainAndMerge] gh pr merge #${prNum} failed: ${msg}`);
            // Promoted but not merged — still counts as ready
            result.ready.push(prNum);
          }
        } else {
          result.ready.push(prNum);
        }
      }
    }

    return result;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Query CI check status for a PR.
   * Returns:
   *   - `'green'`   if all checks explicitly passed or were skipped
   *   - `'pending'` if at least one check is still running
   *   - `'failing'` if at least one check has failed
   *   - `'unknown'` if CI cannot be queried or returns an unrecognized state
   */
  private async getCiStatus(prNumber: number): Promise<CiStatus> {
    let stdout: string;
    try {
      const out = await execFile(
        'gh',
        ['pr', 'checks', String(prNumber), '--json', 'bucket', '--jq', '.[] | .bucket'],
        { cwd: this.projectRoot, windowsHide: true },
      );
      stdout = out.stdout;
    } catch {
      return 'unknown';
    }

    const buckets = stdout.trim().split('\n').filter(Boolean);
    if (buckets.length === 0) return 'unknown';
    const normalized = buckets.map((b) => b.trim().toLowerCase()).filter(Boolean);
    if (normalized.some((b) => ['fail', 'failing', 'cancel', 'cancelled', 'timed_out'].includes(b))) {
      return 'failing';
    }
    if (normalized.some((b) => ['pending', 'queued', 'in_progress', 'waiting'].includes(b))) {
      return 'pending';
    }
    const greenBuckets = new Set(['pass', 'success', 'skipping', 'skipped']);
    if (normalized.every((b) => greenBuckets.has(b))) return 'green';
    return 'unknown';
  }

  private async handleEvent(payload: AgentBranchPushedPayload): Promise<void> {
    const { cycleId, agentId, branch, baseBranch, itemIds, diffSummary, pushedAt, localOnly } =
      payload;

    // Skip entirely when local-only (no remote)
    if (localOnly === true) {
      console.log(`[MergeQueue] Skipping ${branch} (localOnly=true)`);
      return;
    }

    const branchKey = `${cycleId}::${branch}`;
    if (this.inFlightBranchKeys.has(branchKey)) {
      console.log(`[MergeQueue] Skipping duplicate in-flight branch event for ${branch}`);
      return;
    }
    this.inFlightBranchKeys.add(branchKey);
    try {
      const ledgerPath = join(resolveCycleDir(this.projectRoot, cycleId), 'agent-prs.json');

      // Idempotency guard: retry/replay may emit the same branch push event
      // more than once. Re-processing would open duplicate PRs and append
      // duplicate ledger rows for the same branch.
      const existing = findLedgerEntryByBranch(ledgerPath, branch);
      if (existing) {
        console.log(`[MergeQueue] Skipping duplicate branch event for ${branch} (already recorded)`);
        return;
      }

      // Determine parent branch: override > cycle.json > baseBranch > 'main'
      const parentBranch =
        this.parentBranchOverride ??
        resolveCycleFromCycleJson(this.projectRoot, cycleId) ??
        baseBranch ??
        'main';

      if (this.dryRun) {
        const entry: LedgerEntry = {
          prNumber: null,
          prUrl: null,
          branch,
          agentId,
          cycleId,
          itemIds,
          status: 'dry-run',
          openedAt: new Date().toISOString(),
        };
        appendToLedger(ledgerPath, entry);

        this.bus.publish<MergeQueuePrOpenedPayload>({
          from: 'system',
          to: 'broadcast',
          topic: 'merge-queue.pr.opened',
          category: 'system',
          payload: {
            cycleId,
            agentId,
            branch,
            prNumber: null,
            status: 'dry-run',
            prUrl: null,
            openedAt: entry.openedAt,
          },
        });

        console.log(`[MergeQueue] dry-run — recorded ${branch} (no gh call)`);
        return;
      }

      // Live mode: attempt to open a draft PR
      let entry: LedgerEntry;
      try {
        const { prNumber, prUrl } = await this.draftPrOpener({
          parentBranch,
          branch,
          agentId,
          itemIds,
          diffSummary,
          cycleId,
          projectRoot: this.projectRoot,
        });

        entry = {
          prNumber,
          prUrl,
          branch,
          agentId,
          cycleId,
          itemIds,
          status: 'open',
          openedAt: pushedAt,
        };

        console.log(`[MergeQueue] Opened draft PR #${prNumber} for ${branch}: ${prUrl}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[MergeQueue] gh pr create failed (${msg}); recording as skipped-no-gh`);

        entry = {
          prNumber: null,
          prUrl: null,
          branch,
          agentId,
          cycleId,
          itemIds,
          status: 'skipped-no-gh',
          openedAt: pushedAt,
        };
      }

      appendToLedger(ledgerPath, entry);

      this.bus.publish<MergeQueuePrOpenedPayload>({
        from: 'system',
        to: 'broadcast',
        topic: 'merge-queue.pr.opened',
        category: 'system',
        payload: {
          cycleId,
          agentId,
          branch,
          prNumber: entry.prNumber,
          status: entry.status,
          prUrl: entry.prUrl,
          openedAt: entry.openedAt,
        },
      });
    } finally {
      this.inFlightBranchKeys.delete(branchKey);
    }
  }
}

/** Read the cycle's autonomous branch from cycle.json. */
function resolveCycleFromCycleJson(projectRoot: string, cycleId: string): string | null {
  return resolveParentBranchFromCycleJson(projectRoot, cycleId);
}
