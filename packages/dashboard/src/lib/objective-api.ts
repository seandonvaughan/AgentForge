// packages/dashboard/src/lib/objective-api.ts
//
// Typed fetch helpers for the objective-mode API endpoints.
//
// All GET helpers return `null` on HTTP 404 (artifact not yet produced) and
// throw on any other non-2xx status so callers can surface server errors.
// POST helpers throw on any non-2xx status.
//
// Every URL is decorated with the current workspace id via `withWorkspace`
// so multi-workspace dashboards scope requests correctly.

import type {
  DecompositionArtifact,
  EpicReviewArtifact,
  SpendReportArtifact,
  PostObjectiveBody,
} from '@agentforge/shared';

import { withWorkspace } from '$lib/stores/workspace.js';

const BASE = '/api/v5';

// ── GET helpers ───────────────────────────────────────────────────────────────

/**
 * Fetch the decomposition artifact for a cycle.
 *
 * Returns `null` when the server responds with 404 (artifact not yet written).
 * Throws on any other non-2xx response.
 *
 * @param cycleId - The cycle identifier (e.g. `"abc1234"`).
 */
export async function getDecomposition(cycleId: string): Promise<DecompositionArtifact[] | null> {
  const url = withWorkspace(`${BASE}/cycles/${encodeURIComponent(cycleId)}/decomposition`);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<DecompositionArtifact[]>;
}

/**
 * Fetch the epic-review artifact for a cycle.
 *
 * Returns `null` when the server responds with 404 (review not yet produced).
 * Throws on any other non-2xx response.
 *
 * @param cycleId - The cycle identifier.
 */
export async function getEpicReview(cycleId: string): Promise<EpicReviewArtifact | null> {
  const url = withWorkspace(`${BASE}/cycles/${encodeURIComponent(cycleId)}/epic-review`);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<EpicReviewArtifact>;
}

/**
 * Fetch the spend-report artifact for a cycle.
 *
 * Returns `null` when the server responds with 404 (report not yet written).
 * Throws on any other non-2xx response.
 *
 * @param cycleId - The cycle identifier.
 */
export async function getSpendReport(cycleId: string): Promise<SpendReportArtifact | null> {
  const url = withWorkspace(`${BASE}/cycles/${encodeURIComponent(cycleId)}/spend-report`);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SpendReportArtifact>;
}

// ── POST helpers ──────────────────────────────────────────────────────────────

/**
 * Response shape returned by POST /api/v5/objective.
 */
export interface PostObjectiveResponse {
  /** Identifier of the newly created objective cycle. */
  cycleId: string;
}

/**
 * Start a new objective cycle.
 *
 * Sends the supplied body to `POST /api/v5/objective` (workspace-scoped) and
 * returns the server's `PostObjectiveResponse` on success.
 * Throws on any non-2xx response.
 *
 * @param body - Optional objective text and budget cap; both fall back to
 *               workspace defaults when omitted.
 */
export async function postObjective(body: PostObjectiveBody): Promise<PostObjectiveResponse> {
  const url = withWorkspace(`${BASE}/objective`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PostObjectiveResponse>;
}
