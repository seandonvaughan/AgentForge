import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

// ---------------------------------------------------------------------------
// Normalization helpers — bridge between raw sprint JSON files and the
// dashboard's expected schema.
// ---------------------------------------------------------------------------

/** Map raw item status values to the canonical set used by the UI. */
function normalizeItemStatus(raw: string): string {
  if (raw === 'planned') return 'pending';
  return raw; // completed, in_progress, blocked pass through
}

/** Derive a top-level sprint `status` from its `phase` field. */
function phaseToStatus(phase: string, existing?: string): string {
  if (existing && ['completed', 'in_progress', 'pending'].includes(existing)) {
    return existing;
  }
  if (phase === 'active' || phase === 'executing') return 'in_progress';
  if (phase === 'completed' || phase === 'done') return 'completed';
  return 'pending'; // planned, draft, etc.
}

/** Normalize a single sprint item — aligns field names with the UI contract. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeItem(item: any): Record<string, unknown> {
  return {
    ...item,
    status: normalizeItemStatus(item.status ?? 'pending'),
    // Prefer estimatedCost if already present; fall back to estimatedCostUsd
    estimatedCost: item.estimatedCost ?? item.estimatedCostUsd ?? undefined,
  };
}

/** Normalize a raw sprint object from disk into the dashboard schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeSprint(raw: any): Record<string, unknown> {
  return {
    id: raw.sprintId ?? raw.id ?? raw.version,
    version: raw.version,
    sprintId: raw.sprintId ?? undefined,
    title: raw.title,
    phase: raw.phase,
    status: phaseToStatus(raw.phase ?? '', raw.status),
    startDate: raw.startDate ?? raw.startedAt ?? raw.createdAt,
    endDate: raw.endDate ?? raw.completedAt,
    budget: raw.budget,
    teamSize: raw.teamSize,
    successCriteria: raw.successCriteria ?? [],
    auditFindings: raw.auditFindings ?? [],
    items: (raw.items ?? []).map(normalizeItem),
    // --- Fields the detail page renders but were previously dropped ---
    testCountBefore: raw.testCountBefore ?? undefined,
    testCountAfter: raw.testCountAfter ?? undefined,
    testCountDelta: raw.testCountDelta ?? undefined,
    totalCostUsd: raw.totalCostUsd ?? undefined,
    autonomous: raw.autonomous ?? undefined,
    theme: raw.theme ?? undefined,
    versionDecision: raw.versionDecision ?? undefined,
  };
}

/**
 * Read and unwrap a sprint file. Sprint files may be either:
 *   - A flat sprint object  { version, items, ... }
 *   - A wrapped array       { sprints: [{ version, items, ... }] }
 *
 * Returns an array of normalized sprint objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readAndUnwrapFile(filePath: string): Array<Record<string, unknown>> {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed = JSON.parse(raw);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed); // legacy double-encoded
  const list: unknown[] = Array.isArray(parsed.sprints) ? parsed.sprints : [parsed];
  return list.map(normalizeSprint);
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function sprintsRoutes(
  app: FastifyInstance,
  opts: { adapter?: SqliteAdapter; projectRoot?: string }
) {
  const root = opts.projectRoot ?? PROJECT_ROOT;

  // GET /api/v1/sprints — list all sprint JSON files (raw, legacy)
  app.get('/api/v1/sprints', async (_req, reply) => {
    try {
      const sprintsDir = join(root, '.agentforge/sprints');
      if (!existsSync(sprintsDir)) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const files = readdirSync(sprintsDir).filter(f => f.endsWith('.json') && !f.includes('$'));
      if (files.length === 0) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const data = files.flatMap(filename => {
        try {
          const raw = readFileSync(join(sprintsDir, filename), 'utf-8');
          let parsed = JSON.parse(raw);
          // Handle double-encoded JSON (legacy files stored as string)
          if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          return [{ filename, ...parsed }];
        } catch {
          return [];
        }
      });

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v1/sprints/:version — get a specific sprint file (raw, legacy)
  app.get('/api/v1/sprints/:version', async (req, reply) => {
    const { version } = req.params as { version: string };
    try {
      const sprintsDir = join(root, '.agentforge/sprints');
      // Sprint files may be named 'v6.7.1.json' (with prefix) or '6.7.1.json'
      const bare = version.startsWith('v') ? version.slice(1) : version;
      const filePath = join(sprintsDir, `${bare}.json`);
      const filePathWithV = join(sprintsDir, `v${bare}.json`);
      const resolvedPath = existsSync(filePath) ? filePath
        : existsSync(filePathWithV) ? filePathWithV
        : null;

      if (!resolvedPath) {
        return reply.status(404).send({ error: 'Sprint not found', version });
      }

      const content = readFileSync(resolvedPath, 'utf-8');
      const data = { filename: `${bare}.json`, ...JSON.parse(content) };

      return reply.send({ data, meta: { total: 1 } });
    } catch {
      return reply.status(404).send({ error: 'Sprint not found', version });
    }
  });

  // GET /api/v5/sprints — normalized list for the dashboard
  app.get('/api/v5/sprints', async (_req, reply) => {
    try {
      const sprintsDir = join(root, '.agentforge/sprints');
      if (!existsSync(sprintsDir)) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const files = readdirSync(sprintsDir)
        .filter(f => f.endsWith('.json') && !f.includes('$'))
        .sort(); // ascending version order

      const data = files.flatMap(filename => {
        try {
          return readAndUnwrapFile(join(sprintsDir, filename));
        } catch {
          return [];
        }
      });

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // GET /api/v5/sprints/:version — normalized single sprint for the detail page
  app.get('/api/v5/sprints/:version', async (req, reply) => {
    const { version } = req.params as { version: string };
    try {
      const sprintsDir = join(root, '.agentforge/sprints');
      // Sprint files may be named 'v6.7.1.json' (with prefix) or '6.7.1.json'.
      // Normalise the requested version to its bare form so both URL styles work:
      //   /api/v5/sprints/6.7.1  AND  /api/v5/sprints/v6.7.1
      const bare = version.startsWith('v') ? version.slice(1) : version;
      const filePath = join(sprintsDir, `${bare}.json`);
      const filePathWithV = join(sprintsDir, `v${bare}.json`);
      const resolvedPath = existsSync(filePath) ? filePath
        : existsSync(filePathWithV) ? filePathWithV
        : null;

      if (!resolvedPath) {
        return reply.status(404).send({ error: 'Sprint not found', version });
      }

      const sprints = readAndUnwrapFile(resolvedPath);
      // Match on bare version string (strip leading 'v' from stored value too)
      const data = sprints.find(s => {
        const sv = String(s.version).startsWith('v') ? String(s.version).slice(1) : String(s.version);
        return sv === bare;
      }) ?? sprints[sprints.length - 1];

      if (!data) {
        return reply.status(404).send({ error: 'Sprint not found', version });
      }

      return reply.send({ data, meta: { total: 1 } });
    } catch {
      return reply.status(404).send({ error: 'Sprint not found', version });
    }
  });
}
