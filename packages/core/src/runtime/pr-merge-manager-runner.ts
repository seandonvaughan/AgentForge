/**
 * pr-merge-manager-runner.ts — Cycle 1 / v22.3
 *
 * Runtime entry-point for the pr-merge-manager agent.  Reads the MergeQueue
 * ledger for a given cycle, gathers per-PR CI status, calls the LLM with the
 * batch-decision prompt, validates the response, and — when not in dry-run
 * mode — executes the decisions via `gh`.
 *
 * Caller contract:
 *   const result = await runPrMergeManager({ projectRoot, cycleId, runtime });
 *   // result.decisions — what the model decided
 *   // result.executed  — which decisions were acted on (empty in dryRun)
 *   // result.dryRun    — mirrors the opts flag
 */

import { execFile as execFileCb } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { AgentRuntime } from '../agent-runtime/agent-runtime.js';
import type { LedgerEntry } from './merge-queue.js';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Internal helpers — __dirname equivalent in ESM
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
void _require; // silence unused-var lint

function currentDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

// ---------------------------------------------------------------------------
// System prompt loader
// ---------------------------------------------------------------------------

let _cachedPrompt: string | undefined;

function loadSystemPrompt(): string {
  if (_cachedPrompt !== undefined) return _cachedPrompt;

  const candidates = [
    // compiled dist path
    join(currentDir(), 'pr-merge-manager-prompt.md'),
    // source path (used in tests via tsx / ts-node)
    join(currentDir(), '../runtime/pr-merge-manager-prompt.md'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      _cachedPrompt = readFileSync(p, 'utf-8');
      return _cachedPrompt;
    }
  }

  // Inline fallback so the runner is always usable even if the .md wasn't
  // copied to dist.
  _cachedPrompt = [
    'You are the pr-merge-manager. Review the listed PRs and return a JSON',
    'object: {"decisions":[{"prNumber":<n>,"action":"merge"|"wait"|"comment",',
    '"reason":"<string>"}]}.',
    'NEVER merge when CI is failing. When in doubt, use "wait".',
  ].join('\n');
  return _cachedPrompt;
}

// Exported for tests only — resets the module-level cache.
export function _resetPromptCache(): void {
  _cachedPrompt = undefined;
}

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const MergeActionSchema = z.enum(['merge', 'wait', 'comment']);
export type MergeAction = z.infer<typeof MergeActionSchema>;

export const PrDecisionSchema = z.object({
  prNumber: z.number().int().positive(),
  action: MergeActionSchema,
  reason: z.string().min(1),
  /** Required when action === 'comment'; ignored otherwise. */
  comment: z.string().optional(),
});
export type PrDecision = z.infer<typeof PrDecisionSchema>;

export const PrDecisionResponseSchema = z.object({
  decisions: z.array(PrDecisionSchema),
});
export type PrDecisionResponse = z.infer<typeof PrDecisionResponseSchema>;

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class PrMergeManagerParseError extends Error {
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.name = 'PrMergeManagerParseError';
    this.raw = raw;
  }
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ExecutedDecision {
  prNumber: number;
  action: MergeAction;
  ghOutput?: string;
  error?: string;
}

