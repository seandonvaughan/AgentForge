import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EpicDecompositionViewChild {
  id: string;
  title: string;
  description: string;
  files: string[];
  capabilityTags: string[];
  suggestedAssignee: string;
  estimatedCostUsd: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
  predecessors: string[];
  wave: number;
  status: string;
  actualCostUsd: number;
}

export interface EpicDecompositionViewWave {
  wave: number;
  children: EpicDecompositionViewChild[];
}

export interface EpicDecompositionView {
  epicId: string;
  rationale: string;
  validationReport?: unknown;
  waves: EpicDecompositionViewWave[];
}

export interface BuildDecompositionViewArgs {
  projectRoot: string;
  cycleId: string;
}

interface DecompositionArtifact {
  epicId?: unknown;
  rationale?: unknown;
  children?: unknown;
  validationReport?: unknown;
}

interface ExecuteResult {
  status: string;
  actualCostUsd: number;
}

function tryReadJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readExecuteResults(executeJson: unknown): Map<string, ExecuteResult> {
  const out = new Map<string, ExecuteResult>();
  if (!isRecord(executeJson)) return out;

  const rawResults = Array.isArray(executeJson['itemResults'])
    ? executeJson['itemResults']
    : Array.isArray(executeJson['agentRuns'])
      ? executeJson['agentRuns']
      : [];

  for (const entry of rawResults) {
    if (!isRecord(entry)) continue;
    const itemId = entry['itemId'];
    if (typeof itemId !== 'string' || itemId.length === 0) continue;

    const status = typeof entry['status'] === 'string' ? entry['status'] : 'pending';
    const actualCostUsd = typeof entry['costUsd'] === 'number' ? entry['costUsd'] : 0;
    out.set(itemId, { status, actualCostUsd });
  }

  return out;
}

/**
 * Build a UI-ready decomposition view for an epic cycle. The source
 * decomposition is required; execute results are optional and default each
 * child to a pending, zero-cost state until the execute phase records a row.
 */
export function buildDecompositionView(
  args: BuildDecompositionViewArgs,
): EpicDecompositionView | null {
  const cycleDir = join(args.projectRoot, '.agentforge', 'cycles', args.cycleId);
  const rawDecomposition = tryReadJson(join(cycleDir, 'decomposition.json'));
  if (!isRecord(rawDecomposition)) return null;

  const decomposition = rawDecomposition as DecompositionArtifact;
  if (
    typeof decomposition.epicId !== 'string' ||
    typeof decomposition.rationale !== 'string' ||
    !Array.isArray(decomposition.children)
  ) {
    return null;
  }

  const executeResults = readExecuteResults(
    tryReadJson(join(cycleDir, 'phases', 'execute.json')),
  );
  const waves = new Map<number, EpicDecompositionViewChild[]>();

  for (const child of decomposition.children) {
    if (!isRecord(child) || typeof child['id'] !== 'string') continue;
    const result = executeResults.get(child['id']);
    const wave = typeof child['wave'] === 'number' ? child['wave'] : 0;
    const viewChild: EpicDecompositionViewChild = {
      ...(child as Omit<EpicDecompositionViewChild, 'status' | 'actualCostUsd'>),
      wave,
      status: result?.status ?? 'pending',
      actualCostUsd: result?.actualCostUsd ?? 0,
    };
    const bucket = waves.get(wave);
    if (bucket) {
      bucket.push(viewChild);
    } else {
      waves.set(wave, [viewChild]);
    }
  }

  return {
    epicId: decomposition.epicId,
    rationale: decomposition.rationale,
    ...(decomposition.validationReport !== undefined
      ? { validationReport: decomposition.validationReport }
      : {}),
    waves: [...waves.entries()]
      .sort(([a], [b]) => a - b)
      .map(([wave, children]) => ({ wave, children })),
  };
}
