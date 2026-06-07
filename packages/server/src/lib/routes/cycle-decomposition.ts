import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const SAFE_CYCLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface DecompositionChild {
  id: string;
  title: string;
  description: string;
  files: string[];
  capabilityTags: string[];
  suggestedAssignee: string;
  estimatedCostUsd: number;
  estimatedComplexity: 'low' | 'medium' | 'high';
  predecessors: string[];
  wave?: number;
}

export interface DecompositionArtifact {
  epicId: string;
  rationale: string;
  children: DecompositionChild[];
  validationReport: {
    acyclic: boolean;
    cycle?: string[];
    missingPredecessors: Array<{ childId: string; missing: string[] }>;
    syntheticFileEdges: Array<{ from: string; to: string; sharedFiles: string[] }>;
    waveCount: number;
    budget?: {
      budgetUsd: number;
      spendableUsd: number;
      sumUsd: number;
      lowerUsd: number;
      upperUsd: number;
      withinBand: boolean;
    };
  };
}

export interface CycleDecompositionRoutesOptions {
  projectRoot: string;
}

export async function registerCycleDecompositionRoutes(
  app: FastifyInstance,
  opts: CycleDecompositionRoutesOptions,
): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/v5/cycles/:id/decomposition', async (req, reply) => {
    const { id } = req.params;
    if (!SAFE_CYCLE_ID.test(id)) return reply.status(400).send({ error: 'Invalid cycle id' });

    const artifactPath = join(opts.projectRoot, '.agentforge', 'cycles', id, 'decomposition.json');
    try {
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as DecompositionArtifact;
      return reply.send(artifact);
    } catch (err) {
      if (isMissingFileError(err)) {
        return reply.status(404).send({ error: 'decomposition.json not found' });
      }
      if (err instanceof SyntaxError) {
        return reply.status(500).send({ error: 'Failed to parse decomposition.json' });
      }
      throw err;
    }
  });
}

function isMissingFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
