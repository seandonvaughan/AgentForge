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
import { AgentRuntime, loadAgentConfig } from '@agentforge/core';
import type { RunResult } from '@agentforge/core';
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
  | 'sprint.phase.item.completed';

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

function buildLlmPhaseTask(phase: PhaseName, sprint: SprintFile): string {
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
      return `Approve or reject sprint v${version}: "${sprint.title}" based on the following results.\n\nTest results: ${testSummary}\n\nCode review: ${reviewSummary}\n\nProvide a clear APPROVE or REJECT decision with rationale.`;
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

  const task = buildLlmPhaseTask(phase, sprint);
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
  return runLlmPhase(ctx, 'audit');
}

export async function runPlanPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'plan');
}

export async function runTestPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'test');
}

export async function runReviewPhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'review');
}

export async function runGatePhase(ctx: PhaseContext): Promise<PhaseResult> {
  return runLlmPhase(ctx, 'gate');
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
