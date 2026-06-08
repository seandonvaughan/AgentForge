/**
 * phase-handlers.ts — Plain async functions that execute each sprint phase.
 *
 * Task 15 of v6.4 autonomous loop. This module is the result of extracting the
 * phase logic that was previously embedded inside HTTP route handlers in
 * `packages/server/src/routes/v5/sprint-orchestration.ts`.
 *
 * Each phase handler:
 *   1. Publishes `sprint.phase.started` on `ctx.bus` (additive — used by the
 *      future PhaseScheduler in `packages/core/src/autonomous/`).
 *   2. Performs the phase's work (talking to AgentRuntime, AutoDelegationPipeline,
 *      reading and writing the sprint JSON file on disk).
 *   3. Continues to call `globalStream.emit(...)` for SSE — exactly as the
 *      v6.3 HTTP handlers did, so the regression test in
 *      `tests/autonomous/integration/phase-handlers-http.test.ts` keeps passing.
 *   4. Publishes `sprint.phase.completed` on success (with the result),
 *      or `sprint.phase.failed` on error (and rethrows).
 *
 * The HTTP routes in `sprint-orchestration.ts` are now thin wrappers that
 * build a `PhaseContext`, look up the handler in `PHASE_HANDLERS`, and either
 * `await` it (for synchronous phases like release/learn) or fire-and-forget
 * it via `void handler(ctx)` (for the background-async phases that the v6.3
 * HTTP routes used to launch in `void (async () => {})()` blocks).
 *
 * IMPORTANT: behaviour-preserving extraction. The regression test from
 * Task 14 captures the v6.3 HTTP contract; do not change response shapes,
 * disk side-effects, or globalStream events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime, loadAgentConfig, writeMemoryEntry, writeKnowledgeEntry, collectSprintItemTags, parseReviewFindingMetadata, extractFindingsByLevel, loadPriorGateKnownDebt, buildKnownDebtSection, resolveKnownDebt, GateRejectedError } from '@agentforge/core';
import type { RunResult, GateVerdictMetadata, ReviewFindingMetadata } from '@agentforge/core';
import { generateId, nowIso } from '@agentforge/shared';
import { globalStream } from '../routes/v5/stream.js';
import { careerHook } from './career-hook.js';
import { AutoDelegationPipeline } from './auto-delegation.js';

// ---------------------------------------------------------------------------
// Phase ordering
// ---------------------------------------------------------------------------

/**
 * Full v6.3 phase order, including the `planned` initial state and the
 * `completed` terminal state. Used by the HTTP `advance` route, which walks
 * the full ordering.
 */
export const PHASE_ORDER = [
  'planned',
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
  'completed',
] as const;

export type Phase = typeof PHASE_ORDER[number];

/**
 * The 9 phases that have a handler. The autonomous loop walks this list via
 * `nextPhase()`. `planned` and `completed` are NOT in this list — `planned`
 * is the initial state and `completed` is the terminal state.
 */
export const PHASE_SEQUENCE = [
  'audit',
  'plan',
  'assign',
  'execute',
  'test',
  'review',
  'gate',
  'release',
  'learn',
] as const;

export type PhaseName = typeof PHASE_SEQUENCE[number];

/**
 * Return the phase that follows `current`, or `null` if `current` is the
 * last phase in the sequence (`learn`) or unknown.
 */
export function nextPhase(current: PhaseName): PhaseName | null {
  const idx = PHASE_SEQUENCE.indexOf(current);
  if (idx === -1) return null;
  if (idx === PHASE_SEQUENCE.length - 1) return null;
  return PHASE_SEQUENCE[idx + 1] ?? null;
}

// ---------------------------------------------------------------------------
// Phase agent mapping (only the LLM-driven phases)
// ---------------------------------------------------------------------------

/**
 * Maps each LLM-driven phase to its agent. Phases not in this map (assign,
 * execute, release, learn) do their work without invoking an LLM agent.
 */
export const PHASE_AGENT_MAP: Partial<Record<Phase, string>> = {
  audit: 'researcher',
  plan: 'cto',
  test: 'backend-qa',
  review: 'code-reviewer',
  gate: 'ceo',
};

// ---------------------------------------------------------------------------
// Sprint file types (mirror SprintFile in sprint-orchestration.ts)
// ---------------------------------------------------------------------------

export interface SprintItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  assignee: string;
  status: 'planned' | 'in_progress' | 'completed' | 'blocked' | 'deferred';
  completedAt?: string;
  /** Domain tags used by collectSprintItemTags to enrich review/gate memory entries. */
  tags?: string[];
}

export interface PhaseAgentResult {
  phase: string;
  agentId: string;
  sessionId: string;
  response: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  status: 'completed' | 'failed';
  ranAt: string;
  error?: string;
}

export interface SprintFile {
  sprintId: string;
  version: string;
  title: string;
  createdAt: string;
  phase: string;
  items: SprintItem[];
  budget: number;
  teamSize: number;
  successCriteria: string[];
  auditFindings: string[];
  agentsInvolved?: string[];
  budgetUsed?: number;
  phaseResults?: PhaseAgentResult[];
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function sprintsDir(projectRoot: string): string {
  return join(projectRoot, '.agentforge/sprints');
}

export function sprintPath(projectRoot: string, version: string): string {
  return join(sprintsDir(projectRoot), `v${version}.json`);
}

export function readSprint(projectRoot: string, version: string): SprintFile | null {
  const file = sprintPath(projectRoot, version);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as SprintFile;
  } catch {
    return null;
  }
}

