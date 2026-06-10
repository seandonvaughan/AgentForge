import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/;

export const ProjectRootInput = z.object({
  projectRoot: z.string().min(1).max(2048).optional(),
});

export const AfCodexReadinessInput = ProjectRootInput.extend({
  skipLogin: z.boolean().optional().default(false),
});

export const AfCyclePreviewInput = ProjectRootInput.extend({
  budgetUsd: z.number().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  /**
   * W7 — objective mode: rehearse the epic decomposition (planner +
   * deterministic validation) and return the children/waves/budget-band JSON.
   * Costs one planner LLM call (~$5); never executes a cycle.
   */
  objective: z.string().min(8).max(8192).optional(),
});

export const AfCycleStatusInput = ProjectRootInput.extend({
  cycleId: z.string().min(8).max(64).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export type AfCodexReadinessInputType = z.infer<typeof AfCodexReadinessInput>;
export type AfCyclePreviewInputType = z.infer<typeof AfCyclePreviewInput>;
export type AfCycleStatusInputType = z.infer<typeof AfCycleStatusInput>;

interface ToolResult {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string } | null;
}

interface CycleSummary {
  cycleId: string;
  stage: string;
  startedAt: string;
  completedAt: string | null;
  sprintVersion: string | null;
  costUsd: number;
  budgetUsd: number;
  testsPassed: number;
  testsTotal: number;
  prUrl: string | null;
  hasApprovalPending: boolean;
  approvalDecision: string | null;
  eventsCount: number;
}

interface AgentPrLedgerEntry {
  prNumber?: number | null;
  prUrl?: string | null;
  branch?: string;
  status?: string;
  openedAt?: string;
}

export async function afCodexReadiness(
  input: AfCodexReadinessInputType,
  defaultProjectRoot?: string,
): Promise<ToolResult> {
  const trustedRoot = resolveTrustedProjectRoot(input.projectRoot, defaultProjectRoot);
  if (!trustedRoot.ok) return trustedRoot;
  const projectRoot = trustedRoot.data as string;
  const args = ['codex', 'readiness', '--project-root', projectRoot, '--json'];
  if (input.skipLogin === true) args.push('--skip-login');

  const cli = resolveCli(projectRoot);
  if (!cli.ok) return cli;

  const run = await runCli(cli.data as string, args, projectRoot, 30_000);
  if (!run.ok) return run;

  try {
    return { ok: true, data: JSON.parse(String(run.data)), error: null };
  } catch {
    return {
      ok: false,
      data: { stdout: run.data },
      error: { code: 'READINESS_PARSE_ERROR', message: 'CLI readiness output was not valid JSON.' },
    };
  }
}

export async function afCyclePreview(
  input: AfCyclePreviewInputType,
  defaultProjectRoot?: string,
): Promise<ToolResult> {
  const trustedRoot = resolveTrustedProjectRoot(input.projectRoot, defaultProjectRoot);
  if (!trustedRoot.ok) return trustedRoot;
  const projectRoot = trustedRoot.data as string;
  const args = ['cycle', 'preview', '--project-root', projectRoot];
  if (input.budgetUsd !== undefined) args.push('--budget-usd', String(input.budgetUsd));
  if (input.maxItems !== undefined) args.push('--max-items', String(input.maxItems));
  const objectiveMode = typeof input.objective === 'string' && input.objective.trim().length > 0;
  if (objectiveMode) {
    args.push('--objective', input.objective!.trim(), '--json');
  }

  const cli = resolveCli(projectRoot);
  if (!cli.ok) return cli;

  // Objective mode runs the epic planner (one real LLM call) — allow 10 min.
  const run = await runCli(cli.data as string, args, projectRoot, objectiveMode ? 600_000 : 120_000);
  if (!run.ok) return run;

  if (objectiveMode) {
    try {
      return { ok: true, data: JSON.parse(String(run.data)), error: null };
    } catch {
      return {
        ok: false,
        data: { stdout: run.data },
        error: { code: 'PREVIEW_PARSE_ERROR', message: 'Objective preview output was not valid JSON.' },
      };
    }
  }

  return {
    ok: true,
    data: {
      dryRun: true,
      command: ['node', cli.data as string, ...args],
      stdout: run.data,
    },
    error: null,
  };
}

export function afCycleStatus(
  input: AfCycleStatusInputType,
  defaultProjectRoot?: string,
): ToolResult {
  const trustedRoot = resolveTrustedProjectRoot(input.projectRoot, defaultProjectRoot);
  if (!trustedRoot.ok) return trustedRoot;
  const projectRoot = trustedRoot.data as string;
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');

  if (input.cycleId !== undefined) {
    const matched = SAFE_ID.exec(input.cycleId);
    if (!matched) {
      return {
        ok: false,
        data: null,
        error: { code: 'INVALID_CYCLE_ID', message: 'cycleId must match ^[a-zA-Z0-9-]{8,64}$.' },
      };
    }

    const cycleId = matched[0];
    const cycleDir = join(cyclesDir, cycleId);
    const summary = summarizeCycle(cycleDir, cycleId);
    if (!summary) {
      return {
        ok: false,
        data: null,
        error: { code: 'CYCLE_NOT_FOUND', message: `Cycle not found: ${cycleId}` },
      };
    }

    return {
      ok: true,
      data: {
        projectRoot,
        cycle: summary,
        artifacts: readCycleArtifacts(cycleDir),
      },
      error: null,
    };
  }

  const limit = input.limit ?? 20;
  const cycles = listCycles(projectRoot).slice(0, limit);
  return {
    ok: true,
    data: {
      projectRoot,
      cycles,
      count: cycles.length,
      limit,
      cyclesDir,
    },
    error: null,
  };
}

function resolveProjectRoot(projectRoot: string | undefined, defaultProjectRoot: string | undefined): string {
  return resolve(projectRoot ?? defaultProjectRoot ?? process.env['AGENTFORGE_PROJECT_ROOT'] ?? process.cwd());
}

function resolveTrustedProjectRoot(
  projectRoot: string | undefined,
  defaultProjectRoot: string | undefined,
): ToolResult {
  const configuredRoot = resolveProjectRoot(undefined, defaultProjectRoot);
  if (projectRoot !== undefined) {
    const requestedRoot = resolve(projectRoot);
    if (!samePath(requestedRoot, configuredRoot)) {
      return {
        ok: false,
        data: { projectRoot: requestedRoot, allowedProjectRoot: configuredRoot },
        error: {
          code: 'PROJECT_ROOT_NOT_ALLOWED',
          message: 'projectRoot must match configured AGENTFORGE_PROJECT_ROOT.',
        },
      };
    }
  }
  return { ok: true, data: configuredRoot, error: null };
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (process.platform === 'win32') return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase();
  return resolvedLeft === resolvedRight;
}

function resolveCli(defaultProjectRoot: string | undefined): ToolResult {
  const root = resolveProjectRoot(undefined, defaultProjectRoot);
  const cliPath = join(root, 'packages', 'cli', 'dist', 'bin.js');
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      data: { cliPath },
      error: {
        code: 'CLI_NOT_BUILT',
        message: `AgentForge CLI build output is missing: ${cliPath}. Run corepack pnpm build.`,
      },
    };
  }
  return { ok: true, data: cliPath, error: null };
}

