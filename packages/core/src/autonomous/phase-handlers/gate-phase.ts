// packages/core/src/autonomous/phase-handlers/gate-phase.ts
//
// v6.5.2 — Real gate phase handler. CEO agent reviews everything that
// happened in the cycle and approves or rejects. On REJECT, throws
// GateRejectedError so the cycle runner aborts before release.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { writeMemoryEntry, readMemoryEntries, type GateVerdictMetadata } from '../../memory/types.js';
import { collectSprintItemTags } from './sprint-utils.js';

export const GATE_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];

export class GateRejectedError extends Error {
  constructor(public readonly rationale: string) {
    super(`Gate rejected: ${rationale}`);
    this.name = 'GateRejectedError';
  }
}

export interface GatePhaseOptions {
  allowedTools?: string[];
  agentId?: string;
  /**
   * Explicit list of pre-existing known-debt findings to inject into the gate
   * prompt. When provided, the JSONL file read is skipped entirely and these
   * items are used as-is. Callers can pass an empty array to suppress all
   * known-debt injection for a cycle (e.g. after a full debt-payoff sprint).
   *
   * When omitted (undefined), the known-debt list is derived automatically from
   * the most recent gate-verdict entry in `.agentforge/memory/gate-verdict.jsonl`.
   */
  knownDebt?: string[];
}

export function makeGatePhaseHandler(options: GatePhaseOptions = {}) {
  return (ctx: PhaseContext) => runGatePhase(ctx, options);
}

function tryReadJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

interface GateVerdict {
  verdict: 'APPROVE' | 'REJECT';
  rationale: string;
}

/**
 * Extract finding lines from the code-review markdown output.
 * Lines that contain a severity keyword (CRITICAL / MAJOR) are collected and
 * returned so the gate-verdict memory entry can surface them to future audits.
 *
 * The pattern is intentionally anchored to the start of the line (after
 * optional bullet decoration) to prevent false positives from narrative prose
 * that happens to contain the severity word mid-sentence (e.g. "this is not a
 * critical path change" or "No major concerns here"). Only structured finding
 * lines like "- CRITICAL: …", "MAJOR: …", or "- [CRITICAL] …" are matched.
 */
export function extractFindingsByLevel(
  reviewText: string,
  level: 'CRITICAL' | 'MAJOR',
): string[] {
  // Match lines where the severity keyword:
  //   a) appears at the start (with optional leading bullet/whitespace), or
  //   b) appears in bracket notation [CRITICAL] / [MAJOR] anywhere on the line.
  // This avoids matching mid-sentence occurrences such as "no major concerns"
  // or "this is not a critical path change".
  const pattern = new RegExp(
    `^[-*\\s]*${level}[\\s:\\[\\]]|\\[${level}\\]`,
    'i',
  );
  return reviewText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && pattern.test(l))
    .slice(0, 10); // cap to avoid bloating the memory entry
}

export function parseGateVerdict(text: string): GateVerdict {
  // Try strict JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
      const v = String(parsed.verdict).toUpperCase();
      if (v === 'APPROVE' || v === 'REJECT') {
        return {
          verdict: v,
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
        };
      }
    }
  } catch {
    // fall through
  }

  // Try to extract a JSON object from within the text
  const match = text.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
        const v = String(parsed.verdict).toUpperCase();
        if (v === 'APPROVE' || v === 'REJECT') {
          return {
            verdict: v,
            rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          };
        }
      }
    } catch {
      // fall through
    }
  }

  // Malformed: treat as REJECT with raw text as rationale
  return { verdict: 'REJECT', rationale: text || 'Malformed gate response' };
}

/**
 * Structured context extracted from the most recent gate-verdict memory entry.
 * Carries only what the gate prompt needs — verdict outcome and the finding
 * lists that the prior gate agent acted on.
 */
export interface PriorGateContext {
  cycleId: string;
  verdict: 'approved' | 'rejected' | 'pending';
  majorFindings: string[];
  criticalFindings: string[];
}

/**
 * Read the most recent gate-verdict from `.agentforge/memory/gate-verdict.jsonl`
 * and return its structured context. Returns null when no prior verdict exists
 * or the entry's metadata cannot be parsed — callers must always handle null.
 *
 * Only the metadata field is consulted (not the human-readable `value` string)
 * so this is robust to future changes in the value format.
 */
