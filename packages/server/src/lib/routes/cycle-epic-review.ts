import type { WorkspaceAdapter } from '@agentforge/db';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface CycleEpicReviewRoutesOpts {
  adapter: WorkspaceAdapter;
  projectRoot?: string;
}

export interface EpicReviewArtifact {
  phase: 'gate';
  mode: 'epic-review';
  cycleId: string;
  attempt: number;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'TRIAGE';
  rationale: string;
  faultedItems: Array<{
    itemId: string;
    reason: string;
    files: string[];
  }>;
  schemaValidationOk: boolean;
  triageUsed: boolean;
  costUsd: number;
  durationMs: number;
  completedAt: string;
}

export interface CycleEpicReviewResponse {
  data: EpicReviewArtifact | null;
  meta: {
    cycleId: string;
    workspaceId: string;
    timestamp: string;
  };
  error?: {
    code: string;
    message: string;
  };
}

const SAFE_CYCLE_ID = /^[a-zA-Z0-9_-]+$/;

function meta(adapter: WorkspaceAdapter, cycleId: string): CycleEpicReviewResponse['meta'] {
  return {
    cycleId,
    workspaceId: adapter.workspaceId,
    timestamp: new Date().toISOString(),
  };
}

export async function cycleEpicReviewRoutes(
  app: FastifyInstance,
  opts: CycleEpicReviewRoutesOpts,
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  app.get<{ Params: { id: string } }>(
    '/api/v5/cycles/:id/epic-review',
    async (req, reply) => {
      const rawId = req.params.id;
      const matched = rawId.match(SAFE_CYCLE_ID);
      if (!matched) {
        return reply.status(400).send({
          data: null,
          meta: meta(opts.adapter, rawId),
          error: {
            code: 'INVALID_CYCLE_ID',
            message: 'Invalid cycle id',
          },
        } satisfies CycleEpicReviewResponse);
      }

      const cycleId = matched[0];
      const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));
      const artifactPath = resolve(join(cyclesBaseDir, cycleId, 'phases', 'epic-review.json'));
      const baseWithSep = cyclesBaseDir.endsWith(sep) ? cyclesBaseDir : cyclesBaseDir + sep;

      if (!artifactPath.startsWith(baseWithSep)) {
        return reply.status(400).send({
          data: null,
          meta: meta(opts.adapter, cycleId),
          error: {
            code: 'INVALID_CYCLE_ID',
            message: 'Invalid cycle id',
          },
        } satisfies CycleEpicReviewResponse);
      }

      if (!existsSync(artifactPath)) {
        return reply.status(404).send({
          data: null,
          meta: meta(opts.adapter, cycleId),
          error: {
            code: 'EPIC_REVIEW_NOT_FOUND',
            message: 'Epic review artifact not found',
          },
        } satisfies CycleEpicReviewResponse);
      }

      let artifact: EpicReviewArtifact;
      try {
        artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as EpicReviewArtifact;
      } catch {
        return reply.status(500).send({
          data: null,
          meta: meta(opts.adapter, cycleId),
          error: {
            code: 'EPIC_REVIEW_PARSE_ERROR',
            message: 'Failed to parse epic review artifact',
          },
        } satisfies CycleEpicReviewResponse);
      }

      return reply.send({
        data: artifact,
        meta: meta(opts.adapter, cycleId),
      } satisfies CycleEpicReviewResponse);
    },
  );
}
