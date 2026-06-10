/**
 * Epic API client module.
 *
 * Typed fetch wrappers for the three epic/objective-mode artifacts:
 *   - Decomposition  — child items derived from an objective
 *   - EpicReview     — post-execution gate verdict
 *   - SpendReport    — per-item planned vs actual spend
 *
 * Plus `createObjectiveCycle` which POSTs to /api/v5/cycles to kick off a new
 * objective-mode cycle.
 *
 * All GET wrappers return `null` on 404 (artifact not yet produced) and throw
 * on any other non-OK status — consistent with the convention in client.ts.
 */

import { api } from './client.js';

// ── Decomposition ─────────────────────────────────────────────────────────────

export interface DecompositionChild {
  id: string;
  title: string;
  files: string[];
  estimatedCostUsd: number;
  predecessors: string[];
}

export interface Decomposition {
  id: string;
  objective: string;
  budgetUsd: number;
  children: DecompositionChild[];
  createdAt: string;
}

// ── EpicReview ────────────────────────────────────────────────────────────────

export interface EpicReview {
  verdict: 'pass' | 'fail' | 'warn';
  rationale: string;
  faultedItems?: string[];
}

// ── SpendReport ───────────────────────────────────────────────────────────────

export interface SpendReportItem {
  itemId: string;
  title: string;
  plannedUsd: number;
  actualUsd: number;
}

export interface SpendReport {
  cycleId: string;
  items: SpendReportItem[];
  /** Total spend attributed to execution (agent task work). */
  execution: number;
  /** Total spend attributed to overhead (planning, gate, review). */
  overhead: number;
  /** Ratio of execution to total spend (0–1). */
  utilization: number;
}

// ── createObjectiveCycle input/output ─────────────────────────────────────────

export interface CreateObjectiveCycleInput {
  objective: string;
  budgetUsd: number;
}

export interface ObjectiveCycle {
  id: string;
  objective?: string;
  budgetUsd: number;
  status: string;
}

// ── Internal helper ───────────────────────────────────────────────────────────

const BASE = '/api/v5';

async function fetchOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body?.error ?? body?.message ?? message;
    } catch { /* use default */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── Public fetch wrappers ─────────────────────────────────────────────────────

export function getDecomposition(id: string): Promise<Decomposition | null> {
  return fetchOrNull<Decomposition>(`/cycles/${id}/decomposition`);
}

export function getEpicReview(id: string): Promise<EpicReview | null> {
  return fetchOrNull<EpicReview>(`/cycles/${id}/epic-review`);
}

export function getSpendReport(id: string): Promise<SpendReport | null> {
  return fetchOrNull<SpendReport>(`/cycles/${id}/spend-report`);
}

export function createObjectiveCycle(
  input: CreateObjectiveCycleInput,
): Promise<ObjectiveCycle> {
  return api.post<ObjectiveCycle>('/cycles', input);
}