export interface PrMergeManagerResult {
  decisions: PrDecision[];
  executed: ExecutedDecision[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PrMergeManagerOptions {
  projectRoot: string;
  cycleId: string;
  runtime: AgentRuntime;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal: ledger reader
// ---------------------------------------------------------------------------

function readLedger(projectRoot: string, cycleId: string): LedgerEntry[] {
  const ledgerPath = join(
    projectRoot,
    '.agentforge',
    'cycles',
    cycleId,
    'agent-prs.json',
  );
  if (!existsSync(ledgerPath)) return [];
  try {
    const raw = readFileSync(ledgerPath, 'utf-8').trim();
    if (!raw) return [];
    return JSON.parse(raw) as LedgerEntry[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal: CI status fetcher
// ---------------------------------------------------------------------------

export interface CiBucket {
  name: string;
  bucket: string;
}

/**
 * Fetch CI check results for a PR number.
 * Returns an empty array on any error (auth failure, PR not found, etc.)
 * so the caller can treat all checks as 'unknown'.
 */
export async function fetchCiChecks(
  prNumber: number,
  projectRoot: string,
): Promise<CiBucket[]> {
  try {
    const { stdout } = await execFile(
      'gh',
      ['pr', 'checks', String(prNumber), '--json', 'bucket,name'],
      { cwd: projectRoot, windowsHide: true },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>).map((item) => ({
      name: typeof item['name'] === 'string' ? item['name'] : 'unknown',
      bucket:
        typeof item['bucket'] === 'string' ? item['bucket'] : 'unknown',
    }));
  } catch {
    // gh not installed, not authed, or PR not found — treat as unknown CI
    return [];
  }
}

function summariseCi(checks: CiBucket[]): string {
  if (checks.length === 0) return 'UNKNOWN (CI data unavailable)';

  const failing = checks.filter((c) =>
    ['fail', 'error'].includes(c.bucket.toLowerCase()),
  );
  const pending = checks.filter((c) =>
    ['pending', 'queued'].includes(c.bucket.toLowerCase()),
  );
  const passing = checks.filter((c) =>
    ['pass', 'success'].includes(c.bucket.toLowerCase()),
  );
  const skipped = checks.filter((c) =>
    ['skipped'].includes(c.bucket.toLowerCase()),
  );

  if (failing.length > 0) {
    return `FAIL (${failing.map((c) => c.name).join(', ')} failing)`;
  }
  if (pending.length > 0) {
    return `PENDING (${pending.map((c) => c.name).join(', ')} still running)`;
  }
  if (passing.length > 0 || skipped.length > 0) {
    return `PASS (${passing.length} passing, ${skipped.length} skipped)`;
  }
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Internal: user message builder
// ---------------------------------------------------------------------------

async function buildUserMessage(
  entries: LedgerEntry[],
  projectRoot: string,
): Promise<string> {
  const openEntries = entries.filter(
    (e) => e.status === 'open' && e.prNumber != null,
  );

  const lines: string[] = [];

  if (openEntries.length === 0) {
    return '## Open PRs\n\n_(none)_\n';
  }

  lines.push(`## Open PRs for cycle ${openEntries[0]!.cycleId}`);
  lines.push('');

  for (const entry of openEntries) {
    const prNum = entry.prNumber!;
    const checks = await fetchCiChecks(prNum, projectRoot);
    const ciSummary = summariseCi(checks);

    lines.push(`### PR #${prNum} — agent: ${entry.agentId}`);
    lines.push(`- branch: ${entry.branch}`);
    lines.push(`- items: ${JSON.stringify(entry.itemIds)}`);
    lines.push(`- CI: ${ciSummary}`);
    lines.push(`- status: open (draft)`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal: response parser
// ---------------------------------------------------------------------------

function parseDecisionResponse(raw: string): PrDecisionResponse {
  // Strip any markdown code-fence the model may have added
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PrMergeManagerParseError(
      `Response is not valid JSON: ${msg}`,
      raw,
    );
  }

  const result = PrDecisionResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new PrMergeManagerParseError(
      `Response failed schema validation: ${result.error.message}`,
      raw,
    );
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// Internal: decision executor
// ---------------------------------------------------------------------------

async function executeDecision(
  decision: PrDecision,
  projectRoot: string,
): Promise<ExecutedDecision> {
  const { prNumber, action } = decision;

  if (action === 'merge') {
    try {
      const { stdout } = await execFile(
        'gh',
        ['pr', 'merge', String(prNumber), '--squash', '--auto'],
        { cwd: projectRoot, windowsHide: true },
      );
      return { prNumber, action, ghOutput: stdout.trim() };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { prNumber, action, error };
    }
  }

  if (action === 'comment' && decision.comment) {
    try {
      const { stdout } = await execFile(
        'gh',
        ['pr', 'comment', String(prNumber), '--body', decision.comment],
        { cwd: projectRoot, windowsHide: true },
      );
      return { prNumber, action, ghOutput: stdout.trim() };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { prNumber, action, error };
    }
  }

  // action === 'wait', or 'comment' with no comment body — no gh call
  return { prNumber, action };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the pr-merge-manager batch decision loop for the given cycle.
 *
 * @param opts.projectRoot  Absolute path to the repository root.
 * @param opts.cycleId      The cycle whose `agent-prs.json` ledger to read.
 * @param opts.runtime      An already-configured AgentRuntime instance.
 * @param opts.dryRun       When true, decisions are returned but gh is never
 *                          called.  Defaults to false.
 */
export async function runPrMergeManager(
  opts: PrMergeManagerOptions,
): Promise<PrMergeManagerResult> {
  const { projectRoot, cycleId, runtime, dryRun = false } = opts;

  // 1. Read ledger
  const entries = readLedger(projectRoot, cycleId);
  const openEntries = entries.filter(
    (e) => e.status === 'open' && e.prNumber != null,
  );

  // Fast-path: no open PRs in ledger
  if (openEntries.length === 0) {
    return { decisions: [], executed: [], dryRun };
  }

  // 2. Build the structured user message (includes CI status per PR)
  const userMessage = await buildUserMessage(entries, projectRoot);

  // 3. Call the runtime with the batch-decision system prompt
  const systemPrompt = loadSystemPrompt();

  // We create a temporary config using the runtime's existing config as a
  // base — we only need to override the systemPrompt for this invocation.
  // AgentRuntime.run() accepts a plain RunOptions object; the systemPrompt is
  // baked into the runtime's AgentRuntimeConfig at construction time, so we
  // build a fresh runtime using the execution service directly.
  //
  // Because AgentRuntime wraps ExecutionService and its config is readonly,
  // we call runtime.run() which will use the stored config.  The caller is
  // expected to pass a runtime already configured for the pr-merge-manager
  // agent (model: sonnet, systemPrompt: loadSystemPrompt()).
  //
  // For callers that pass a generic runtime, the system-prompt override is
  // embedded in the task message as a preamble so the model always sees the
  // correct instructions.
  const task = [
    '<!-- system-prompt-override -->',
    systemPrompt,
    '<!-- end-system-prompt-override -->',
    '',
    userMessage,
    '',
    'Produce the JSON decision object now.',
  ].join('\n');

  const result = await runtime.run({ task });

  // 4. Parse and validate the response
  const { decisions } = parseDecisionResponse(result.response);

  // 5. Execute decisions (unless dry-run)
  const executed: ExecutedDecision[] = [];

  if (!dryRun) {
    for (const decision of decisions) {
      const execResult = await executeDecision(decision, projectRoot);
      executed.push(execResult);
    }
  }

  return { decisions, executed, dryRun };
}