// ── W7: af_agent_invoke ──────────────────────────────────────────────────────

export const AfAgentInvokeInput = ProjectRootInput.extend({
  agentId: z.string().min(1).max(64),
  task: z.string().min(8).max(16384),
  /** Hard spend cap for the run. Required — refuse uncapped invocations. */
  budgetUsd: z.number().positive().max(25),
  /** Allowed tool hints threaded to CLI runtimes (e.g. Read,Glob,Grep). */
  tools: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type AfAgentInvokeInputType = z.infer<typeof AfAgentInvokeInput>;

const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Dispatch ONE forged agent with a budget cap via `agentforge run invoke`.
 * This is the write-capable surface for Claude Code sessions; the budget cap
 * is schema-required and bounded at $25.
 */
export async function afAgentInvoke(
  input: AfAgentInvokeInputType,
  defaultProjectRoot?: string,
): Promise<ToolResult> {
  const trustedRoot = resolveTrustedProjectRoot(input.projectRoot, defaultProjectRoot);
  if (!trustedRoot.ok) return trustedRoot;
  const projectRoot = trustedRoot.data as string;

  const agentMatch = SAFE_AGENT_ID_RE.exec(input.agentId);
  if (!agentMatch) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_AGENT_ID', message: 'agentId must be alphanumerics, dashes, underscores (≤64 chars)' },
    };
  }

  const args = [
    'run', 'invoke',
    '--agent', agentMatch[0],
    '--task', input.task,
    '--project-root', projectRoot,
    '--budget', String(input.budgetUsd),
  ];
  for (const tool of input.tools ?? []) {
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(tool)) args.push('--tool', tool);
  }

  const cli = resolveCli(projectRoot);
  if (!cli.ok) return cli;

  const run = await runCli(cli.data as string, args, projectRoot, 900_000);
  if (!run.ok) return run;
  return { ok: true, data: { stdout: run.data }, error: null };
}

