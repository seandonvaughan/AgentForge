export interface ObjectiveChild {
  id: string;
  wave?: number | null;
  estimatedCostUsd?: number | null;
  costUsd?: number | null;
}

export interface ObjectiveModeView<TChild extends ObjectiveChild = ObjectiveChild> {
  children?: readonly TChild[] | null;
  plan?: { children?: readonly TChild[] | null } | null;
  decomposition?: { children?: readonly TChild[] | null } | null;
}

export interface WaveGroup<TChild extends ObjectiveChild = ObjectiveChild> {
  wave: number;
  label: string;
  children: TChild[];
  estimatedCostUsd: number;
}

export interface SpendTotals {
  estimatedUsd: number;
  actualUsd: number;
  budgetUsd: number | null;
  remainingUsd: number | null;
  utilization: number | null;
  formatted: {
    estimated: string;
    actual: string;
    budget: string;
    remaining: string;
    utilization: string;
  };
}

export interface BudgetBand {
  budgetUsd: number;
  reserveUsd: number;
  multiplier: number;
  spendableUsd: number;
  lowerUsd: number;
  upperUsd: number;
  label: string;
}

const BUDGET_RESERVE_USD = 6;
const BUDGET_MULTIPLIER = 1.2;
const BAND_LOWER = 0.7;
const BAND_UPPER = 1.0;

function normalizeNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function childrenFromView<TChild extends ObjectiveChild>(
  view: ObjectiveModeView<TChild> | readonly TChild[] | null | undefined,
): readonly TChild[] {
  if (Array.isArray(view)) return view;
  return view?.children ?? view?.plan?.children ?? view?.decomposition?.children ?? [];
}

export function formatUsd(value: number | null | undefined): string {
  return `$${normalizeNumber(value).toFixed(2)}`;
}

export function formatUtilization(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(value * 100)}%`;
}

export function groupChildrenByWave<TChild extends ObjectiveChild>(
  view: ObjectiveModeView<TChild> | readonly TChild[] | null | undefined,
): WaveGroup<TChild>[] {
  const children = childrenFromView(view);
  if (children.length === 0) return [];

  const anyWave = children.some((child) => typeof child.wave === 'number');
  if (!anyWave) {
    const flatChildren = [...children];
    return [{
      wave: 0,
      label: 'Wave 1',
      children: flatChildren,
      estimatedCostUsd: sumEstimated(flatChildren),
    }];
  }

  const byWave = new Map<number, TChild[]>();
  for (const child of children) {
    const wave = typeof child.wave === 'number' && Number.isFinite(child.wave) ? child.wave : 0;
    const bucket = byWave.get(wave);
    if (bucket) bucket.push(child);
    else byWave.set(wave, [child]);
  }

  return [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((wave) => {
      const waveChildren = byWave.get(wave) ?? [];
      return {
        wave,
        label: `Wave ${wave + 1}`,
        children: waveChildren,
        estimatedCostUsd: sumEstimated(waveChildren),
      };
    });
}

export function spendTotals(
  view: ObjectiveModeView | readonly ObjectiveChild[] | null | undefined,
  budgetUsd?: number | null,
): SpendTotals {
  const children = childrenFromView(view);
  const estimatedUsd = sumEstimated(children);
  const actualUsd = children.reduce((sum, child) => sum + normalizeNumber(child.costUsd), 0);
  const normalizedBudget = typeof budgetUsd === 'number' && Number.isFinite(budgetUsd) ? budgetUsd : null;
  const remainingUsd = normalizedBudget === null ? null : normalizedBudget - actualUsd;
  const utilization = normalizedBudget && normalizedBudget > 0 ? actualUsd / normalizedBudget : null;

  return {
    estimatedUsd,
    actualUsd,
    budgetUsd: normalizedBudget,
    remainingUsd,
    utilization,
    formatted: {
      estimated: formatUsd(estimatedUsd),
      actual: formatUsd(actualUsd),
      budget: normalizedBudget === null ? '-' : formatUsd(normalizedBudget),
      remaining: remainingUsd === null ? '-' : formatUsd(remainingUsd),
      utilization: formatUtilization(utilization),
    },
  };
}

export function budgetBand(budgetUsd: number): BudgetBand {
  const normalizedBudget = normalizeNumber(budgetUsd);
  const spendableUsd = (normalizedBudget - BUDGET_RESERVE_USD) / BUDGET_MULTIPLIER;
  const lowerUsd = spendableUsd * BAND_LOWER;
  const upperUsd = spendableUsd * BAND_UPPER;

  return {
    budgetUsd: normalizedBudget,
    reserveUsd: BUDGET_RESERVE_USD,
    multiplier: BUDGET_MULTIPLIER,
    spendableUsd,
    lowerUsd,
    upperUsd,
    label: `${formatUsd(lowerUsd)}-${formatUsd(upperUsd)}`,
  };
}

function sumEstimated(children: readonly ObjectiveChild[]): number {
  return children.reduce((sum, child) => sum + normalizeNumber(child.estimatedCostUsd), 0);
}
