// packages/core/src/autonomous/phase-handlers/review-phase.ts
//
// v6.5.2 — Review phase handler. Dispatches the code-reviewer agent to
// review the actual diff produced by the execute phase. Read-only —
// does NOT modify any files.
//
// v6.8.0 — Writes review-finding memory entries for MAJOR and CRITICAL
// findings so the audit phase can surface recurring anti-patterns in
// subsequent cycles.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { PhaseContext, PhaseResult } from '../phase-scheduler.js';
import { writeMemoryEntry, type ReviewFindingMetadata } from '../../memory/types.js';
import { extractFindingsByLevel } from './gate-phase.js';

export const REVIEW_PHASE_DEFAULT_TOOLS = ['Read', 'Bash', 'Glob', 'Grep'];
export const REVIEW_PHASE_AGENT = 'code-reviewer';

export interface ReviewPhaseOptions {
  allowedTools?: string[];
  agentId?: string;
}

export function makeReviewPhaseHandler(options: ReviewPhaseOptions = {}) {
  return (ctx: PhaseContext) => runReviewPhase(ctx, options);
}

export async function runReviewPhase(
  ctx: PhaseContext,
  options: ReviewPhaseOptions = {},
): Promise<PhaseResult> {
  const phase = 'review' as const;
  const startedAt = Date.now();
  const allowedTools = options.allowedTools ?? REVIEW_PHASE_DEFAULT_TOOLS;
  const agentId = options.agentId ?? REVIEW_PHASE_AGENT;

  ctx.bus.publish('sprint.phase.started', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    startedAt: new Date(startedAt).toISOString(),
  });

  const task = `You are the code-reviewer for AgentForge. Sprint v${ctx.sprintVersion} just completed its execute phase. Review the changes.

Use Bash to run:
- git diff --stat HEAD (summary of what changed)
- git diff HEAD (full diff)
- git log -1 --format="%B" (commit message if any, though there may not be one yet)

Then Read the changed files to understand context beyond the diff.

Produce a code review (markdown, ~400 words) covering:
- Overall correctness — does the code do what the sprint items asked for?
- Code quality issues (naming, complexity, duplication)
- Security concerns
- Test coverage gaps
- Any bugs you'd reject the PR for

End with an overall verdict on a 1-5 scale where 1=reject, 5=ship.

Do NOT modify any files.`;

  let review = '';
  let costUsd = 0;
  let status: PhaseResult['status'] = 'completed';
  let errorMsg: string | undefined;

  try {
    const result = await ctx.runtime.run(agentId, task, { allowedTools });
    review = typeof result?.output === 'string' ? result.output : '';
    costUsd = typeof result?.costUsd === 'number' ? result.costUsd : 0;
  } catch (err) {
    status = 'failed';
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const verdict = parseVerdict(review);
  const concerns = parseConcerns(review);
  const durationMs = Date.now() - startedAt;

  // Persist CRITICAL and MAJOR findings to the cross-cycle memory store so the
  // audit phase can detect recurring anti-patterns across sprints. One entry
  // per finding line — granularity enables per-file pattern counting.
  //
  // Domain tags from the sprint items are appended so the execute-phase memory
  // injector can match findings to future sprint items with overlapping tags.
  // Without this, findings carry only structural tags (review/finding/critical)
  // that never overlap with sprint item domain tags (memory/execute/backend),
  // breaking the cross-cycle feedback loop.
  const criticalLines = extractFindingsByLevel(review, 'CRITICAL');
  const majorLines = extractFindingsByLevel(review, 'MAJOR');
  const sprintDomainTags = collectSprintItemTags(ctx.projectRoot, ctx.sprintVersion);
  for (const line of criticalLines) {
    writeMemoryEntry(ctx.projectRoot, {
      type: 'review-finding',
      value: line,
      source: ctx.cycleId,
      tags: ['review', 'finding', 'critical', `sprint:v${ctx.sprintVersion}`, ...sprintDomainTags],
      metadata: parseReviewFindingMetadata(line, 'CRITICAL'),
    });
  }
  for (const line of majorLines) {
    writeMemoryEntry(ctx.projectRoot, {
      type: 'review-finding',
      value: line,
      source: ctx.cycleId,
      tags: ['review', 'finding', 'major', `sprint:v${ctx.sprintVersion}`, ...sprintDomainTags],
      metadata: parseReviewFindingMetadata(line, 'MAJOR'),
    });
  }

  const phaseResult: PhaseResult = {
    phase,
    status,
    durationMs,
    costUsd,
    agentRuns: [{ agentId, costUsd, durationMs, response: review }],
    ...(errorMsg ? { error: errorMsg } : {}),
  };

  if (ctx.cycleId) {
    const phaseJsonPath = join(
      ctx.projectRoot,
      '.agentforge',
      'cycles',
      ctx.cycleId,
      'phases',
      'review.json',
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
            agentId,
            review,
            verdict,
            concerns,
            costUsd,
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

  ctx.bus.publish('sprint.phase.completed', {
    sprintId: ctx.sprintId,
    phase,
    cycleId: ctx.cycleId,
    result: phaseResult,
    completedAt: new Date().toISOString(),
  });

  return phaseResult;
}

/** Parse a 1-5 verdict score from a review markdown. Falls back to 3. */
export function parseVerdict(markdown: string): number {
  if (!markdown) return 3;
  const patterns = [
    /verdict[^0-9]{0,30}([1-5])\s*\/\s*5/i,
    /verdict[^0-9]{0,30}([1-5])\b/i,
    /\b([1-5])\s*\/\s*5\b/,
  ];
  for (const re of patterns) {
    const m = markdown.match(re);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 5) return n;
    }
  }
  return 3;
}