// ── W7: af_cycle_events ──────────────────────────────────────────────────────

export const AfCycleEventsInput = ProjectRootInput.extend({
  cycleId: z.string().min(8).max(64),
  /** Byte offset returned as nextCursor by the previous call; 0 from the start. */
  cursor: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(500).optional().default(100),
});
export type AfCycleEventsInputType = z.infer<typeof AfCycleEventsInput>;

/**
 * Incremental tail of a cycle's events.jsonl. Claude Code polls this during a
 * long-running cycle: pass the returned nextCursor on the next call to read
 * only new events. Read-only, pure fs.
 */
export function afCycleEvents(
  input: AfCycleEventsInputType,
  defaultProjectRoot?: string,
): ToolResult {
  const trustedRoot = resolveTrustedProjectRoot(input.projectRoot, defaultProjectRoot);
  if (!trustedRoot.ok) return trustedRoot;
  const projectRoot = trustedRoot.data as string;

  const idMatch = /^[a-zA-Z0-9-]{8,64}$/.exec(input.cycleId);
  if (!idMatch) {
    return {
      ok: false,
      data: null,
      error: { code: 'INVALID_CYCLE_ID', message: 'cycleId must be alphanumerics/dashes (8-64 chars)' },
    };
  }
  const eventsPath = join(projectRoot, '.agentforge', 'cycles', idMatch[0], 'events.jsonl');
  if (!existsSync(eventsPath)) {
    return {
      ok: false,
      data: null,
      error: { code: 'CYCLE_NOT_FOUND', message: `No events.jsonl for cycle ${idMatch[0]}` },
    };
  }

  let raw: string;
  try {
    raw = readFileSync(eventsPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      data: null,
      error: { code: 'READ_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }

  const byteLength = Buffer.byteLength(raw, 'utf8');
  const cursor = Math.min(input.cursor ?? 0, byteLength);
  const slice = Buffer.from(raw, 'utf8').subarray(cursor).toString('utf8');
  const lines = slice.split('\n');
  // The final element is either '' (complete trailing newline) or a partial
  // line still being written — never emit it; the cursor stops before it.
  const lastPartial = lines.pop() ?? '';

  const events: unknown[] = [];
  let consumedBytes = 0;
  for (const line of lines) {
    // Stop consuming once the page is full — nextCursor must point at the
    // first UNREAD event, not past skipped ones.
    if (events.length >= (input.limit ?? 100)) break;
    consumedBytes += Buffer.byteLength(line, 'utf8') + 1; // +1 newline
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch { /* skip corrupt line */ }
  }

  return {
    ok: true,
    data: {
      cycleId: idMatch[0],
      events,
      nextCursor: cursor + consumedBytes,
      eof: lastPartial.length === 0 && cursor + consumedBytes >= byteLength,
    },
    error: null,
  };
}

async function runCli(
  cliPath: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<ToolResult> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 5,
      env: { ...process.env, AGENTFORGE_PROJECT_ROOT: cwd },
      windowsHide: true,
    });
    return { ok: true, data: result.stdout.trim(), error: null };
  } catch (err) {
    const error = err as { message?: string; stdout?: string; stderr?: string; code?: unknown };
    return {
      ok: false,
      data: {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        exitCode: error.code ?? null,
      },
      error: {
        code: 'CLI_FAILED',
        message: error.message ?? 'AgentForge CLI command failed.',
      },
    };
  }
}

