/**
 * durability.ts — /api/v5/durability/* routes
 *
 *   GET /api/v5/durability/checkpoints — list in-flight + recently completed
 *     cycle checkpoints, reading .agentforge/cycles/{cycleId}/checkpoint.json on disk.
 *
 * Falls back gracefully when the cycles directory or individual checkpoint
 * files are absent.
 *
 * Path safety: cycleId directory names are validated against a restrictive
 * character set before any filesystem access. Match-then-use pattern ensures
 * the CodeQL path-injection analyzer can trace sanitised values.
 */

import type { FastifyInstance } from 'fastify';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(join(__dirname, '../../../../../'));

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DurabilityRouteOptions {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointRecord {
  cycleId: string;
  phase: string;
  completedItemIds: string[];
  lastUpdatedAt: string;
  /** Seconds since lastUpdatedAt — computed server-side for convenience */
  idleSeconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate and return the cycleId if safe; otherwise return null. */
function parseSafeCycleId(raw: string): string | null {
  const match = /^[a-zA-Z0-9_-]{1,128}$/.exec(raw);
  if (!match) return null;
  return match[0];
}

interface CheckpointJson {
  phase?: unknown;
  completedItemIds?: unknown;
  lastUpdatedAt?: unknown;
  capturedAt?: unknown;
}

function readCheckpoint(
  cyclesBaseDir: string,
  cycleId: string,
): CheckpointRecord | null {
  const safeId = parseSafeCycleId(cycleId);
  if (!safeId) return null;

  const checkpointPath = resolve(join(cyclesBaseDir, safeId, 'checkpoint.json'));
  // Ensure resolved path stays inside cyclesBaseDir (no traversal)
  if (!checkpointPath.startsWith(cyclesBaseDir + '/') && checkpointPath !== cyclesBaseDir) {
    return null;
  }

  if (!existsSync(checkpointPath)) return null;

  let raw: CheckpointJson;
  try {
    raw = JSON.parse(readFileSync(checkpointPath, 'utf8')) as CheckpointJson;
  } catch {
    return null;
  }

  const phase = typeof raw.phase === 'string' ? raw.phase : 'unknown';
  const completedItemIds: string[] = Array.isArray(raw.completedItemIds)
    ? (raw.completedItemIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const lastUpdatedAt =
    typeof raw.lastUpdatedAt === 'string'
      ? raw.lastUpdatedAt
      : typeof raw.capturedAt === 'string'
        ? raw.capturedAt
        : new Date().toISOString();

  const idleSeconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 1000),
  );

  return { cycleId: safeId, phase, completedItemIds, lastUpdatedAt, idleSeconds };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function durabilityRoutes(
  app: FastifyInstance,
  opts: DurabilityRouteOptions = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
  const cyclesBaseDir = resolve(join(projectRoot, '.agentforge', 'cycles'));

  /**
   * GET /api/v5/durability/checkpoints
   *
   * Scans <projectRoot>/.agentforge/cycles/ for subdirectories that contain a
   * checkpoint.json file. Returns them sorted by lastUpdatedAt descending
   * (most recently active first).
   */
  app.get('/api/v5/durability/checkpoints', async (_req, reply) => {
    const checkpoints: CheckpointRecord[] = [];

    if (!existsSync(cyclesBaseDir)) {
      return reply.send({
        data: checkpoints,
        meta: { total: 0, timestamp: new Date().toISOString() },
      });
    }

    let entries: string[] = [];
    try {
      entries = readdirSync(cyclesBaseDir);
    } catch {
      return reply.send({
        data: checkpoints,
        meta: { total: 0, timestamp: new Date().toISOString() },
      });
    }

    for (const entry of entries) {
      // Skip non-directories
      try {
        const fullPath = join(cyclesBaseDir, entry);
        if (!statSync(fullPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const record = readCheckpoint(cyclesBaseDir, entry);
      if (record) checkpoints.push(record);
    }

    // Sort: most recently updated first
    checkpoints.sort(
      (a, b) =>
        new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
    );

    return reply.send({
      data: checkpoints,
      meta: { total: checkpoints.length, timestamp: new Date().toISOString() },
    });
  });
}
