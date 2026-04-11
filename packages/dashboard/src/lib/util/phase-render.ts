/**
 * phase-render.ts
 *
 * Pure utility functions for rendering cycle phase data in the dashboard.
 * Extracted from cycles/[id]/+page.svelte so they can be unit-tested
 * independently of the Svelte component.
 *
 * All functions are side-effect free and operate on plain data objects.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Fields that contain markdown prose — rendered by MarkdownRenderer rather
 * than dumped raw into the JSON pre-block.
 */
export const MARKDOWN_FIELDS = new Set([
  'findings',      // audit phase: researcher executive summary
  'plan',          // plan phase: CTO technical plan
  'strategy',      // test phase: QA risk assessment report
  'review',        // review phase: code-reviewer markdown report
  'rationale',     // gate phase: CEO approve/reject reasoning (newer format)
  'retrospective', // learn phase: data-analyst sprint retrospective
  'response',      // fallback: top-level response string on any phase
]);

/** Fields that are always stripped from the raw-JSON metadata view. */
export const ALWAYS_STRIP = new Set(['agentRuns', 'itemResults']);

// ---------------------------------------------------------------------------
// Phase data helpers
// ---------------------------------------------------------------------------

/**
 * Returns a copy of a phase object with prose/run fields removed,
 * leaving only the structured metadata that benefits from JSON display.
 *
 * IMPORTANT: Only strip a MARKDOWN_FIELD when it is a non-empty string
 * that markdownSections() will actually render. If a markdown-named field
 * holds a non-string value (e.g. an object), we keep it in the raw JSON
 * view rather than silently dropping it from the UI entirely.
 * Fields in the always-strip set (agentRuns, itemResults) are stripped
 * unconditionally because they have their own dedicated rendering.
 */
export function stripMarkdownFields(data: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (ALWAYS_STRIP.has(k)) continue;
    // Only strip a markdown field when markdownSections() will actually use it.
    if (MARKDOWN_FIELDS.has(k) && typeof v === 'string' && v.trim()) continue;
    copy[k] = v;
  }
  return copy;
}

/** Collect all markdown prose sections present in a phase object. */
export function markdownSections(
  data: Record<string, unknown>,
): Array<{ label: string; content: string }> {
  const sections: Array<{ label: string; content: string }> = [];
  for (const field of MARKDOWN_FIELDS) {
    const val = data[field];
    if (typeof val === 'string' && val.trim()) {
      sections.push({ label: field, content: val });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Agent run helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an agent run's raw `response` string into renderable markdown.
 *
 * Gate phase agents may return either bare JSON or JSON wrapped in a
 * fenced code block (the MarkdownRenderer output style):
 *
 *   Bare:   {"verdict":"APPROVE","rationale":"Sprint v9.0.0 delivers..."}
 *   Fenced: ```json\n{"verdict":"APPROVE","rationale":"..."}\n```
 *
 * Rules:
 *   1. Strip a leading ```(lang)\n ... \n``` code fence so the inner
 *      JSON can be parsed — mirrors _parseGateResponse() in cycles.html.
 *   2. If the result parses as JSON with a `rationale` field, surface it as
 *      "**VERDICT**: rationale prose" — human-readable without raw JSON noise.
 *   3. If it parses as other JSON (no rationale), re-wrap in a ```json block
 *      so MarkdownRenderer still renders something clean.
 *   4. Otherwise return the string unchanged (already markdown or plain text).
 */
export function resolveAgentResponseContent(raw: string): string {
  // Strip optional leading code fence (```lang\n ... \n```) so we can
  // attempt JSON parsing on the inner content. This mirrors the approach
  // in the legacy HTML dashboard's _parseGateResponse helper.
  let candidate = raw.trim();
  if (candidate.startsWith('`')) {
    const firstNewline = candidate.indexOf('\n');
    const lastFence = candidate.lastIndexOf('\n```');
    if (firstNewline !== -1 && lastFence > firstNewline) {
      candidate = candidate.slice(firstNewline + 1, lastFence).trim();
    }
  }

  try {
    const parsed = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rationale =
        (parsed as Record<string, unknown>)['rationale'] ??
        (parsed as Record<string, unknown>)['reason'] ??
        (parsed as Record<string, unknown>)['explanation'];
      const verdict =
        (parsed as Record<string, unknown>)['verdict'] ??
        (parsed as Record<string, unknown>)['decision'];
      if (typeof rationale === 'string' && rationale.trim()) {
        // Gate verdict: render verdict badge + rationale prose
        const prefix = verdict ? `**${String(verdict).toUpperCase()}**: ` : '';
        return `${prefix}${rationale}`;
      }
      // Unknown JSON object — render as fenced code block for readability
      return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
    }
  } catch {
    // Not JSON — fall through to return raw string
  }
  return raw;
}

/** Collect markdown prose from each agentRun's response field.
 *  JSON-encoded responses (e.g. gate phase verdict objects) are unwrapped
 *  into readable prose by resolveAgentResponseContent(). */
export function agentRunSections(
  data: Record<string, unknown>,
): Array<{ agentId: string; response: string }> {
  const runs = data['agentRuns'];
  if (!Array.isArray(runs)) return [];
  return (runs as unknown[])
    .filter((r): r is Record<string, unknown> => r != null && typeof r === 'object')
    .filter((r) => typeof r['response'] === 'string' && (r['response'] as string).trim())
    .map((r) => ({
      agentId: String(r['agentId'] ?? 'agent'),
      response: resolveAgentResponseContent(r['response'] as string),
    }));
}