export function writeSprint(projectRoot: string, version: string, sprint: SprintFile): void {
  const dir = sprintsDir(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(sprintPath(projectRoot, version), JSON.stringify(sprint, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// EventBus contract
//
// A minimal pub-sub interface used by the future PhaseScheduler in the
// autonomous loop. The HTTP routes pass a no-op bus (see
// `createNoopBus()`) — they don't observe phase events at the HTTP layer
// (the regression test mocks `globalStream.emit` instead). When a real
// PhaseScheduler is added in a later task, it will subscribe to these
// topics for auto-advance.
// ---------------------------------------------------------------------------

export interface EventBus {
  publish(topic: PhaseTopic, payload: PhaseEventPayload): void;
}

export type PhaseTopic =
  | 'sprint.phase.started'
  | 'sprint.phase.completed'
  | 'sprint.phase.failed'
  | 'sprint.phase.item.started'
  | 'sprint.phase.item.completed'
  | 'sprint.phase.commit.step'
  | 'execute.parallelism.assessed'
  | 'execute.snapshot'
  | 'execute.circuit-breaker.tripped'
  | 'audit.memory.injected'
  | 'gate.verification.progress'
  | 'test.progress';

export interface PhaseStartedEvent {
  sprintId: string;
  sprintVersion: string;
  phase: PhaseName;
  cycleId?: string | undefined;
  startedAt: string;
}

export interface PhaseCompletedEvent {
  sprintId: string;
  sprintVersion: string;
  phase: PhaseName;
  cycleId?: string | undefined;
  result: PhaseResult;
  completedAt: string;
}

export interface PhaseFailedEvent {
  sprintId: string;
  sprintVersion: string;
  phase: PhaseName;
  cycleId?: string | undefined;
  error: string;
  failedAt: string;
}

export interface PhaseItemEvent {
  sprintId: string;
  sprintVersion: string;
  phase: PhaseName;
  cycleId?: string | undefined;
  itemId: string;
  assignee?: string | undefined;
}

export type PhaseEventPayload =
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | PhaseFailedEvent
  | PhaseItemEvent;

/**
 * No-op EventBus used by HTTP routes. Phase events are not observed at the
 * HTTP layer (the regression test mocks `globalStream.emit` instead).
 */
export function createNoopBus(): EventBus {
  return { publish: () => {} };
}

// ---------------------------------------------------------------------------
// Phase context + result
// ---------------------------------------------------------------------------

/**
 * Everything a phase handler needs to do its work. Constructed by the
 * caller (HTTP route or PhaseScheduler).
 */
export interface PhaseContext {
  /** Stable identifier of the sprint (the sprintId field in the JSON file). */
  sprintId: string;
  /** Sprint version, used for path lookup. */
  sprintVersion: string;
  /** Filesystem root for the project (.agentforge lives at $projectRoot/.agentforge). */
  projectRoot: string;
  /** Path to the .agentforge directory. */
  agentforgeDir: string;
  /** Pub-sub bus for phase lifecycle events (no-op from HTTP, real from PhaseScheduler). */
  bus: EventBus;
  /** Optional cycle id when invoked from the autonomous loop. */
  cycleId?: string;
  /**
   * Epic-mode: the operator's objective text. When set, runGatePhase delegates
   * to the structured epic-review path (writing phases/epic-review.json and
   * throwing GateRejectedError on REQUEST_CHANGES) instead of the legacy
   * signal-backlog CEO gate. Absent on normal signal cycles.
   */
  objective?: string;
  /**
   * Epic-mode: the base branch that agent worktrees were forked from.
   * Defaults to 'main' when absent.
   */
  baseBranch?: string;
}

export interface AgentRunSummary {
  agentId: string;
  sessionId: string;
  status: 'completed' | 'failed';
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

export interface SprintItemResult {
  itemId: string;
  title: string;
  assignee: string;
  status: 'completed' | 'blocked' | 'skipped';
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface PhaseResult {
  phase: PhaseName;
  status: 'completed' | 'failed' | 'blocked';
  durationMs: number;
  costUsd: number;
  agentRuns: AgentRunSummary[];
  /** Only set for the execute phase. */
  itemResults?: SprintItemResult[];
  error?: string;
  /** Phase-specific notes — e.g. delegation summary, advance target, etc. */
  notes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helper: run a phase agent via AgentRuntime.runStreaming() with SSE events
// ---------------------------------------------------------------------------

async function runPhaseAgent(opts: {
  agentId: string;
  task: string;
  version: string;
  phase: Phase;
  agentforgeDir: string;
}): Promise<{ result: RunResult; sessionId: string }> {
  const { agentId, task, version, phase, agentforgeDir } = opts;

  const config = await loadAgentConfig(agentId, agentforgeDir);
  if (!config) {
    throw new Error(`Agent "${agentId}" not found in ${agentforgeDir}/agents/`);
  }

  config.workspaceId = 'default';
  const runtime = new AgentRuntime(config);
  const sessionId = `phase-${version}-${phase}-${generateId()}`;

  globalStream.emit({
    type: 'sprint_event',
    category: 'sprint',
    message: `Sprint v${version} phase "${phase}" started — agent: ${agentId}`,
    data: {
      type: 'phase_started',
      version,
      phase,
      agentId,
      sessionId,
    },
  });

  const result = await runtime.runStreaming({
    task,
    onEvent: (event) => {
      if (event.type === 'chunk') {
        const chunkData = event.data as { text?: string; index?: number };
        globalStream.emit({
          type: 'agent_activity',
          category: 'sprint',
          message: `[${agentId}] chunk`,
          data: {
            type: 'phase_chunk',
            version,
            phase,
            agentId,
            sessionId,
            text: chunkData.text ?? '',
            index: chunkData.index ?? 0,
          },
        });
      }
    },
  });

  return { result, sessionId };
}

// ---------------------------------------------------------------------------
// Helper: post-task career hook
// ---------------------------------------------------------------------------

function fireCareerHook(agentId: string, result: RunResult, taskTitle: string): void {
  try {
    careerHook.postTaskHook(agentId, {
      taskId: result.sessionId || generateId(),
      success: result.status === 'completed',
      summary: taskTitle,
      tokensUsed: result.inputTokens + result.outputTokens,
    });
  } catch {
    // Career hook errors are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Helper: build the LLM task prompt for an agent-driven phase
// ---------------------------------------------------------------------------

/**
 * Build the LLM task prompt for an agent-driven phase.
 *
 * @param phase       - The phase being run.
 * @param sprint      - The current sprint file (used for context).
 * @param projectRoot - Optional project root path. When provided, the gate
 *   phase reads the most recent gate-verdict JSONL entry and injects a
 *   known-debt section so the CEO agent can distinguish pre-existing issues
 *   from genuine new regressions — reducing false-positive REJECTs.
 */
function buildLlmPhaseTask(phase: PhaseName, sprint: SprintFile, projectRoot?: string): string {
  const version = sprint.version;
  const itemTitles = sprint.items.map((i) => i.title).join(', ');

  switch (phase) {
    case 'audit':
      return `Audit the codebase and identify issues for sprint "${sprint.title}" (v${version}). Focus on code quality, technical debt, security vulnerabilities, and performance bottlenecks. Provide a structured list of findings.`;
    case 'plan':
      return `Create a technical plan for the following sprint items: ${itemTitles}. Sprint: "${sprint.title}" (v${version}). Provide implementation approach, dependencies, risks, and effort estimates for each item.`;
    case 'test':
      return `Run the test suite and report results for sprint v${version}: "${sprint.title}". Check coverage, identify failing tests, and summarise overall quality gate status.`;
    case 'review':
      return `Review all code changes from sprint v${version}: "${sprint.title}". Evaluate code quality, adherence to patterns, test coverage, and readiness for release.`;
    case 'gate': {
      const lastPhaseResults = sprint.phaseResults ?? [];
      const testResult = lastPhaseResults.filter((r) => r.phase === 'test').pop();
      const reviewResult = lastPhaseResults.filter((r) => r.phase === 'review').pop();
      const testSummary = testResult?.response?.slice(0, 500) ?? 'No test results available';
      const reviewSummary = reviewResult?.response?.slice(0, 500) ?? 'No review results available';

      // Inject known-debt from the most recent gate-verdict JSONL entry so the
      // CEO agent can distinguish pre-existing debt from new regressions.
      // Returns '' when there is no prior verdict or no findings to surface.
      const priorGateCtx = projectRoot ? loadPriorGateKnownDebt(projectRoot) : null;
      const knownDebtSection = buildKnownDebtSection(priorGateCtx);

      // When known debt is present, append an explicit cross-reference so the
      // CEO agent's REJECT criteria are scoped exclusively to sprint-introduced
      // findings — findings in the known-debt list must not independently drive REJECT.
      const allFindings = [
        ...(priorGateCtx?.criticalFindings ?? []),
        ...(priorGateCtx?.majorFindings ?? []),
      ];
      const knownDebtCrossRef =
        allFindings.length > 0
          ? '\n\nIMPORTANT: Any finding listed in the "Known pre-existing debt" section above is accepted pre-existing debt from a prior cycle. It MUST NOT independently drive a REJECT verdict — even if it still reproduces. Only findings that are both unresolved AND absent from the known-debt list are valid REJECT grounds.'
          : '';

      return `Approve or reject sprint v${version}: "${sprint.title}" based on the following results.\n\nTest results: ${testSummary}\n\nCode review: ${reviewSummary}\n${knownDebtSection}\nProvide a clear APPROVE or REJECT decision with rationale.${knownDebtCrossRef}`;
    }
    default:
      return `Execute phase "${phase}" for sprint v${version}: "${sprint.title}".`;
  }
}

// ---------------------------------------------------------------------------
// Generic LLM phase runner — used by audit/plan/test/review/gate.
//
// Mirrors the v6.3 background block in sprint-orchestration.ts:
// 1. Run the phase agent
// 2. Fire career hook
// 3. Re-read sprint, append phaseResult, update budgetUsed, track agent
// 4. On success, advance sprint.phase to the next phase
// 5. Persist sprint
// 6. Emit sprint_event for completed/failed
// ---------------------------------------------------------------------------

async function runLlmPhase(
  ctx: PhaseContext,
  phase: PhaseName,
): Promise<PhaseResult> {
  const startedAt = nowIso();
  const startMs = Date.now();

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt,
  });

  const sprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
  if (!sprint) {
    const error = `Sprint v${ctx.sprintVersion} not found`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error,
      failedAt: nowIso(),
    });
    throw new Error(error);
  }

  const agentId = PHASE_AGENT_MAP[phase];
  if (!agentId) {
    const error = `No agent configured for phase "${phase}"`;
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error,
      failedAt: nowIso(),
    });
    throw new Error(error);
  }

  const task = buildLlmPhaseTask(phase, sprint, ctx.projectRoot);
  const currentIdx = PHASE_ORDER.indexOf(phase);

  try {
    const { result, sessionId } = await runPhaseAgent({
      agentId,
      task,
      version: ctx.sprintVersion,
      phase,
      agentforgeDir: ctx.agentforgeDir,
    });

    // Post-task career hook
    fireCareerHook(agentId, result, `Sprint v${ctx.sprintVersion} phase ${phase}`);

    // Store phase result in sprint file (re-read for freshness)
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    if (freshSprint) {
      if (!freshSprint.phaseResults) freshSprint.phaseResults = [];

      const phaseResult: PhaseAgentResult = {
        phase,
        agentId,
        sessionId,
        response: result.response,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        status: result.status,
        ranAt: nowIso(),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
      freshSprint.phaseResults.push(phaseResult);

      // Update cumulative cost
      freshSprint.budgetUsed = (freshSprint.budgetUsed ?? 0) + result.costUsd;

      // Track agent
      if (!freshSprint.agentsInvolved) freshSprint.agentsInvolved = [];
      if (!freshSprint.agentsInvolved.includes(agentId)) {
        freshSprint.agentsInvolved.push(agentId);
      }

      // Advance to next phase on success
      if (result.status === 'completed') {
        const advanceTo = PHASE_ORDER[currentIdx + 1] as Phase;
        freshSprint.phase = advanceTo;
      }

      writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);

      if (result.status === 'completed') {
        const advanceTo = PHASE_ORDER[currentIdx + 1] as Phase;
        globalStream.emit({
          type: 'sprint_event',
          category: 'sprint',
          message: `Sprint v${ctx.sprintVersion} phase "${phase}" completed (cost: $${result.costUsd.toFixed(4)}) — advanced to "${advanceTo}"`,
          data: {
            type: 'phase_completed',
            version: ctx.sprintVersion,
            phase,
            nextPhase: advanceTo,
            agentId,
            sessionId,
            costUsd: result.costUsd,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
          },
        });
      } else {
        globalStream.emit({
          type: 'sprint_event',
          category: 'sprint',
          message: `Sprint v${ctx.sprintVersion} phase "${phase}" failed: ${result.error ?? 'unknown error'}`,
          data: {
            type: 'phase_failed',
            version: ctx.sprintVersion,
            phase,
            agentId,
            sessionId,
            error: result.error,
          },
        });
      }
    }

    const phaseResult: PhaseResult = {
      phase,
      status: result.status === 'completed' ? 'completed' : 'failed',
      durationMs: Date.now() - startMs,
      costUsd: result.costUsd,
      agentRuns: [
        {
          agentId,
          sessionId,
          status: result.status,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          durationMs: Date.now() - startMs,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      ],
      ...(result.error !== undefined ? { error: result.error } : {}),
    };

    if (result.status === 'completed') {
      ctx.bus.publish('sprint.phase.completed', {
        sprintId: ctx.sprintId,
        sprintVersion: ctx.sprintVersion,
        phase,
        cycleId: ctx.cycleId,
        result: phaseResult,
        completedAt: nowIso(),
      });
    } else {
      ctx.bus.publish('sprint.phase.failed', {
        sprintId: ctx.sprintId,
        sprintVersion: ctx.sprintVersion,
        phase,
        cycleId: ctx.cycleId,
        error: result.error ?? 'unknown error',
        failedAt: nowIso(),
      });
    }

    return phaseResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${ctx.sprintVersion} phase "${phase}" failed: ${message.slice(0, 200)}`,
      data: {
        type: 'phase_failed',
        version: ctx.sprintVersion,
        phase,
        agentId,
        error: message,
      },
    });

    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Phase handlers — one per phase
// ---------------------------------------------------------------------------

export async function runAuditPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const result = await runLlmPhase(ctx, 'audit');

  // Persist entity-like terms extracted from the audit findings to the
  // knowledge graph store (.agentforge/knowledge/entities.jsonl).
  // This is one of the two write hooks that populates the /knowledge page —
  // without it the in-memory KnowledgeGraph the server exposes is always empty.
  // The sprint file is re-read because runLlmPhase persists the agent response
  // there, making it the authoritative source for the audit output text.
  try {
    const sprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    const auditText =
      (sprint?.phaseResults ?? [])
        .filter((r) => r.phase === 'audit')
        .at(-1)?.response ?? '';

    if (auditText) {
      writeKnowledgeEntry(ctx.projectRoot, {
        text: auditText,
        source: 'audit',
        tags: [`sprint:v${ctx.sprintVersion}`, 'audit-findings'],
        cycleId: ctx.cycleId,
      });
    }
  } catch {
    // Non-fatal — phase result must not be affected by knowledge write failures.
  }

  return result;
}

export async function runPlanPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'plan');
}

export async function runTestPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'test');
}

export async function runReviewPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const phase: PhaseName = 'review';

  // P0.6 — on the objective/epic path there is exactly ONE scheduled review
  // call: the strong-model epic review that runs at the gate slot
  // (runServerEpicGate). Skip the per-diff code-reviewer dispatch here so the
  // epic path does not pay for two reviews. Legacy (signal) cycles are
  // untouched. Mirrors core's runReviewPhase objective-skip (review-phase.ts).
  if (ctx.objective !== undefined) {
    const startMs = Date.now();

    ctx.bus.publish('sprint.phase.started', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      startedAt: nowIso(),
    });

    const durationMs = Date.now() - startMs;
    const skipResult: PhaseResult = {
      phase,
      status: 'completed',
      durationMs,
      costUsd: 0,
      agentRuns: [],
    };

    if (ctx.cycleId) {
      try {
        const phasesDir = join(ctx.agentforgeDir, 'cycles', ctx.cycleId, 'phases');
        mkdirSync(phasesDir, { recursive: true });
        writeFileSync(
          join(phasesDir, 'review.json'),
          JSON.stringify(
            {
              phase,
              skipped: true,
              reason: 'epic path — single strong-model epic review runs at the gate slot',
              costUsd: 0,
            },
            null,
            2,
          ),
          'utf-8',
        );
      } catch {
        // Non-fatal — skip result must not depend on artifact write success.
      }
    }

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      result: skipResult,
      completedAt: nowIso(),
    });

    return skipResult;
  }

  const result = await runLlmPhase(ctx, 'review');

  // Write review-finding memory entries for CRITICAL and MAJOR findings so the
  // next cycle's audit phase can surface recurring anti-patterns. The sprint
  // file is re-read after the LLM phase because runLlmPhase persists the
  // agent response there (same pattern as runGatePhase for gate-verdict).
  //
  // One entry per finding line so the execute-phase memory injector can match
  // individual findings to future sprint items via overlapping domain tags.
  // Domain tags from the sprint items are appended so cross-cycle matching
  // works — without them, review findings carry only structural tags that
  // never overlap with sprint item domain tags (memory, execute, backend, ...).
  try {
    const sprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    const reviewText =
      (sprint?.phaseResults ?? [])
        .filter((r) => r.phase === 'review')
        .at(-1)?.response ?? '';

    if (reviewText) {
      const criticalFindings = extractFindingsByLevel(reviewText, 'CRITICAL');
      const majorFindings = extractFindingsByLevel(reviewText, 'MAJOR');
      const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion);

      for (const line of criticalFindings) {
        const metadata: ReviewFindingMetadata = parseReviewFindingMetadata(line, 'CRITICAL');
        writeMemoryEntry(ctx.projectRoot, {
          type: 'review-finding',
          value: line,
          metadata,
          ...(ctx.cycleId !== undefined ? { source: ctx.cycleId } : {}),
          tags: ['review', 'finding', 'critical', `sprint:v${ctx.sprintVersion}`, ...sprintDomainTags],
        });
      }
      for (const line of majorFindings) {
        const metadata: ReviewFindingMetadata = parseReviewFindingMetadata(line, 'MAJOR');
        writeMemoryEntry(ctx.projectRoot, {
          type: 'review-finding',
          value: line,
          metadata,
          ...(ctx.cycleId !== undefined ? { source: ctx.cycleId } : {}),
          tags: ['review', 'finding', 'major', `sprint:v${ctx.sprintVersion}`, ...sprintDomainTags],
        });
      }

      // Persist entity-like terms extracted from the full review text to the
      // knowledge graph store (.agentforge/knowledge/entities.jsonl).
      // This completes the write path for the review phase: cycle output →
      // entity extraction → on-disk KG → server hydration on next restart.
      writeKnowledgeEntry(ctx.projectRoot, {
        text: reviewText,
        source: 'review',
        tags: [`sprint:v${ctx.sprintVersion}`, 'code-review', ...sprintDomainTags],
        cycleId: ctx.cycleId,
      });
    }
  } catch {
    // Non-fatal — phase result must not be affected by memory write failures.
  }

  return result;
}

// Note: finding extraction now delegates to extractFindingsByLevel from
// @agentforge/core, which uses an anchored regex to prevent false positives
// from narrative prose ("no major concerns", "not a critical path change").

// ---------------------------------------------------------------------------
// Epic-gate helpers — used by runGatePhase when ctx.objective is set.
// Mirrors the objective-path delegation in core's runGatePhase → runEpicReview
// (packages/core/src/autonomous/phase-handlers/epic-review.ts). runEpicReview
// is intentionally not exported from the @agentforge/core barrel (it is imported
// dynamically within core), so the equivalent logic is implemented here for the
// server-side gate path. GateRejectedError IS exported from @agentforge/core.
// ---------------------------------------------------------------------------

interface EpicReviewFaultedItemServer {
  itemId: string;
  reason: string;
  files: string[];
}

interface EpicVerdictServer {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';
  rationale: string;
  faultedItems: EpicReviewFaultedItemServer[];
}

interface EpicReviewArtifactServer {
  phase: 'gate';
  mode: 'epic-review';
  cycleId: string;
  attempt: number;
  verdict: EpicVerdictServer['verdict'];
  rationale: string;
  faultedItems: EpicReviewFaultedItemServer[];
  schemaValidationOk: boolean;
  triageUsed: boolean;
  costUsd: number;
  durationMs: number;
  completedAt: string;
}

/**
 * Walk balanced braces from startIdx, return the enclosing JSON object string.
 * Returns null when braces are unbalanced.
 */
function extractFirstJsonObject(text: string, startIdx: number): string | null {
  let depth = 0;
  let end = -1;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  return text.slice(startIdx, end + 1);
}

function coerceEpicFaultedItems(raw: unknown): EpicReviewFaultedItemServer[] {
  if (!Array.isArray(raw)) return [];
  const out: EpicReviewFaultedItemServer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e['itemId'] !== 'string' || e['itemId'].length === 0) continue;
    out.push({
      itemId: e['itemId'],
      reason: typeof e['reason'] === 'string' ? e['reason'] : '',
      files: Array.isArray(e['files'])
        ? (e['files'] as unknown[]).filter((f): f is string => typeof f === 'string')
        : [],
    });
  }
  return out;
}

/** Attempt to parse a single JSON fragment as an epic verdict. */
function tryCoerceEpicVerdict(fragment: string): EpicVerdictServer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fragment);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (!('verdict' in p)) return null;
  const v = String(p['verdict']).toUpperCase();
  if (v !== 'APPROVE' && v !== 'REQUEST_CHANGES') return null;
  const rationale = typeof p['rationale'] === 'string' ? p['rationale'] : '';
  const faultedItems = coerceEpicFaultedItems(p['faultedItems']);
  return { verdict: v as 'APPROVE' | 'REQUEST_CHANGES', rationale, faultedItems };
}

/**
 * Parse an APPROVE/REQUEST_CHANGES verdict from raw agent output.
 * Mirrors the salvage chain in core/epic-review.ts (salvageEpicReview).
 * Returns TRIAGE when the output is unparseable even after all salvage attempts.
 */
function parseEpicVerdictInline(raw: string): EpicVerdictServer {
  // 1. Full-text strict JSON parse.
  const direct = tryCoerceEpicVerdict(raw);
  if (direct) return direct;

  // 2. ```json fenced blocks.
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  for (const m of raw.matchAll(fenceRe)) {
    const body = (m[1] ?? '').trim();
    if (!body.includes('"verdict"')) continue;
    const fromFence = tryCoerceEpicVerdict(body);
    if (fromFence) return fromFence;
    const openIdx = body.indexOf('{');
    if (openIdx >= 0) {
      const balanced = extractFirstJsonObject(body, openIdx);
      if (balanced) {
        const fromBalanced = tryCoerceEpicVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
  }

  // 3. Balanced-brace walk from every '{' that precedes a "verdict" key.
  let idx = raw.indexOf('{');
  while (idx >= 0) {
    if (raw.slice(idx, idx + 8192).includes('"verdict"')) {
      const balanced = extractFirstJsonObject(raw, idx);
      if (balanced) {
        const fromBalanced = tryCoerceEpicVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
    idx = raw.indexOf('{', idx + 1);
  }

  // 4. Fallback TRIAGE — the deterministic VERIFY stage is the release authority.
  return {
    verdict: 'TRIAGE',
    rationale:
      '[TRIAGE — review output unparseable; deterministic VERIFY remains the release authority]',
    faultedItems: [],
  };
}

/**
 * P0.6 server-side — Run the epic-path gate when ctx.objective is set.
 *
 * Writes phases/epic-review.json (same artifact shape as core's runEpicReview),
 * then throws GateRejectedError on REQUEST_CHANGES so the cycle-runner retry
 * loop re-runs the faulted items. Returns a completed PhaseResult on
 * APPROVE or TRIAGE.
 */
async function runServerEpicGate(ctx: PhaseContext): Promise<PhaseResult> {
  const phase: PhaseName = 'gate';
  const startMs = Date.now();
  const agentId = 'ceo';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt: nowIso(),
  });

  // Load integration context (best-effort) from phases/execute.json.
  const baseBranch = ctx.baseBranch ?? 'main';
  let epicBranch: string | null = null;
  let epicId: string | null = null;
  if (ctx.cycleId) {
    const executePath = join(
      ctx.agentforgeDir,
      'cycles',
      ctx.cycleId,
      'phases',
      'execute.json',
    );
    if (existsSync(executePath)) {
      try {
        const executeData = JSON.parse(readFileSync(executePath, 'utf-8')) as Record<string, unknown>;
        const integ = executeData['epicIntegration'] as
          | Record<string, unknown>
          | undefined;
        if (integ && typeof integ['branch'] === 'string') {
          epicBranch = integ['branch'];
          epicId = typeof integ['epicId'] === 'string' ? integ['epicId'] : null;
        }
      } catch {
        // Non-fatal — fall back to defaults.
      }
    }
  }
  const branch = epicBranch ?? `codex/${ctx.cycleId ?? 'epic'}`;
  const epId = epicId ?? (ctx.cycleId ?? 'unknown');
  const objective = ctx.objective ?? '';

  const task =
    `You are the CEO of AgentForge reviewing a completed epic as ONE coherent feature for release.\n\n` +
    `## Operator objective\n${objective}\n\n` +
    `## Epic\nEpic id: ${epId}\nIntegration branch: ${branch}\nBase branch: ${baseBranch}\n\n` +
    `## How to review\n` +
    `This epic accumulated every child's work onto the single integration branch \`${branch}\`. ` +
    `Review the WHOLE branch as one feature against the operator objective above.\n\n` +
    `Inspect read-only with Bash: ` +
    `\`git diff $(git merge-base ${baseBranch} ${branch})...${branch}\`\n\n` +
    `## Verdict rules\n` +
    `- APPROVE when the integration branch satisfies the operator objective — polish is not a release blocker.\n` +
    `- REQUEST_CHANGES only when a required behavior is unimplemented, a child's work is absent, ` +
    `or the branch has a concrete defect that breaks the feature.\n` +
    `- Every entry in faultedItems MUST carry an exact itemId from the plan plus a concrete reason and the files involved.\n\n` +
    `Respond ONLY with this JSON object (no prose, no code fence):\n` +
    `{"verdict":"APPROVE"|"REQUEST_CHANGES","rationale":"...","faultedItems":[{"itemId":"...","reason":"...","files":["..."]}]}\n` +
    `An APPROVE carries an empty faultedItems array.`;

  // Run the CEO agent via the existing server infrastructure.
  let agentRunResult: { result: RunResult; sessionId: string };
  try {
    agentRunResult = await runPhaseAgent({
      agentId,
      task,
      version: ctx.sprintVersion,
      phase,
      agentforgeDir: ctx.agentforgeDir,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${ctx.sprintVersion} epic gate failed: ${message.slice(0, 200)}`,
      data: { type: 'phase_failed', version: ctx.sprintVersion, phase, error: message },
    });
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });
    throw err;
  }

  const { result: runResult, sessionId } = agentRunResult;
  const durationMs = Date.now() - startMs;

  // Parse the structured verdict from the agent response.
  const verdictObj = parseEpicVerdictInline(runResult.response);

  // Store the phase result in the sprint file (same pattern as runLlmPhase).
  try {
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    if (freshSprint) {
      if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
      freshSprint.phaseResults.push({
        phase,
        agentId,
        sessionId,
        response: runResult.response,
        costUsd: runResult.costUsd,
        inputTokens: runResult.inputTokens,
        outputTokens: runResult.outputTokens,
        status: verdictObj.verdict === 'REQUEST_CHANGES' ? 'failed' : 'completed',
        ranAt: nowIso(),
      });
      freshSprint.budgetUsed = (freshSprint.budgetUsed ?? 0) + runResult.costUsd;
      if (!freshSprint.agentsInvolved) freshSprint.agentsInvolved = [];
      if (!freshSprint.agentsInvolved.includes(agentId)) {
        freshSprint.agentsInvolved.push(agentId);
      }
      // Only advance the phase on a non-rejection outcome.
      if (verdictObj.verdict !== 'REQUEST_CHANGES') {
        const currentIdx = PHASE_ORDER.indexOf(phase);
        freshSprint.phase = PHASE_ORDER[currentIdx + 1] as Phase;
      }
      writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);
    }
  } catch {
    // Non-fatal — gate outcome must not depend on sprint-file write success.
  }

  // Write phases/epic-review.json (mirrors core's writeEpicReviewArtifact).
  if (ctx.cycleId) {
    try {
      const artifact: EpicReviewArtifactServer = {
        phase: 'gate',
        mode: 'epic-review',
        cycleId: ctx.cycleId,
        attempt: 0,
        verdict: verdictObj.verdict,
        rationale: verdictObj.rationale,
        faultedItems: verdictObj.faultedItems,
        schemaValidationOk: false,
        triageUsed: verdictObj.verdict === 'TRIAGE',
        costUsd: runResult.costUsd,
        durationMs,
        completedAt: nowIso(),
      };
      const phasesDir = join(ctx.agentforgeDir, 'cycles', ctx.cycleId, 'phases');
      mkdirSync(phasesDir, { recursive: true });
      writeFileSync(
        join(phasesDir, 'epic-review.json'),
        JSON.stringify(artifact, null, 2),
        'utf-8',
      );
    } catch {
      // Non-fatal.
    }
  }

  // Write a gate-verdict memory entry (mirrors core's writeGateVerdictMemory).
  try {
    const memVerdict: 'approved' | 'rejected' | 'pending' =
      verdictObj.verdict === 'APPROVE'
        ? 'approved'
        : verdictObj.verdict === 'REQUEST_CHANGES'
          ? 'rejected'
          : 'pending';
    const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion);
    const gateMetadata: GateVerdictMetadata = {
      cycleId: ctx.cycleId ?? '',
      verdict: memVerdict,
      rationale: verdictObj.rationale.slice(0, 500),
      criticalFindings: verdictObj.faultedItems.map((f) => `[${f.itemId}] ${f.reason}`),
      majorFindings: [],
    };
    const summaryParts: string[] = [
      `Epic review ${memVerdict}: ${verdictObj.rationale.slice(0, 500)}`,
    ];
    if (verdictObj.faultedItems.length > 0) {
      summaryParts.push(
        `Faulted: ${verdictObj.faultedItems.map((f) => `[${f.itemId}] ${f.reason}`).join('; ')}`,
      );
    }
    writeMemoryEntry(ctx.projectRoot, {
      type: 'gate-verdict',
      value: summaryParts.join('. '),
      metadata: gateMetadata,
      ...(ctx.cycleId !== undefined ? { source: ctx.cycleId } : {}),
      tags: [
        `sprint:v${ctx.sprintVersion}`,
        `verdict:${memVerdict}`,
        'epic-review',
        ...sprintDomainTags,
      ],
    });
  } catch {
    // Non-fatal.
  }

  // Emit SSE event.
  const sseOutcome = verdictObj.verdict === 'REQUEST_CHANGES' ? 'rejected' : 'approved';
  globalStream.emit({
    type: 'sprint_event',
    category: 'sprint',
    message: `Sprint v${ctx.sprintVersion} epic gate ${sseOutcome}: ${verdictObj.rationale.slice(0, 200)}`,
    data: {
      type: verdictObj.verdict === 'REQUEST_CHANGES' ? 'phase_failed' : 'phase_completed',
      version: ctx.sprintVersion,
      phase,
      epicReview: true,
      verdict: verdictObj.verdict,
      agentId,
      sessionId,
      costUsd: runResult.costUsd,
    },
  });

  const phaseResult: PhaseResult = {
    phase,
    status: verdictObj.verdict === 'REQUEST_CHANGES' ? 'failed' : 'completed',
    durationMs,
    costUsd: runResult.costUsd,
    agentRuns: [
      {
        agentId,
        sessionId,
        status: verdictObj.verdict === 'REQUEST_CHANGES' ? 'failed' : 'completed',
        costUsd: runResult.costUsd,
        inputTokens: runResult.inputTokens,
        outputTokens: runResult.outputTokens,
        durationMs,
        ...(verdictObj.verdict === 'REQUEST_CHANGES'
          ? { error: verdictObj.rationale }
          : {}),
      },
    ],
    notes: { epicReview: true, verdict: verdictObj.verdict },
    ...(verdictObj.verdict === 'REQUEST_CHANGES'
      ? { error: verdictObj.rationale }
      : {}),
  };

  // REQUEST_CHANGES: write artifacts then throw so the cycle-runner retry loop
  // fires and re-executes only the faulted plan items.
  if (verdictObj.verdict === 'REQUEST_CHANGES') {
    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: verdictObj.rationale,
      failedAt: nowIso(),
    });
    throw new GateRejectedError(verdictObj.rationale);
  }

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: nowIso(),
  });

  return phaseResult;
}

export async function runGatePhase(ctx: PhaseContext): Promise<PhaseResult> {
  // P0.6 — on the objective/epic path, replace the legacy CEO gate with a
  // structured epic-review (mirrors core's gate-phase.ts objective delegation).
  if (ctx.objective !== undefined) {
    return runServerEpicGate(ctx);
  }

  // Capture any pre-existing gate verdict before the LLM re-evaluates.
  // When a prior gate result exists (e.g. seeded from a previous cycle), we
  // use that as the authoritative verdict for the memory entry so the
  // cross-cycle audit can see the actual decision that was committed.
  const sprintBefore = readSprint(ctx.projectRoot, ctx.sprintVersion);
  const preGateResults = (sprintBefore?.phaseResults ?? []).filter(
    (r) => r.phase === 'gate',
  );
  const existingVerdictResult = preGateResults.at(-1) ?? null;

  // Grab the review-phase text for finding extraction (before the run, while
  // the sprint file still reflects the pre-gate state).
  const reviewText =
    (sprintBefore?.phaseResults ?? [])
      .filter((r) => r.phase === 'review')
      .at(-1)?.response ?? '';

  const result = await runLlmPhase(ctx, 'gate');

  // Determine the verdict text: prefer the pre-existing result so that a
  // re-run of the gate phase doesn't silently overwrite the original decision.
  // When this is the first gate run (no prior result), fall back to the newly
  // written sprint entry (last gate result after the LLM call).
  try {
    let verdictText: string;
    if (existingVerdictResult) {
      verdictText = existingVerdictResult.response;
    } else {
      const sprintAfter = readSprint(ctx.projectRoot, ctx.sprintVersion);
      const allGateResults = (sprintAfter?.phaseResults ?? []).filter(
        (r) => r.phase === 'gate',
      );
      verdictText = allGateResults.at(-1)?.response ?? '';
    }

    const isApprove = /\bAPPROVE\b/i.test(verdictText);
    // Use the canonical GateVerdictMetadata verdict shape ('approved'/'rejected').
    const verdictNorm: 'approved' | 'rejected' = isApprove ? 'approved' : 'rejected';
    const verdictTag = `verdict:${verdictNorm}`;

    // Extract structured findings from the review phase output so the next
    // audit cycle can surface specific issues — not just the plain rationale.
    const criticalFindings = extractFindingsByLevel(reviewText, 'CRITICAL');
    const majorFindings = extractFindingsByLevel(reviewText, 'MAJOR');

    // Build the canonical GateVerdictMetadata — consumed by audit-phase prompt
    // injection and flywheel stats. The metadata field carries structured data;
    // the value field is a human-readable summary for direct prompt rendering.
    //
    // Resolve the knownDebt list that THIS gate treated as pre-existing accepted
    // debt. The same `resolveKnownDebt` read that drives the prompt's known-debt
    // section is mirrored into the metadata write so the NEXT cycle's gate can
    // tell apart:
    //   - Items in `knownDebt` → pre-existing before this sprint ran → warn only
    //   - Items in `criticalFindings`/`majorFindings` but NOT in `knownDebt`
    //     → newly surfaced in this sprint's review → valid reject grounds
    //
    // Without this write, post-server-gate cycles see only the coarse
    // criticalFindings+majorFindings fallback, which conflates pre-existing
    // debt with sprint-introduced regressions and produces false-positive
    // REJECTs — the exact failure mode this sprint item targets.
    const rationale = verdictText.slice(0, 500);
    const knownDebt = resolveKnownDebt(ctx.projectRoot);
    const gateMetadata: GateVerdictMetadata = {
      cycleId: ctx.cycleId ?? '',
      verdict: verdictNorm,
      rationale,
      criticalFindings,
      majorFindings,
      // Conditional spread so the field is absent (not undefined) on entries
      // where no prior debt was inherited — required by exactOptionalPropertyTypes.
      ...(knownDebt.length > 0 ? { knownDebt } : {}),
    };

    const summaryParts: string[] = [`Gate ${verdictNorm}: ${rationale}`];
    if (criticalFindings.length > 0) {
      summaryParts.push(`Critical: ${criticalFindings.join('; ')}`);
    }
    if (majorFindings.length > 0) {
      summaryParts.push(`Major: ${majorFindings.join('; ')}`);
    }

    // Collect sprint item domain tags so the execute-phase memory injector can
    // match this gate verdict to future items whose domain tags overlap with the
    // sprint that produced it. Without domain tags, the verdict carries only
    // structural tags (sprint:v*, verdict:*) that never overlap with item domain
    // tags (memory, execute, backend, ...), silently breaking cross-cycle learning.
    const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion);

    writeMemoryEntry(ctx.projectRoot, {
      type: 'gate-verdict',
      value: summaryParts.join('. '),
      metadata: gateMetadata,
      ...(ctx.cycleId !== undefined ? { source: ctx.cycleId } : {}),
      tags: [`sprint:v${ctx.sprintVersion}`, verdictTag, ...sprintDomainTags],
    });
  } catch {
    // Non-fatal — gate result must not be affected by memory write failures.
  }

  return result;
}

// ---------------------------------------------------------------------------
// runAssignPhase — auto-delegation, no LLM
// ---------------------------------------------------------------------------

export async function runAssignPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = nowIso();
  const startMs = Date.now();
  const phase: PhaseName = 'assign';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt,
  });

  try {
    const sprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    if (!sprint) {
      throw new Error(`Sprint v${ctx.sprintVersion} not found`);
    }

    const currentIdx = PHASE_ORDER.indexOf(phase);

    const pipeline = new AutoDelegationPipeline();
    const delegationResult = pipeline.delegateSprint(
      sprint.items.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        assignee: item.assignee,
        status: item.status,
      })),
    );

    // Apply assignments back to sprint items
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    if (freshSprint) {
      for (const [agentAssignee, itemIds] of delegationResult.assignments) {
        for (const itemId of itemIds) {
          const freshItem = freshSprint.items.find((i) => i.id === itemId);
          if (freshItem && !freshItem.assignee) {
            freshItem.assignee = agentAssignee;
          }
        }
      }

      // Store phase result
      if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
      freshSprint.phaseResults.push({
        phase,
        agentId: 'auto-delegation',
        sessionId: `phase-${ctx.sprintVersion}-assign-${generateId()}`,
        response: JSON.stringify({
          steps: delegationResult.steps.length,
          assignments: Object.fromEntries(delegationResult.assignments),
          unassigned: delegationResult.unassigned,
        }),
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed',
        ranAt: nowIso(),
      });

      // Advance to next phase
      const advanceTo = PHASE_ORDER[currentIdx + 1] as Phase;
      freshSprint.phase = advanceTo;
      writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);

      globalStream.emit({
        type: 'sprint_event',
        category: 'sprint',
        message: `Sprint v${ctx.sprintVersion} phase "assign" completed — auto-delegated ${delegationResult.assignments.size} assignments, advanced to "${advanceTo}"`,
        data: {
          type: 'phase_completed',
          version: ctx.sprintVersion,
          phase,
          nextPhase: advanceTo,
          assignmentCount: delegationResult.assignments.size,
          unassignedCount: delegationResult.unassigned.length,
        },
      });
    }

    const result: PhaseResult = {
      phase,
      status: 'completed',
      durationMs: Date.now() - startMs,
      costUsd: 0,
      agentRuns: [],
      notes: {
        assignmentCount: delegationResult.assignments.size,
        unassignedCount: delegationResult.unassigned.length,
        steps: delegationResult.steps.length,
      },
    };

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${ctx.sprintVersion} phase "assign" failed: ${message.slice(0, 200)}`,
      data: {
        type: 'phase_failed',
        version: ctx.sprintVersion,
        phase,
        error: message,
      },
    });

    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// runExecutePhase — mark planned items as in_progress, fire-and-forget agent runs
//
// This handler covers BOTH the v6.3 `POST /execute` route AND the
// `/run-phase` execute branch. The v6.3 /execute route also dispatches
// per-item agent runs as `void (async () => {})()` background tasks; the
// /run-phase execute branch only flips planned -> in_progress and emits a
// phase_started event. We keep the simpler /run-phase variant in the handler
// (the /execute route stays inline because its response shape and per-item
// dispatch are unique to that endpoint).
// ---------------------------------------------------------------------------

export async function runExecutePhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = nowIso();
  const startMs = Date.now();
  const phase: PhaseName = 'execute';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt,
  });

  try {
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);
    if (!freshSprint) {
      throw new Error(`Sprint v${ctx.sprintVersion} not found`);
    }

    const plannedItems = freshSprint.items.filter((i) => i.status === 'planned');
    for (const item of plannedItems) {
      item.status = 'in_progress';
    }
    writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${ctx.sprintVersion} execute phase — ${plannedItems.length} items moved to in_progress`,
      data: {
        type: 'phase_started',
        version: ctx.sprintVersion,
        phase,
        itemCount: plannedItems.length,
      },
    });

    const result: PhaseResult = {
      phase,
      status: 'completed',
      durationMs: Date.now() - startMs,
      costUsd: 0,
      agentRuns: [],
      notes: { plannedItemCount: plannedItems.length },
    };

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    globalStream.emit({
      type: 'sprint_event',
      category: 'sprint',
      message: `Sprint v${ctx.sprintVersion} execute phase setup failed: ${message.slice(0, 200)}`,
      data: { type: 'phase_failed', version: ctx.sprintVersion, phase, error: message },
    });

    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// runReleasePhase — append "released" phase result, advance to learn
// ---------------------------------------------------------------------------

export async function runReleasePhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = nowIso();
  const startMs = Date.now();
  const phase: PhaseName = 'release';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt,
  });

  try {
    const currentIdx = PHASE_ORDER.indexOf(phase);
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);

    let advanceTo: Phase | undefined;
    if (freshSprint) {
      if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
      freshSprint.phaseResults.push({
        phase,
        agentId: 'system',
        sessionId: `phase-${ctx.sprintVersion}-release-${generateId()}`,
        response: `Sprint v${ctx.sprintVersion} released at ${nowIso()}`,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed',
        ranAt: nowIso(),
      });

      advanceTo = PHASE_ORDER[currentIdx + 1] as Phase;
      freshSprint.phase = advanceTo;
      writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);

      globalStream.emit({
        type: 'sprint_event',
        category: 'sprint',
        message: `Sprint v${ctx.sprintVersion} released — advanced to "${advanceTo}"`,
        data: { type: 'phase_completed', version: ctx.sprintVersion, phase, nextPhase: advanceTo },
      });
    }

    const result: PhaseResult = {
      phase,
      status: 'completed',
      durationMs: Date.now() - startMs,
      costUsd: 0,
      agentRuns: [],
      notes: { advanceTo },
    };

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// runLearnPhase — append final phase result, mark sprint completed
// ---------------------------------------------------------------------------

export async function runLearnPhase(ctx: PhaseContext): Promise<PhaseResult> {
  const startedAt = nowIso();
  const startMs = Date.now();
  const phase: PhaseName = 'learn';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    sprintVersion: ctx.sprintVersion,
    phase,
    cycleId: ctx.cycleId,
    startedAt,
  });

  try {
    const freshSprint = readSprint(ctx.projectRoot, ctx.sprintVersion);

    let completedItems = 0;
    let totalItems = 0;
    if (freshSprint) {
      completedItems = freshSprint.items.filter((i) => i.status === 'completed').length;
      totalItems = freshSprint.items.length;

      if (!freshSprint.phaseResults) freshSprint.phaseResults = [];
      freshSprint.phaseResults.push({
        phase,
        agentId: 'system',
        sessionId: `phase-${ctx.sprintVersion}-learn-${generateId()}`,
        response: `Sprint v${ctx.sprintVersion} completed. ${completedItems}/${totalItems} items done. Total cost: $${(freshSprint.budgetUsed ?? 0).toFixed(4)}`,
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed',
        ranAt: nowIso(),
      });

      freshSprint.phase = 'completed';
      writeSprint(ctx.projectRoot, ctx.sprintVersion, freshSprint);

      globalStream.emit({
        type: 'sprint_event',
        category: 'sprint',
        message: `Sprint v${ctx.sprintVersion} learn phase complete — sprint marked completed (${completedItems}/${totalItems} items)`,
        data: {
          type: 'phase_completed',
          version: ctx.sprintVersion,
          phase,
          nextPhase: 'completed',
          completedItems,
          totalItems,
          totalCostUsd: freshSprint.budgetUsed ?? 0,
        },
      });
    }

    const result: PhaseResult = {
      phase,
      status: 'completed',
      durationMs: Date.now() - startMs,
      costUsd: 0,
      agentRuns: [],
      notes: { completedItems, totalItems },
    };

    ctx.bus.publish('sprint.phase.completed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      result,
      completedAt: nowIso(),
    });

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    ctx.bus.publish('sprint.phase.failed', {
      sprintId: ctx.sprintId,
      sprintVersion: ctx.sprintVersion,
      phase,
      cycleId: ctx.cycleId,
      error: message,
      failedAt: nowIso(),
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// PHASE_HANDLERS lookup
// ---------------------------------------------------------------------------

export const PHASE_HANDLERS: Record<PhaseName, (ctx: PhaseContext) => Promise<PhaseResult>> = {
  audit: runAuditPhase,
  plan: runPlanPhase,
  assign: runAssignPhase,
  execute: runExecutePhase,
  test: runTestPhase,
  review: runReviewPhase,
  gate: runGatePhase,
  release: runReleasePhase,
  learn: runLearnPhase,
};

// ---------------------------------------------------------------------------
// Re-exported helpers used by sprint-orchestration.ts
// ---------------------------------------------------------------------------

export { runPhaseAgent, fireCareerHook, buildLlmPhaseTask };
