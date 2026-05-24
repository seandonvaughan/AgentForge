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
    'findings', // audit phase: researcher executive summary
    'plan', // plan phase: CTO technical plan
    'strategy', // test phase: QA risk assessment report
    'review', // review phase: code-reviewer markdown report
    'rationale', // gate phase: CEO approve/reject reasoning (newer format)
    'retrospective', // learn phase: data-analyst sprint retrospective
    'response', // fallback: top-level response string on any phase
    'error', // failed phases: gate retry message or execution error prose
    'summary', // some phases surface a top-level summary string
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
export function stripMarkdownFields(data) {
    const copy = {};
    for (const [k, v] of Object.entries(data)) {
        if (ALWAYS_STRIP.has(k))
            continue;
        // Only strip a markdown field when markdownSections() will actually use it.
        if (MARKDOWN_FIELDS.has(k) && typeof v === 'string' && v.trim())
            continue;
        copy[k] = v;
    }
    return copy;
}
/** Collect all markdown prose sections present in a phase object. */
export function markdownSections(data) {
    const sections = [];
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
export function resolveAgentResponseContent(raw) {
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
            const rationale = parsed['rationale'] ??
                parsed['reason'] ??
                parsed['explanation'];
            const verdict = parsed['verdict'] ??
                parsed['decision'];
            if (typeof rationale === 'string' && rationale.trim()) {
                // Gate verdict: render verdict badge + rationale prose
                const prefix = verdict ? `**${String(verdict).toUpperCase()}**: ` : '';
                return `${prefix}${rationale}`;
            }
            // Unknown JSON object — render as fenced code block for readability
            return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
        }
    }
    catch {
        // Not JSON — fall through to return raw string
    }
    return raw;
}
/**
 * Extract well-known structured fields from a phase object for compact stat
 * chip display. Covers: status, cost, duration, run count, phase name,
 * gate decision fields, and execute-phase progress counters.
 *
 * The returned array is ordered: status first, then cost/duration,
 * then phase-specific fields.
 */
export function phaseMetaStats(data) {
    const stats = [];
    if (data['status'] != null) {
        stats.push({ key: 'status', value: String(data['status']) });
    }
    const costObj = data['cost'];
    const costUsdVal = costObj?.['totalUsd'] ?? costObj?.['usd'] ?? data['costUsd'];
    if (costUsdVal != null) {
        stats.push({ key: 'cost', value: `$${Number(costUsdVal).toFixed(4)}` });
    }
    if (data['durationMs'] != null) {
        stats.push({ key: 'duration', value: formatDurationMs(Number(data['durationMs'])) });
    }
    if (Array.isArray(data['agentRuns'])) {
        stats.push({ key: 'runs', value: String(data['agentRuns'].length) });
    }
    if (data['phase'] != null) {
        stats.push({ key: 'phase', value: String(data['phase']) });
    }
    // Gate / approval phase fields
    if (data['decision'] != null) {
        stats.push({ key: 'decision', value: String(data['decision']) });
    }
    if (data['approved'] != null) {
        stats.push({ key: 'approved', value: String(data['approved']) });
    }
    // Execute phase progress counters
    if (data['totalItems'] != null) {
        stats.push({ key: 'items', value: String(data['totalItems']) });
    }
    if (data['completedItems'] != null) {
        stats.push({ key: 'completed', value: String(data['completedItems']) });
    }
    if (data['failedItems'] != null && Number(data['failedItems']) > 0) {
        stats.push({ key: 'failed', value: String(data['failedItems']) });
    }
    // Sprint version surfaced on execute phase
    if (data['sprintVersion'] != null) {
        stats.push({ key: 'sprint', value: String(data['sprintVersion']) });
    }
    return stats;
}
/**
 * Format a millisecond duration into a human-readable string.
 * Duplicated here so phase-render.ts has no runtime dependency on any
 * Svelte or dashboard import — this module stays a pure utility.
 */
function formatDurationMs(ms) {
    if (!isFinite(ms) || ms < 0)
        return '—';
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60)
        return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
/** Collect markdown prose from each agentRun's response field.
 *  JSON-encoded responses (e.g. gate phase verdict objects) are unwrapped
 *  into readable prose by resolveAgentResponseContent().
 *  Cost and duration metadata are forwarded so callers can render per-run
 *  context chips without switching to the Agents tab. */
export function agentRunSections(data) {
    const runs = data['agentRuns'];
    if (!Array.isArray(runs))
        return [];
    return runs
        .filter((r) => r != null && typeof r === 'object')
        .filter((r) => typeof r['response'] === 'string' && r['response'].trim())
        .map((r) => {
        const section = {
            agentId: String(r['agentId'] ?? 'agent'),
            response: resolveAgentResponseContent(r['response']),
        };
        if (typeof r['costUsd'] === 'number')
            section.costUsd = r['costUsd'];
        if (typeof r['durationMs'] === 'number')
            section.durationMs = r['durationMs'];
        return section;
    });
}
