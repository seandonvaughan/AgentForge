// packages/core/src/telemetry/cycle-telemetry-export.ts
//
// T5.7 — Optional anonymized cycle telemetry export.
//
// Reads cycle artifacts from .agentforge/cycles/<cycleId>/{cycle,plan,scoring,gate}.json
// and the flywheel continuous-improvement file, strips/hashes any PII or
// proprietary content, and either POSTs to a remote endpoint or saves locally.
//
// Anonymization rules:
//   - Every file path is replaced with sha1(path).slice(0, 12) so structural
//     data (file count, which files changed) is preserved without leaking paths.
//   - Free-text fields (description, rationale, summary, title, error, detail,
//     reason) are stripped from nested objects.
//   - Numeric fields (duration, costs, test counts, scores, agent counts) are
//     kept verbatim — they carry all the useful signal for cloud analytics.
//
// When enabled: false (the default), returns immediately with {exported: false}.
// When enabled: true and endpoint provided, POSTs and returns {exported: true}.
// When enabled: true and NO endpoint, saves locally only.
// Network errors are caught and returned as {exported: false, reason: 'network-error'}.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TelemetryExportOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** UUID of the cycle to export. */
  cycleId: string;
  /**
   * Remote endpoint to POST the anonymized payload to.
   * If undefined, telemetry is only persisted locally.
   */
  endpoint?: string;
  /**
   * Whether export is enabled. Default: false (opt-in only).
   */
  enabled?: boolean;
}

export type TelemetryExportResult =
  | { exported: false; reason: 'disabled' }
  | { exported: false; reason: 'network-error'; error: string }
  | { exported: true; localPath: string; response?: unknown };

// ---------------------------------------------------------------------------
// Anonymization helpers
// ---------------------------------------------------------------------------

/** SHA-1 hash of a string, first 12 hex chars. */
function hashString(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/**
 * Replace every string in an array with its hash.
 * Non-string items are dropped.
 */
function hashStringArray(arr: unknown[]): string[] {
  return arr.filter((x): x is string => typeof x === 'string').map(hashString);
}

/**
 * Fields that contain free-text content we strip.
 * These can include proprietary business logic, error messages, commit summaries, etc.
 */
const FREE_TEXT_FIELDS = new Set([
  'description',
  'rationale',
  'summary',
  'title',
  'detail',
  'reason',
  'error',
  'body',
  'message',
  'text',
  'note',
  'comment',
  'systemPrompt',
  'system_prompt',
  'task',
  'name',
]);

/**
 * Recursively anonymize a JSON-serializable value.
 *
 * Rules:
 * - Objects: recurse, stripping FREE_TEXT_FIELDS keys and hashing path-like string values.
 * - Arrays: recurse each element.
 * - Strings that look like paths (contain / or \): replace with hash.
 * - Numbers / booleans / null: pass through unchanged.
 */
function anonymize(value: unknown, fieldName?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    // If the parent key is a free-text field, strip it (return undefined —
    // handled at the object level so the key is dropped entirely).
    // If the string looks like a file path, hash it.
    if (isPathLike(value)) return hashString(value);
    // Plain short strings (IDs, statuses, enum values) are kept.
    return value;
  }

  if (Array.isArray(value)) {
    // Path arrays (filesChanged, etc.) are hashed element-wise.
    if (fieldName === 'filesChanged' || fieldName === 'files' || fieldName === 'newFailures') {
      return hashStringArray(value as unknown[]);
    }
    return value.map((el) => anonymize(el));
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      // Drop free-text fields entirely.
      if (FREE_TEXT_FIELDS.has(key)) continue;
      const anonymized = anonymize(val, key);
      if (anonymized !== undefined) {
        result[key] = anonymized;
      }
    }
    return result;
  }

  return value;
}

/**
 * A string is "path-like" if it contains a directory separator.
 * This catches both absolute paths (/foo/bar) and relative ones (src/index.ts).
 */
function isPathLike(s: string): boolean {
  return s.includes('/') || s.includes('\\');
}

// ---------------------------------------------------------------------------
// Cycle artifact readers
// ---------------------------------------------------------------------------

function tryReadJson(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

interface RawCyclePayload {
  cycleId: string;
  cycle: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  scoring: Record<string, unknown> | null;
  gate: Record<string, unknown> | null;
  flywheel: Record<string, unknown> | null;
}

function assembleRawPayload(projectRoot: string, cycleId: string): RawCyclePayload {
  const cycleDir = join(projectRoot, '.agentforge', 'cycles', cycleId);
  const flywheelDir = join(projectRoot, '.agentforge', 'flywheel');

  return {
    cycleId,
    cycle: tryReadJson(join(cycleDir, 'cycle.json')),
    plan: tryReadJson(join(cycleDir, 'plan.json')),
    scoring: tryReadJson(join(cycleDir, 'scoring.json')),
    gate: tryReadJson(join(cycleDir, 'phases', 'gate.json')),
    flywheel: tryReadJson(join(flywheelDir, `continuous-improvement-${cycleId}.json`)),
  };
}

/**
 * Anonymize a complete raw cycle payload.
 * Each top-level artifact is anonymized independently so the structure is
 * always `{ cycleId, cycle, plan, scoring, gate, flywheel }`.
 */
function anonymizePayload(raw: RawCyclePayload): Record<string, unknown> {
  return {
    cycleId: raw.cycleId, // UUID — safe to keep
    schemaVersion: '1.0',
    exportedAt: new Date().toISOString(),
    cycle: raw.cycle ? anonymize(raw.cycle) : null,
    plan: raw.plan ? anonymize(raw.plan) : null,
    scoring: raw.scoring ? anonymize(raw.scoring) : null,
    gate: raw.gate ? anonymize(raw.gate) : null,
    flywheel: raw.flywheel ? anonymize(raw.flywheel) : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export anonymized cycle telemetry.
 *
 * @returns `TelemetryExportResult` — never throws; network errors are caught.
 */
export async function exportCycleTelemetry(
  opts: TelemetryExportOptions,
): Promise<TelemetryExportResult> {
  const { projectRoot, cycleId, endpoint, enabled = false } = opts;

  if (!enabled) {
    return { exported: false, reason: 'disabled' };
  }

  // Assemble and anonymize the payload.
  const raw = assembleRawPayload(projectRoot, cycleId);
  const payload = anonymizePayload(raw);

  // Persist the exported payload locally so the user can inspect it.
  const telemetryDir = join(projectRoot, '.agentforge', 'telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  const localPath = join(telemetryDir, `cycle-${cycleId}.json`);
  writeFileSync(localPath, JSON.stringify(payload, null, 2), 'utf8');

  // If no endpoint, return local-only success.
  if (!endpoint) {
    return { exported: true, localPath };
  }

  // POST to the remote endpoint.
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text().catch(() => '');
    let responseBody: unknown = responseText;
    try {
      responseBody = JSON.parse(responseText);
    } catch { /* keep raw text */ }

    return { exported: true, localPath, response: { status: response.status, body: responseBody } };
  } catch (err) {
    return {
      exported: false,
      reason: 'network-error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