function listCycles(projectRoot: string): CycleSummary[] {
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) return [];

  return readdirSync(cyclesDir)
    .filter((entry) => SAFE_ID.test(entry))
    .map((entry) => summarizeCycle(join(cyclesDir, entry), entry))
    .filter((value): value is CycleSummary => value !== null)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function summarizeCycle(cycleDir: string, cycleId: string): CycleSummary | null {
  if (!existsSync(cycleDir)) return null;

  const cycleJson = readJson(join(cycleDir, 'cycle.json')) as Record<string, unknown> | null;
  const cost = readRecord(cycleJson?.['cost']);
  const tests = readRecord(cycleJson?.['tests']);
  const pr = readRecord(cycleJson?.['pr']);
  const agentPr = latestCycleAgentPr(cycleDir);
  const activeStage = inferActiveStage(cycleDir);
  const hasApprovalPending =
    existsSync(join(cycleDir, 'approval-pending.json')) &&
    !existsSync(join(cycleDir, 'approval-decision.json'));
  const decision = readJson(join(cycleDir, 'approval-decision.json')) as Record<string, unknown> | null;

  return {
    cycleId: typeof cycleJson?.['cycleId'] === 'string' ? cycleJson['cycleId'] : cycleId,
    stage: typeof cycleJson?.['stage'] === 'string' ? cycleJson['stage'] : activeStage,
    startedAt: typeof cycleJson?.['startedAt'] === 'string'
      ? cycleJson['startedAt']
      : safeStatDate(cycleDir) ?? new Date(0).toISOString(),
    completedAt: typeof cycleJson?.['completedAt'] === 'string' ? cycleJson['completedAt'] : null,
    sprintVersion: typeof cycleJson?.['sprintVersion'] === 'string' ? cycleJson['sprintVersion'] : null,
    costUsd: toNumber(cost['totalUsd'], 0),
    budgetUsd: toNumber(cost['budgetUsd'], 200),
    testsPassed: toNumber(tests['passed'], 0),
    testsTotal: toNumber(tests['total'], 0),
    prUrl: typeof pr['url'] === 'string' && pr['url'].length > 0
      ? pr['url']
      : agentPr?.prUrl ?? null,
    hasApprovalPending,
    approvalDecision: typeof decision?.['decision'] === 'string' ? decision['decision'] : null,
    eventsCount: countJsonlLines(join(cycleDir, 'events.jsonl')),
  };
}

function latestCycleAgentPr(cycleDir: string): AgentPrLedgerEntry | null {
  const ledger = readJson(join(cycleDir, 'agent-prs.json'));
  if (!Array.isArray(ledger)) return null;

  const entries = ledger
    .filter((entry): entry is AgentPrLedgerEntry => entry !== null && typeof entry === 'object')
    .filter((entry) => typeof entry.prUrl === 'string' && entry.prUrl.length > 0)
    .sort((left, right) => {
      const leftTime = typeof left.openedAt === 'string' ? left.openedAt : '';
      const rightTime = typeof right.openedAt === 'string' ? right.openedAt : '';
      return rightTime.localeCompare(leftTime);
    });

  return entries[0] ?? null;
}

function readCycleArtifacts(cycleDir: string): Record<string, unknown> {
  return {
    cycleJson: readJson(join(cycleDir, 'cycle.json')),
    scoring: readJson(join(cycleDir, 'scoring.json')),
    approvalPending: readJson(join(cycleDir, 'approval-pending.json')),
    approvalDecision: readJson(join(cycleDir, 'approval-decision.json')),
    checkpoint:
      readJson(join(cycleDir, 'checkpoint-cycle.json')) ??
      readJson(join(cycleDir, 'checkpoint-execute.json')) ??
      readJson(join(cycleDir, 'checkpoint.json')),
  };
}

function inferActiveStage(cycleDir: string): string {
  const phasesDir = join(cycleDir, 'phases');
  if (!existsSync(phasesDir)) return 'plan';
  const stages = ['verify', 'pr', 'execute', 'review', 'gate', 'plan'];
  for (const stage of stages) {
    if (existsSync(join(phasesDir, `${stage}.json`))) return stage;
  }
  return 'plan';
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeStatDate(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .length;
  } catch {
    return 0;
  }
}
