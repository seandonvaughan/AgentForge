/**
 * Universal load for the Command Center home page (route `/`).
 *
 * Fetches the initial snapshot of every panel's data on SSR (server fetch)
 * and re-uses the same fetcher on hydration (browser fetch). Each fetch is
 * isolated so a single failure does not block the entire page render — the
 * panel itself shows a small "couldn't load this section, retry" UI.
 *
 * The Svelte component then polls the same endpoints on a 5s cadence while
 * the tab is visible. See `+page.svelte` for the polling implementation.
 */
import type { PageLoad } from './$types';

// ── API response shapes (mirrored from packages/server/src/routes/v5) ────

export interface CycleListRow {
  cycleId: string;
  sprintVersion: string | null;
  stage: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  costUsd: number;
  budgetUsd: number;
  testsPassed: number;
  testsTotal: number;
  prUrl: string | null;
  hasApprovalPending: boolean;
  hasApprovalDecision: boolean;
  approvalDecision: string | null;
}

export interface CountersPayload {
  openBranches: number;
  pendingApprovals: number;
  runningCycles: number;
  todaySpendUsd: number;
  weekSpendUsd: number;
  agentsActive: number;
  load: 'idle' | 'busy' | 'overloaded';
  timestamp: string;
}

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface AgentListItem {
  agentId: string;
  name: string;
  model: ModelTier;
  description: string | null;
  role: string | null;
  team: string | null;
  effort: string | null;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  parent_session_id: string | null;
  task: string;
  status: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  delegation_depth: number;
  autonomy_tier: number;
  resume_count: number;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface CostsByModelEntry {
  model: string;
  costUsd: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostsSummary {
  totalCostUsd: number;
  totalSessions: number;
  byModel: CostsByModelEntry[];
  dailyRollups: { date: string; costUsd: number; sessions: number }[];
}

export interface MemoryListResponse {
  data: unknown[];
  agents?: string[];
  types?: string[];
  meta: { total: number; limit?: number; returned?: number };
}

export interface CommandCenterSnapshot {
  cycles: CycleListRow[];
  counters: CountersPayload | null;
  agents: AgentListItem[];
  sessions: SessionRow[];
  costs: CostsSummary | null;
  memoryTotal: number | null;
  errors: {
    cycles: string | null;
    counters: string | null;
    agents: string | null;
    sessions: string | null;
    costs: string | null;
    memory: string | null;
  };
}

// ── Fetch helpers ─────────────────────────────────────────────────────────

type Fetch = typeof fetch;

async function jsonOrThrow<T>(fetch: Fetch, url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function safe<T>(fetch: Fetch, url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const data = await jsonOrThrow<T>(fetch, url);
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Load ──────────────────────────────────────────────────────────────────

export const load: PageLoad = async ({ fetch }): Promise<CommandCenterSnapshot> => {
  // Run all top-level fetches in parallel so SSR cost is one round-trip.
  const [
    cyclesRes,
    countersRes,
    agentsRes,
    sessionsRes,
    costsRes,
    memoryRes,
  ] = await Promise.all([
    safe<{ cycles: CycleListRow[] }>(fetch, '/api/v5/cycles?limit=8'),
    safe<CountersPayload>(fetch, '/api/v5/counters'),
    safe<{ data: AgentListItem[]; meta: { total: number } }>(fetch, '/api/v5/agents'),
    safe<{ data: SessionRow[]; meta: { total: number } }>(fetch, '/api/v5/sessions?limit=100'),
    safe<{ data: CostsSummary }>(fetch, '/api/v5/costs/summary'),
    safe<MemoryListResponse>(fetch, '/api/v5/memory'),
  ]);

  return {
    cycles: cyclesRes.data?.cycles ?? [],
    counters: countersRes.data,
    agents: agentsRes.data?.data ?? [],
    sessions: sessionsRes.data?.data ?? [],
    costs: costsRes.data?.data ?? null,
    memoryTotal: memoryRes.data?.meta?.total ?? null,
    errors: {
      cycles: cyclesRes.error,
      counters: countersRes.error,
      agents: agentsRes.error,
      sessions: sessionsRes.error,
      costs: costsRes.error,
      memory: memoryRes.error,
    },
  };
};