export function loadPriorGateKnownDebt(projectRoot: string): PriorGateContext | null {
  const entries = readMemoryEntries(projectRoot, 'gate-verdict', 1);
  if (entries.length === 0) return null;

  const last = entries[0]!;
  const meta = last.metadata as GateVerdictMetadata | undefined;
  if (!meta || typeof meta !== 'object') return null;

  const verdict = meta.verdict;
  if (verdict !== 'approved' && verdict !== 'rejected' && verdict !== 'pending') return null;

  return {
    cycleId: typeof meta.cycleId === 'string' ? meta.cycleId : '',
    verdict,
    majorFindings: Array.isArray(meta.majorFindings) ? meta.majorFindings : [],
    criticalFindings: Array.isArray(meta.criticalFindings) ? meta.criticalFindings : [],
  };
}

/**
 * Format a `PriorGateContext` as a markdown prompt section for injection into
 * the gate prompt. Returns an empty string when `prior` is null or carries no
 * findings — the gate prompt is unchanged in that case.
 *
 * The section is intentionally directive: it tells the CEO agent how to weight
 * each prior finding (known-accepted-debt vs. unresolved-rejection-reason) so
 * the agent can distinguish pre-existing issues from genuine new regressions.
 */
export function buildKnownDebtSection(prior: PriorGateContext | null): string {
  if (prior === null) return '';

  const allFindings = [...prior.criticalFindings, ...prior.majorFindings];
  if (allFindings.length === 0) return '';

  const label =
    prior.verdict === 'approved'
      ? `APPROVED (cycle ${prior.cycleId})`
      : `REJECTED (cycle ${prior.cycleId})`;

  const bullets = allFindings.map((f) => `- ${f}`).join('\n');

  const guidance =
    prior.verdict === 'approved'
      ? 'The prior gate APPROVED despite these findings — they are known pre-existing debt. ' +
        'Do NOT let them drive a REJECT in this cycle unless they have clearly worsened or new occurrences have been added. ' +
        'If the code review flags the same items, verify they have not regressed before treating them as grounds for rejection.'
      : 'The prior gate REJECTED partly due to these findings. ' +
        'Verify whether each has been addressed — if fixed, treat as RESOLVED and do not penalise for it; ' +
        'if still present and unaddressed, they remain valid REJECT grounds.';

  return `\n## Known pre-existing debt (prior gate verdict — ${label})\n${bullets}\n\n${guidance}\n`;
}

/**
 * Build a known-debt prompt section from a plain `string[]`. Used when the
 * caller injects the list directly via `GatePhaseOptions.knownDebt` rather
 * than having it derived from the JSONL store.
 *
 * The guidance text is intentionally the same as the "approved" path in
 * `buildKnownDebtSection` — items on this list are treated as accepted debt
 * that the CEO agent must not use to drive a REJECT unless they have clearly
 * worsened since the list was compiled.
 */
export function buildKnownDebtSectionFromList(debt: string[]): string {
  if (debt.length === 0) return '';
  const bullets = debt.map((f) => `- ${f}`).join('\n');
  return (
    `\n## Known pre-existing debt (injected)\n${bullets}\n\n` +
    `These items are pre-existing known debt accepted by a prior gate. ` +
    `Do NOT let them drive a REJECT in this cycle unless they have clearly worsened or new occurrences have been added. ` +
    `If the code review flags the same items, verify they have not regressed before treating them as grounds for rejection.\n`
  );
}

/**
 * Resolve the `knownDebt: string[]` to inject into the gate prompt.
 *
 * Priority:
 *   1. `override` — when the caller explicitly provides a list (even empty),
 *      it is returned as-is and no file I/O is performed.
 *   2. Last gate-verdict from JSONL — critical + major findings from the most
 *      recent entry in `.agentforge/memory/gate-verdict.jsonl`.
 *   3. `[]` — when no prior verdict exists or the file is unreadable.
 *
 * Exported so call sites and tests can verify the resolved list independently
 * of the full `runGatePhase` path.
 */