function parseConcerns(markdown: string): string[] {
  if (!markdown) return [];
  const concerns: string[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (/^[-*]\s+/.test(trimmed)) {
      concerns.push(trimmed.replace(/^[-*]\s+/, ''));
    }
  }
  return concerns.slice(0, 20);
}

// Matches relative file paths like src/foo.ts, packages/core/src/bar.js, lib/baz.tsx
const FILE_PATH_RE = /\b((?:src|lib|packages|tests?|apps?|server|client|dist)[/\\][\w./\\-]+\.\w+)\b/;
// Matches ":42" immediately after a file path (e.g. "src/foo.ts:42")
const LINE_NUMBER_RE = /:(\d+)/;
// Matches a suggested fix at the end of a finding line
const FIX_SUGGESTION_RE = /(?:Fix|Suggestion|Suggested fix|To fix)[:\s]+(.+?)(?:\.\s*$|$)/i;
// Matches severity prefix and bullet decoration at the start of a finding line
const SEVERITY_PREFIX_RE = /^[-*\s]*(?:CRITICAL|MAJOR)[:\s-]*/i;

/**
 * Parse a raw finding line into a structured `ReviewFindingMetadata` object.
 *
 * All fields except `severity` and `summary` are extracted on a best-effort
 * basis — if the reviewer did not include file/line/fix information the
 * corresponding field is null. The caller must still store `value` (the raw
 * line) so nothing is lost even when parsing yields sparse results.
 */
export function parseReviewFindingMetadata(
  line: string,
  severity: 'CRITICAL' | 'MAJOR',
): ReviewFindingMetadata {
  // Extract file path if present
  const fileMatch = line.match(FILE_PATH_RE);
  const file = fileMatch ? fileMatch[1] : null;

  // Extract line number — only meaningful when a file was also detected
  let lineNumber: number | null = null;
  if (file && fileMatch && fileMatch.index !== undefined) {
    const afterFile = line.slice(fileMatch.index + fileMatch[1].length);
    const lineMatch = afterFile.match(LINE_NUMBER_RE);
    if (lineMatch) {
      const parsed = parseInt(lineMatch[1], 10);
      lineNumber = isNaN(parsed) ? null : parsed;
    }
  }

  // Extract fix suggestion before stripping the line for the summary
  const fixMatch = line.match(FIX_SUGGESTION_RE);
  const fixSuggestion = fixMatch ? fixMatch[1].trim() || null : null;

  // Build summary: strip bullet/severity prefix and fix clause
  let summary = line
    .replace(SEVERITY_PREFIX_RE, '')
    .replace(FIX_SUGGESTION_RE, '')
    .trim();

  // Remove the file:line reference from the summary text if present (literal search)
  if (file) {
    const fileIdx = summary.indexOf(file);
    if (fileIdx !== -1) {
      // Remove "file:line — " or "file — " etc. after the file token
      const afterFileInSummary = summary.slice(fileIdx + file.length);
      const colonLineMatch = afterFileInSummary.match(/^:\d+/);
      const removeLen = file.length + (colonLineMatch ? colonLineMatch[0].length : 0);
      summary = (summary.slice(0, fileIdx) + summary.slice(fileIdx + removeLen))
        .replace(/^\s*[—:\s-]+/, '')
        .trim();
    }
  }

  // Normalise leading/trailing punctuation artifacts
  summary = summary.replace(/^[—:\s-]+/, '').replace(/[.\s]+$/, '').trim();

  return { file, line: lineNumber, severity, summary, fixSuggestion };
}

/**
 * Read the sprint JSON and collect all unique item-level domain tags across all
 * items in the sprint. Returns an empty array when the sprint file is absent
 * or unreadable — failure must never block the review phase from completing.
 *
 * These domain tags are appended to review-finding memory entries written by
 * the review phase so that the execute-phase memory injector can find findings
 * from prior cycles that are relevant to the current item's domain tags.
 *
 * Without this, review findings carry only structural tags (review/finding/
 * critical) which never overlap with sprint item domain tags (memory/execute/
 * backend/...), silently breaking the cross-cycle feedback loop.
 */
export function collectSprintItemTags(projectRoot: string, sprintVersion: string): string[] {
  try {
    const sprintPath = join(projectRoot, '.agentforge', 'sprints', `v${sprintVersion}.json`);
    const raw = readFileSync(sprintPath, 'utf8');
    const parsed = JSON.parse(raw);
    const sprintObj: { items?: Array<{ tags?: string[] }> } | null =
      parsed.items ? parsed : (parsed.sprints?.[0] ?? null);
    const items = sprintObj?.items ?? [];
    const tagSet = new Set<string>();
    for (const item of items) {
      for (const tag of item.tags ?? []) {
        tagSet.add(tag.toLowerCase());
      }
    }
    return Array.from(tagSet);
  } catch {
    // Sprint file absent or unreadable — return empty so the caller still
    // writes the structural tags and doesn't lose the finding.
    return [];
  }
}
