import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Normalize a raw sprint JSON (flat or nested-in-sprints-array) into a
 *  consistent shape the dashboard can render. */
function normalizeSprint(raw: Record<string, unknown>, fallbackId: string) {
  // Some files use { sprints: [{ ... }] } wrapper (v4.x, v6.0 format)
  let entry = raw;
  if (Array.isArray(raw['sprints']) && (raw['sprints'] as unknown[]).length > 0) {
    entry = (raw['sprints'] as Record<string, unknown>[])[0] ?? raw;
  }

  const version = (entry['version'] ?? fallbackId) as string;
  const title = (entry['title'] ?? entry['name'] ?? `Sprint ${version}`) as string;
  const phase = (entry['phase'] ?? entry['status']) as string | undefined;
  const items = (entry['items'] ?? []) as Record<string, unknown>[];
  const budget = entry['budget'] as number | undefined;
  const teamSize = entry['teamSize'] as number | undefined;
  const successCriteria = entry['successCriteria'] as string[] | undefined;
  const auditFindings = entry['auditFindings'] as string[] | undefined;
  const testCountBefore = entry['testCountBefore'] as number | undefined;
  const testCountAfter = entry['testCountAfter'] as number | undefined;
  const testCountDelta = entry['testCountDelta'] as number | undefined;
  const totalCostUsd = entry['totalCostUsd'] as number | undefined;
  const sprintId = entry['sprintId'] as string | undefined;
  const autonomous = entry['autonomous'] as boolean | undefined;
  const theme = entry['theme'] as string | undefined;
  const versionDecision = entry['versionDecision'] as {
    previousVersion?: string;
    nextVersion?: string;
    tier?: string;
    rationale?: string;
    tagsSeen?: string[];
  } | undefined;

  // Derive a canonical status from the phase/status field.
  // Covers historical phase names found across all sprint files (v4.x–v10.x):
  //   completed/done/release/released/shipped/closed/merged/learn/complete → completed
  //   in_progress/active/executing/execute/review → in_progress
  //   planned/plan/pending/draft/… → pending
  function deriveStatus(p: string | undefined): 'completed' | 'in_progress' | 'pending' {
    if (p === 'completed' || p === 'done' || p === 'release' || p === 'released' ||
        p === 'shipped'   || p === 'closed' || p === 'merged' ||
        p === 'learn'     || p === 'complete') return 'completed';
    if (p === 'in_progress' || p === 'active' || p === 'executing' ||
        p === 'execute'     || p === 'review') return 'in_progress';
    return 'pending';
  }

  // Normalize item status — older files use 'planned' instead of 'pending'
  function normalizeItemStatus(s: unknown): 'completed' | 'in_progress' | 'pending' | 'blocked' | 'failed' {
    if (s === 'completed') return 'completed';
    if (s === 'in_progress') return 'in_progress';
    if (s === 'blocked') return 'blocked';
    if (s === 'failed') return 'failed';
    // 'planned', 'pending', or anything else → pending
    return 'pending';
  }

  return {
    id: version,
    version,
    sprintId,
    title,
    phase,
    status: deriveStatus(phase),
    startDate: (entry['startedAt'] ?? entry['createdAt']) as string | undefined,
    endDate: entry['completedAt'] as string | undefined,
    budget,
    teamSize,
    successCriteria,
    auditFindings,
    testCountBefore,
    testCountAfter,
    testCountDelta,
    totalCostUsd,
    autonomous,
    theme,
    versionDecision,
    items: items.map((item) => ({
      id: (item['id'] ?? '') as string,
      title: (item['title'] ?? '') as string,
      description: (item['description'] ?? '') as string,
      priority: (item['priority'] ?? 'P2') as string,
      assignee: (item['assignee'] ?? '') as string,
      status: normalizeItemStatus(item['status']),
      estimatedCost: (item['estimatedCostUsd'] ?? item['estimatedCost']) as number | undefined,
      tags: (item['tags'] ?? []) as string[],
      source: item['source'] as string | undefined,
    })),
  };
}

export async function sprintsRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  const sprintsDir = join(opts.projectRoot, '.agentforge/sprints');

  app.get('/api/v5/sprints', async (_req, reply) => {
    if (!existsSync(sprintsDir)) {
      return reply.send({ data: [], meta: { total: 0 } });
    }

    const files = readdirSync(sprintsDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('v${'))
      .sort()
      .reverse(); // newest first

    const sprints = files.flatMap(file => {
      try {
        const raw = JSON.parse(readFileSync(join(sprintsDir, file), 'utf-8'));
        const fallbackId = file.replace('.json', '');
        return [normalizeSprint(raw, fallbackId)];
      } catch {
        return [];
      }
    });

    return reply.send({ data: sprints, meta: { total: sprints.length } });
  });

  app.get('/api/v5/sprints/:version', async (req, reply) => {
    const { version } = req.params as { version: string };
    const file = join(sprintsDir, `v${version}.json`);

    if (!existsSync(file)) {
      return reply.status(404).send({ error: 'Sprint not found', code: 'SPRINT_NOT_FOUND' });
    }

    try {
      const raw = JSON.parse(readFileSync(file, 'utf-8'));
      const normalized = normalizeSprint(raw, version);
      return reply.send({ data: normalized });
    } catch {
      return reply.status(500).send({ error: 'Failed to parse sprint file' });
    }
  });
}