export function resolveKnownDebt(projectRoot: string, override?: string[]): string[] {
  if (override !== undefined) return override;
  const prior = loadPriorGateKnownDebt(projectRoot);
  if (!prior) return [];
  return [...prior.criticalFindings, ...prior.majorFindings];
}

export async function runGatePhase(
  ctx: PhaseContext,
  options: GatePhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'gate' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? GATE_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? 'ceo';

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  // Gather context from prior phases
  const phasesDir = ctx.cycleId
    ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'phases')
    : null;

  let items = '(no items)';
  let testResults = '(no test results)';
  let reviewFindings = '(no review findings)';
  let costSoFar = 0;

  try {
    // New cycles: plan.json in cycle dir. Legacy: .agentforge/sprints/v{N}.json.
    const sprintPath = ctx.cycleId
      ? join(ctx.projectRoot, '.agentforge', 'cycles', ctx.cycleId, 'plan.json')
      : join(ctx.projectRoot, '.agentforge', 'sprints', `v${ctx.sprintVersion}.json`);
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj = parsed.items ? parsed : parsed.sprints?.[0] ?? null;
    if (sprintObj?.items?.length) {
      items = sprintObj.items
        .map((i: any) => `- [${i.id}] ${i.title} (${i.status ?? 'unknown'})`)
        .join('\n');
    }
  } catch {
    // ignore
  }

  if (phasesDir) {
    const testJson = tryReadJson(join(phasesDir, 'test.json'));
    if (testJson) {
      testResults = JSON.stringify(
        {
          status: testJson.status,
          passed: testJson.passed,
          failed: testJson.failed,
          total: testJson.total,
        },
        null,
        2,
      );
    }
    const reviewJson = tryReadJson(join(phasesDir, 'review.json'));
    if (reviewJson) {
      reviewFindings =
        typeof reviewJson.findings === 'string'
          ? reviewJson.findings
          : JSON.stringify(reviewJson, null, 2);
    }

    // Sum cost across all known phase JSONs
    for (const name of ['audit', 'plan', 'assign', 'execute', 'test', 'review']) {
      const j = tryReadJson(join(phasesDir, `${name}.json`));
      if (j && typeof j.costUsd === 'number') costSoFar += j.costUsd;
    }
  }

  // Resolve the known-debt list and build the corresponding prompt section.
  //
  // When the caller explicitly provides `options.knownDebt`, that list is used
  // verbatim and no JSONL file read is performed (deterministic, test-friendly).
  // When omitted, the most recent gate-verdict entry is read and its critical +
  // major findings are extracted as the pre-existing debt list.
  //
  // This explicit `knownDebt: string[]` variable is the canonical data source
  // for debt injection — `buildKnownDebtSection` / `buildKnownDebtSectionFromList`
  // then format it into the right markdown section for the CEO agent.
  const priorGateContext =
    options.knownDebt === undefined ? loadPriorGateKnownDebt(ctx.projectRoot) : null;

  const knownDebt: string[] =
    options.knownDebt !== undefined
      ? options.knownDebt
      : priorGateContext
        ? [...priorGateContext.criticalFindings, ...priorGateContext.majorFindings]
        : [];

  // Use the richer section (with prior verdict label + tailored guidance) when
  // we have the full PriorGateContext; fall back to the plain-list section when
  // the caller injected the debt directly.
  const knownDebtSection =
    priorGateContext !== null
      ? buildKnownDebtSection(priorGateContext)
      : buildKnownDebtSectionFromList(knownDebt);

  const task = `You are the CEO of AgentForge. Sprint v${ctx.sprintVersion} has completed execution. Here is the full state:

## Sprint items
${items}

## Test results
${testResults}

## Code review findings
${reviewFindings}

## Cost so far
$${costSoFar.toFixed(4)}
${knownDebtSection}## Verification protocol — READ CAREFULLY
The code review above may have been produced against an intermediate execute-phase state. Before REJECTing on any CRITICAL or MAJOR finding, VERIFY it against the current working tree:

1. For each CRITICAL or MAJOR finding that cites a specific file/line, use Read to look at the current contents of that file.
2. Use Grep to search for the problematic pattern described in the finding.
3. If the bug no longer reproduces (the line has been amended, the pattern is absent, or the finding's premise is otherwise false in the current code), treat that finding as RESOLVED. Do NOT let a resolved finding drive REJECT.
4. Only unresolved CRITICAL or verified-still-present MAJOR findings are grounds for REJECT.

If all CRITICAL and MAJOR findings either do not reproduce or were already addressed, and tests pass, APPROVE.

In your rationale, explicitly state which findings you verified and whether each still reproduces — so downstream callers can audit the decision.

Decide: APPROVE or REJECT this sprint for release.

Respond as JSON: { "verdict": "APPROVE" | "REJECT", "rationale": "..." }`;

  // Emit verification progress event before invoking the CEO agent so the UI
  // shows the findings that will be reviewed — eliminates the "stuck on gate" UX.
  const preRunCritical = extractFindingsByLevel(reviewFindings, 'CRITICAL');
  const preRunMajor = extractFindingsByLevel(reviewFindings, 'MAJOR');
  ctx.bus.publish('gate.verification.progress', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    findingsCount: preRunCritical.length + preRunMajor.length,
    critical: preRunCritical.length,
    major: preRunMajor.length,
  });

  let response = '';
  let runCost = 0;
  let agentError: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    response = typeof result?.output === 'string' ? result.output : '';
    runCost = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    agentError = err instanceof Error ? err.message : String(err);
  }

  const verdict: GateVerdict = agentError
    ? { verdict: 'REJECT', rationale: `Agent error: ${agentError}` }
    : parseGateVerdict(response);

  const durationMs = Date.now() - startedAt;
  const phaseResult: PhaseResult = {
    phase,
    status: verdict.verdict === 'APPROVE' ? 'completed' : 'failed',
    durationMs,
    costUsd: runCost,
    agentRuns: [
      { agentId, costUsd: runCost, durationMs, response, verdict: verdict.verdict },
    ],
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'gate.json',
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
            agentId,
            verdict: verdict.verdict,
            rationale: verdict.rationale,
            costUsd: runCost,
            durationMs,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // non-fatal
    }
  }

  // Write a gate-verdict memory entry for every cycle — both APPROVE and REJECT
  // are high-signal because they record what the CEO agent found acceptable or
  // not. Future audit phases read these entries to surface recurring patterns.
  //
  // Sprint item domain tags are appended so the execute-phase injector can match
  // this verdict to future items whose domain tags overlap with the sprint that
  // produced it (e.g. a rejection in a sprint with 'memory' items warns the next
  // cycle's memory-tagged items about what caused the gate to fail).
  const criticalFindings = extractFindingsByLevel(reviewFindings, 'CRITICAL');
  const majorFindings = extractFindingsByLevel(reviewFindings, 'MAJOR');
  const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion, ctx.cycleId);

  // Normalize verdict to lowercase to match the GateVerdictMetadata contract.
  const verdictNorm: 'approved' | 'rejected' =
    verdict.verdict === 'APPROVE' ? 'approved' : 'rejected';

  const gateMetadata: GateVerdictMetadata = {
    cycleId: ctx.cycleId ?? '',
    verdict: verdictNorm,
    rationale: verdict.rationale,
    criticalFindings,
    majorFindings,
  };

  // Build a human-readable summary for the `value` field so the audit-phase
  // prompt injection renders clean bullets instead of a raw JSON blob.
  const summaryParts: string[] = [`Gate ${verdictNorm}: ${verdict.rationale}`];
  if (criticalFindings.length > 0) {
    summaryParts.push(`Critical: ${criticalFindings.join('; ')}`);
  }
  if (majorFindings.length > 0) {
    summaryParts.push(`Major: ${majorFindings.join('; ')}`);
  }

  writeMemoryEntry(ctx.projectRoot, {
    type: 'gate-verdict',
    value: summaryParts.join('. '),
    metadata: gateMetadata,
    source: ctx.cycleId,
    tags: [
      `verdict:${verdictNorm}`,
      `sprint:v${ctx.sprintVersion}`,
      ...sprintDomainTags,
    ],
  });

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  if (verdict.verdict === 'REJECT') {
    throw new GateRejectedError(verdict.rationale);
  }

  return phaseResult;
}
