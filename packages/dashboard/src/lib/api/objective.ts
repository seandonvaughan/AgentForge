import type {
  EpicObjective,
  EpicPlan,
  ValidationReport,
} from '../../../../core/src/autonomous/decompose/types.js';
import type { SpendReport } from '../../../../core/src/autonomous/cycle-artifacts/spend-report.js';
import type { EpicReviewArtifact } from '../../../../core/src/autonomous/phase-handlers/epic-review.js';

const BASE = '/api/v5';

export type ObjectiveDecomposition = EpicPlan & {
  objective?: EpicObjective;
  validationReport: ValidationReport;
};

export type EpicReview = EpicReviewArtifact;
export type ObjectiveSpendReport = SpendReport;

export interface CreateObjectiveCycleInput {
  objective: string;
  budgetUsd: number;
}

export interface ObjectiveCycleCreated {
  cycleId: string;
  startedAt: string;
  pid?: number;
  pgid?: number;
  runtimeMode?: string;
  workspaceId?: string | null;
  branchPrefix?: string | null;
  baseBranch?: string | null;
  dryRun?: boolean | null;
  maxAgents?: number | null;
  tags?: string[];
  fallbackEnabled?: boolean | null;
  fastMode?: boolean;
}

type ApiEnvelope<T> = T | { data: T };

async function readError(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json() as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Use default HTTP status message.
  }
  return message;
}

function unwrapData<T>(body: ApiEnvelope<T>): T {
  if (
    body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && 'data' in body
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw new Error(await readError(res));
  return unwrapData<T>(await res.json() as ApiEnvelope<T>);
}

async function fetchOptionalJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await readError(res));
  return unwrapData<T>(await res.json() as ApiEnvelope<T>);
}

export function getDecomposition(id: string): Promise<ObjectiveDecomposition | null> {
  return fetchOptionalJson<ObjectiveDecomposition>(`/cycles/${encodeURIComponent(id)}/decomposition`);
}

export function getEpicReview(id: string): Promise<EpicReview | null> {
  return fetchOptionalJson<EpicReview>(`/cycles/${encodeURIComponent(id)}/epic-review`);
}

export function getSpendReport(id: string): Promise<ObjectiveSpendReport | null> {
  return fetchOptionalJson<ObjectiveSpendReport>(`/cycles/${encodeURIComponent(id)}/spend-report`);
}

export function createObjectiveCycle(input: CreateObjectiveCycleInput): Promise<ObjectiveCycleCreated> {
  return fetchJson<ObjectiveCycleCreated>('/cycles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
