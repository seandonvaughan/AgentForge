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
  /**
   * Per-request CLI subprocess timeout in milliseconds. Overrides the transport
   * default of 20 minutes (1_200_000 ms). Use for heavy reasoning tasks like the
   * gate phase which performs extensive verification and review analysis.
   */
  timeoutMs?: number;
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

/**
 * Try to parse a fragment as JSON and extract the verdict + rationale.
 * Returns null if parse fails or the result isn't a verdict object.
 */
function tryExtractVerdict(fragment: string): GateVerdict | null {
  try {
    const parsed = JSON.parse(fragment);
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
  return null;
}

/**
 * Walk forward from `startIdx` (which points at `{`) and find the matching
 * closing `}` while respecting strings and escape sequences. Returns the
 * extracted JSON-object substring or null if no balanced match exists.
 *
 * Why this exists: previous versions used a non-greedy regex
 * `\{[\s\S]*?"verdict"[\s\S]*?\}` which matched the FIRST `}` after `verdict`.
 * When the rationale contained inline JSON or markdown braces, the match
 * truncated mid-object and JSON.parse choked. This balanced-brace walker
 * extracts the actual full object.
 */
function extractBalancedJson(text: string, startIdx: number): string | null {
  if (text[startIdx] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

export function parseGateVerdict(text: string): GateVerdict {
  // 1. Whole-text strict JSON
  const direct = tryExtractVerdict(text);
  if (direct) return direct;

  // 2. Look for ```json fenced blocks (LLMs often wrap structured output in them)
  const fencedRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  for (const m of text.matchAll(fencedRe)) {
    const body = (m[1] ?? '').trim();
    if (!body.includes('"verdict"')) continue;
    const inFenced = tryExtractVerdict(body);
    if (inFenced) return inFenced;
    // Try a balanced-brace walk within the fence body too
    const openIdx = body.indexOf('{');
    if (openIdx >= 0) {
      const balanced = extractBalancedJson(body, openIdx);
      if (balanced) {
        const fromBalanced = tryExtractVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
  }

  // 3. Find every `{` that's followed somewhere by `"verdict"` and try a
  //    balanced-brace extraction starting from each. This handles responses
  //    where the agent emitted the verdict object inline without a fence.
  let idx = text.indexOf('{');
  while (idx >= 0) {
    // Cheap pre-filter: only attempt balanced parse if "verdict" appears within
    // the next ~8KB — keeps us from re-walking the whole text on every brace.
    const nextChunk = text.slice(idx, idx + 8192);
    if (nextChunk.includes('"verdict"')) {
      const balanced = extractBalancedJson(text, idx);
      if (balanced) {
        const fromBalanced = tryExtractVerdict(balanced);
        if (fromBalanced) return fromBalanced;
      }
    }
    idx = text.indexOf('{', idx + 1);
  }

  // 4. Malformed: treat as REJECT with raw text as rationale (last resort)
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
  /**
   * The explicit list of findings that were already treated as accepted
   * carry-forward debt when this prior gate ran. Present only when the
   * entry was written by a post-v17.3.0 gate (when `knownDebt` was added
   * to `GateVerdictMetadata`). When absent, consumers fall back to
   * `criticalFindings + majorFindings` for backward-compat.
   *
   * Having this field lets the next gate tell apart:
   *   - Items in `knownDebt` → pre-existing before the prior sprint ran
   *   - Items in `criticalFindings`/`majorFindings` but NOT in `knownDebt`
   *     → newly surfaced in the prior sprint's review
   */
  knownDebt?: string[];
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

  const metaTyped = meta as GateVerdictMetadata;
  return {
    cycleId: typeof meta.cycleId === 'string' ? meta.cycleId : '',
    verdict,
    majorFindings: Array.isArray(meta.majorFindings) ? meta.majorFindings : [],
    criticalFindings: Array.isArray(meta.criticalFindings) ? meta.criticalFindings : [],
    // Read the explicit knownDebt list when present (written by post-v17.3.0 gates).
    // Use a conditional spread so the property is absent (not set to undefined)
    // when the field isn't in the entry — required by exactOptionalPropertyTypes.
    ...(Array.isArray(metaTyped.knownDebt) ? { knownDebt: metaTyped.knownDebt as string[] } : {}),
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

  // Prefer the explicit `knownDebt` field (present since v17.3.0) — it contains
  // only findings that were ALREADY accepted as carry-forward debt when the prior
  // gate ran, which is a more precise "pre-existing" signal than all
  // criticalFindings + majorFindings. Some of those may have been newly surfaced
  // in the prior sprint's review and should not automatically inherit the
  // "warn-not-reject" treatment across successive cycles.
  //
  // Fallback to criticalFindings + majorFindings when `knownDebt` is absent
  // (legacy entries written before v17.3.0 that don't have the field).
  const allFindings =
    prior.knownDebt !== undefined && prior.knownDebt.length > 0
      ? prior.knownDebt
      : [...prior.criticalFindings, ...prior.majorFindings];
  if (allFindings.length === 0) return '';

  const label =
    prior.verdict === 'approved'
      ? `APPROVED (cycle ${prior.cycleId})`
      : `REJECTED (cycle ${prior.cycleId})`;

  const bullets = allFindings.map((f) => `- ${f}`).join('\n');

  // Both approved and rejected prior findings are treated as known carry-forward
  // debt for the purposes of this sprint's gate. The goal is to distinguish
  // "pre-existing issue that was known before this sprint ran" (warns only) from
  // "regression introduced by this sprint's changes" (valid REJECT ground).
  //
  // For a prior APPROVE, the CEO explicitly accepted the debt — clearly should
  // not block again unless it has worsened.
  //
  // For a prior REJECT, the debt existed before this sprint too. If the sprint's
  // scope didn't include a fix for it, rejecting again is a false positive that
  // blocks unrelated work. The CEO should check whether this sprint made the issue
  // *worse* — if it hasn't worsened, treat it as carry-forward and don't re-reject.
  const guidance =
    prior.verdict === 'approved'
      ? 'The prior gate APPROVED despite these findings — they are known pre-existing debt. ' +
        'Do NOT let them drive a REJECT in this cycle unless they have clearly worsened or new occurrences have been added. ' +
        'If the code review flags the same items, verify they have not regressed before treating them as grounds for rejection.'
      : 'The prior gate REJECTED partly due to these findings. ' +
        'These issues existed before this sprint ran. ' +
        'Verify whether this sprint FIXED them (treat as RESOLVED if so) or made them WORSE. ' +
        'If the issue is unchanged — still present but neither fixed nor worsened — treat it as ' +
        'accepted carry-forward debt for this cycle: warn in your rationale but do NOT independently ' +
        'drive a REJECT verdict. Only reject if this sprint introduced new occurrences or clearly worsened the existing issue.';

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
 *   2. `prior.knownDebt` — the explicit pre-existing debt list written by
 *      post-v17.3.0 gates in `.agentforge/memory/gate-verdict.jsonl`. This
 *      is the most precise signal: it only includes findings that were already
 *      accepted as carry-forward debt when the prior gate ran, not all findings
 *      from the review (some of which may have been genuinely new that cycle).
 *   3. Fallback: `criticalFindings + majorFindings` from the most recent
 *      gate-verdict entry — used for legacy entries that lack `knownDebt`.
 *   4. `[]` — when no prior verdict exists or the file is unreadable.
 *
 * Exported so call sites and tests can verify the resolved list independently
 * of the full `runGatePhase` path.
 */
export function resolveKnownDebt(projectRoot: string, override?: string[]): string[] {
  if (override !== undefined) return override;
  const prior = loadPriorGateKnownDebt(projectRoot);
  if (!prior) return [];
  // Prefer the explicit knownDebt field (v17.3.0+) over the coarser
  // criticalFindings+majorFindings derivation (legacy fallback).
  return prior.knownDebt ?? [...prior.criticalFindings, ...prior.majorFindings];
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
      // The review.json shape has evolved across code versions — check fields in
      // priority order so we always extract the actual review text rather than
      // falling through to a JSON.stringify blob.
      //
      //   v6.8+ (review-phase.ts):  { review: string, ... }
      //   Legacy:                   { findings: string, ... }
      //   PhaseResult write path:   { agentRuns: [{ response: string }], ... }
      //
      // IMPORTANT: Do NOT fall back to JSON.stringify(reviewJson) as a "review
      // text" input for extractFindingsByLevel. The JSON blob puts the entire
      // review on a single line; the |\[MAJOR\] regex alternative then matches
      // that line (because [MAJOR] appears somewhere in the serialised string),
      // producing a multi-KB garbage finding that fills criticalFindings /
      // majorFindings and poisons the knownDebt JSONL store for future cycles.
      const agentRunResponse =
        Array.isArray(reviewJson.agentRuns) &&
        reviewJson.agentRuns.length > 0 &&
        typeof (reviewJson.agentRuns[0] as any)?.response === 'string'
          ? (reviewJson.agentRuns[0] as any).response as string
          : undefined;

      reviewFindings =
        typeof reviewJson.review === 'string'
          ? reviewJson.review
          : typeof reviewJson.findings === 'string'
            ? reviewJson.findings
            : agentRunResponse !== undefined
              ? agentRunResponse
              : '(review text not parseable)';
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
        // Prefer the explicit knownDebt field (v17.3.0+) — it's more precise than
        // criticalFindings+majorFindings because it only contains items that were
        // ALREADY accepted as carry-forward debt when the prior gate ran.
        ? (priorGateContext.knownDebt ?? [
            ...priorGateContext.criticalFindings,
            ...priorGateContext.majorFindings,
          ])
        : [];

  // Use the richer section (with prior verdict label + tailored guidance) when
  // we have the full PriorGateContext; fall back to the plain-list section when
  // the caller injected the debt directly.
  const knownDebtSection =
    priorGateContext !== null
      ? buildKnownDebtSection(priorGateContext)
      : buildKnownDebtSectionFromList(knownDebt);

  // When known debt is present, add an explicit cross-reference step to the
  // verification protocol so the CEO agent cannot reason "finding still
  // reproduces → REJECT" while ignoring the known-debt guidance above.
  // Without this link the two prompt sections are independent and the
  // verification protocol (as the final, more specific instruction) wins in
  // an LLM conflict — causing the exact false rejections this feature was
  // built to prevent.
  const knownDebtStep =
    knownDebt.length > 0
      ? '\n5. Cross-check every finding against the "Known pre-existing debt" section above. ' +
        'Any finding listed there is accepted pre-existing debt from a prior cycle and MUST NOT ' +
        'independently drive a REJECT verdict — even if you have verified it still reproduces in ' +
        'the current tree. Only findings that are BOTH (a) unresolved AND (b) absent from the ' +
        'known-debt list are valid REJECT grounds.\n'
      : '';

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
4. Only unresolved CRITICAL or verified-still-present MAJOR findings are grounds for REJECT.${knownDebtStep}
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
    const result = await ctx.runtime.run(agentId, task, {
      allowedTools,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
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
            // Record which findings were treated as pre-existing known debt so
            // operators and future audit phases can distinguish sprint-introduced
            // regressions from accepted carry-forward items. An empty list means
            // the CEO evaluated all findings without any known-debt exclusions.
            knownDebt,
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
    // Record which findings were treated as pre-existing known debt so the
    // NEXT cycle's gate can distinguish:
    //   - Items in knownDebt → pre-existing before this sprint ran → warn only
    //   - Items in criticalFindings/majorFindings but NOT in knownDebt
    //     → newly surfaced in this sprint's review → valid reject grounds
    // This closes the feedback loop: gate.json has it for operator auditing;
    // the JSONL metadata now has it for machine consumption by the next gate.
    ...(knownDebt.length > 0 ? { knownDebt } : {}),
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
