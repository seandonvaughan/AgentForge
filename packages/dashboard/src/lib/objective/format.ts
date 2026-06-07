export type ObjectiveChildStatus = 'planned' | 'running' | 'completed' | 'failed' | 'skipped';

export interface ObjectiveChild {
  id?: string;
  itemId?: string;
  title?: string;
  estimatedCostUsd?: number;
  predecessors?: string[];
  status?: string;
  wave?: number;
  [key: string]: unknown;
}

export interface ObjectiveDecomposition {
  children?: ObjectiveChild[];
  items?: ObjectiveChild[];
  plan?: { children?: ObjectiveChild[] };
}

export interface ObjectiveWave<T extends ObjectiveChild = ObjectiveChild> {
  wave: number;
  children: T[];
  estimatedCostUsd: number;
}

export interface BudgetBand {
  budgetUsd: number;
  spendableUsd: number;
  lowerUsd: number;
  upperUsd: number;
}

export interface SpendReportTotals {
  totalUsd: string;
  budgetUsd: string;
  executionUsd: string;
  overheadUsd: string;
  utilization: string;
}

export interface ExecuteResult {
  id?: string;
  itemId?: string;
  item_id?: string;
  status?: string;
  [key: string]: unknown;
}

export type ExecuteResultsInput =
  | ExecuteResult[]
  | Record<string, ExecuteResult | unknown>
  | { itemResults?: ExecuteResult[]; agentRuns?: ExecuteResult[] }
  | null
  | undefined;

function childId(child: ObjectiveChild): string | undefined {
  return typeof child.id === 'string'
    ? child.id
    : typeof child.itemId === 'string'
      ? child.itemId
      : undefined;
}

function childrenFrom(decomposition: ObjectiveDecomposition | ObjectiveChild[] | null | undefined): ObjectiveChild[] {
  if (Array.isArray(decomposition)) return decomposition;
  if (!decomposition || typeof decomposition !== 'object') return [];
  if (Array.isArray(decomposition.children)) return decomposition.children;
  if (Array.isArray(decomposition.items)) return decomposition.items;
  if (Array.isArray(decomposition.plan?.children)) return decomposition.plan.children;
  return [];
}

function normalizedStatus(status: string | null | undefined): ObjectiveChildStatus | undefined {
  const value = String(status ?? '').toLowerCase();
  if (value === 'completed' || value === 'succeeded' || value === 'success' || value === 'passed') return 'completed';
  if (
    value === 'failed' ||
    value === 'error' ||
    value === 'errored' ||
    value === 'cancelled' ||
    value === 'canceled' ||
    value === 'blocked'
  ) return 'failed';
  if (
    value === 'running' ||
    value === 'in_progress' ||
    value === 'executing' ||
    value === 'started' ||
    value === 'queued'
  ) return 'running';
  if (value === 'skipped') return 'skipped';
  if (value === 'planned' || value === 'pending') return 'planned';
  return undefined;
}

function executeResultsArray(executeResults: ExecuteResultsInput): ExecuteResult[] {
  if (!executeResults) return [];
  if (Array.isArray(executeResults)) return executeResults;
  if (Array.isArray(executeResults.itemResults)) return executeResults.itemResults;
  if (Array.isArray(executeResults.agentRuns)) return executeResults.agentRuns;

  return Object.entries(executeResults)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => ({ id: key, ...(value as ExecuteResult) }));
}

function resultId(result: ExecuteResult): string | undefined {
  if (typeof result.itemId === 'string') return result.itemId;
  if (typeof result.id === 'string') return result.id;
  if (typeof result.item_id === 'string') return result.item_id;
  return undefined;
}

function computeWave(child: ObjectiveChild, byId: Map<string, ObjectiveChild>, memo: Map<string, number>, stack: Set<string>): number {
  const id = childId(child);
  if (!id) return 0;
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  if (typeof child.wave === 'number' && Number.isFinite(child.wave) && child.wave >= 0) {
    const wave = Math.floor(child.wave);
    memo.set(id, wave);
    return wave;
  }
  if (stack.has(id)) return 0;

  stack.add(id);
  const predecessors = Array.isArray(child.predecessors) ? child.predecessors : [];
  const predecessorWaves = predecessors
    .map((predecessorId) => byId.get(predecessorId))
    .filter((predecessor): predecessor is ObjectiveChild => predecessor !== undefined)
    .map((predecessor) => computeWave(predecessor, byId, memo, stack));
  stack.delete(id);

  const wave = predecessorWaves.length > 0 ? 1 + Math.max(...predecessorWaves) : 0;
  memo.set(id, wave);
  return wave;
}

export function groupChildrenIntoWaves<T extends ObjectiveChild>(
  decomposition: ObjectiveDecomposition | T[] | null | undefined,
): ObjectiveWave<T>[] {
  const children = childrenFrom(decomposition) as T[];
  const byId = new Map<string, ObjectiveChild>();
  for (const child of children) {
    const id = childId(child);
    if (id) byId.set(id, child);
  }
  const memo = new Map<string, number>();
  const grouped = new Map<number, T[]>();

  for (const child of children) {
    const wave = computeWave(child, byId, memo, new Set<string>());
    const waveChildren = grouped.get(wave) ?? [];
    waveChildren.push(child);
    grouped.set(wave, waveChildren);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([wave, waveChildren]) => ({
      wave,
      children: waveChildren,
      estimatedCostUsd: waveChildren.reduce((sum, child) => sum + Math.max(0, child.estimatedCostUsd ?? 0), 0),
    }));
}

export function deriveChildStatus(child: ObjectiveChild, executeResults: ExecuteResultsInput): ObjectiveChildStatus {
  const id = childId(child);
  const result = id ? executeResultsArray(executeResults).find((entry) => resultId(entry) === id) : undefined;
  return normalizedStatus(result?.status) ?? normalizedStatus(child.status) ?? 'planned';
}

export function computeBudgetBand(budgetUsd: number): BudgetBand {
  const normalizedBudget = Number.isFinite(budgetUsd) ? Math.max(0, budgetUsd) : 0;
  const spendableUsd = Math.max(0, (normalizedBudget - 6) / 1.2);
  return {
    budgetUsd: normalizedBudget,
    spendableUsd,
    lowerUsd: spendableUsd * 0.7,
    upperUsd: spendableUsd,
  };
}

export function formatUsd(value: number | null | undefined): string {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `$${amount.toFixed(2)}`;
}

export function formatUtilization(value: number | null | undefined): string {
  const ratio = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${Math.round(ratio * 100)}%`;
}

export function formatSpendReportTotals(report: {
  totalUsd?: number | null;
  budgetUsd?: number | null;
  executionUsd?: number | null;
  overheadUsd?: number | null;
  utilization?: number | null;
}): SpendReportTotals {
  return {
    totalUsd: formatUsd(report.totalUsd),
    budgetUsd: formatUsd(report.budgetUsd),
    executionUsd: formatUsd(report.executionUsd),
    overheadUsd: formatUsd(report.overheadUsd),
    utilization: formatUtilization(report.utilization),
  };
}
