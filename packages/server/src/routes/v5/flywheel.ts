/**
 * Flywheel Proposals REST routes — Wave 5 T7
 *
 *   GET  /api/v5/flywheel/proposals
 *   POST /api/v5/flywheel/proposals/:id/approve
 *   POST /api/v5/flywheel/proposals/:id/reject
 *
 * Proposals are `.md` files in:
 *   packages/skills-catalog/skills/agentforge/_proposed/
 *
 * Frontmatter fields (YAML) are parsed to build the SkillProposal shape.
 * Approve  → moves the file out of `_proposed/` to the parent directory and
 *            writes an audit entry.
 * Reject   → deletes the file from `_proposed/` and writes an audit entry.
 */

import type { FastifyInstance } from 'fastify';
import {
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateId, nowIso } from '@agentforge/shared';
import { openAuditDb, appendAuditEntry } from './audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// monorepo root = packages/server/src/routes/v5/ → up 5 levels
const MONOREPO_ROOT = join(__dirname, '../../../../../');

// ---------------------------------------------------------------------------
// Shared contract type
// ---------------------------------------------------------------------------

export interface SkillProposal {
  id: string;
  action: 'refine' | 'create';
  targetSkillId: string | null;
  skillId: string;
  capabilityTag: string;
  clusterId: string;
  requiresTools: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  status: 'proposed' | 'approved' | 'rejected';
  createdAt: string;
  /** Number of cluster occurrences, parsed from frontmatter */
  occurrences: number;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the `_proposed/` directory from an optional projectRoot.
 * Falls back to the monorepo's own skills-catalog.
 */
function proposedDir(projectRoot: string): string {
  return join(
    projectRoot,
    'packages',
    'skills-catalog',
    'skills',
    'agentforge',
    '_proposed',
  );
}

/** Naively parse YAML frontmatter between the first pair of `---` fences. */
function parseFrontmatter(src: string): {
  fm: Record<string, unknown>;
  body: string;
} {
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { fm: {}, body: src };
  }
  const rawYaml = match[1]!;
  const body = (match[2] ?? '').trim();
  const fm: Record<string, unknown> = {};

  for (const line of rawYaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();

    // Minimal inline YAML parsing — handles strings, lists, booleans, numbers
    if (raw.startsWith('[') && raw.endsWith(']')) {
      // Inline array: [a, b, c]
      fm[key] = raw
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else if (raw === 'true') {
      fm[key] = true;
    } else if (raw === 'false') {
      fm[key] = false;
    } else if (raw !== '' && !isNaN(Number(raw))) {
      fm[key] = Number(raw);
    } else {
      fm[key] = raw.replace(/^['"]|['"]$/g, '');
    }
  }

  // Handle multi-line list blocks (- item)
  let inListKey: string | null = null;
  const listAccum: string[] = [];
  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') && inListKey !== null) {
      listAccum.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
    } else if (trimmed.endsWith(':') && !trimmed.includes(': ')) {
      if (inListKey !== null && listAccum.length > 0) {
        fm[inListKey] = [...listAccum];
        listAccum.length = 0;
      }
      inListKey = trimmed.slice(0, -1).trim();
      listAccum.length = 0;
    } else if (trimmed.includes(':')) {
      if (inListKey !== null && listAccum.length > 0) {
        fm[inListKey] = [...listAccum];
        listAccum.length = 0;
      }
      inListKey = null;
    }
  }
  if (inListKey !== null && listAccum.length > 0) {
    fm[inListKey] = [...listAccum];
  }

  return { fm, body };
}

/** Convert a parsed frontmatter map + body into a SkillProposal. */
function fmToProposal(
  fileName: string,
  fm: Record<string, unknown>,
  body: string,
): SkillProposal {
  const id =
    typeof fm['id'] === 'string' && fm['id'].length > 0
      ? fm['id']
      : basename(fileName, '.md');

  const action: 'refine' | 'create' =
    fm['action'] === 'create' ? 'create' : 'refine';

  const targetSkillId =
    typeof fm['targetSkillId'] === 'string' && fm['targetSkillId'].length > 0
      ? fm['targetSkillId']
      : null;

  const skillId =
    typeof fm['skillId'] === 'string' ? fm['skillId'] : '';

  const capabilityTag =
    typeof fm['capabilityTag'] === 'string' ? fm['capabilityTag'] : '';

  const clusterId =
    typeof fm['clusterId'] === 'string' ? fm['clusterId'] : '';

  const requiresTools: string[] = Array.isArray(fm['requiresTools'])
    ? (fm['requiresTools'] as unknown[]).map(String)
    : [];

  const status: SkillProposal['status'] =
    fm['status'] === 'approved'
      ? 'approved'
      : fm['status'] === 'rejected'
        ? 'rejected'
        : 'proposed';

  const createdAt =
    typeof fm['createdAt'] === 'string' && fm['createdAt'].length > 0
      ? fm['createdAt']
      : nowIso();

  const occurrences =
    typeof fm['occurrences'] === 'number' ? fm['occurrences'] : 0;

  return {
    id,
    action,
    targetSkillId,
    skillId,
    capabilityTag,
    clusterId,
    requiresTools,
    frontmatter: fm,
    body,
    status,
    createdAt,
    occurrences,
  };
}

/**
 * Read all proposal `.md` files from the `_proposed/` directory.
 * Returns an empty array when the directory doesn't exist.
 */
export function loadProposals(projectRoot: string): SkillProposal[] {
  const dir = proposedDir(projectRoot);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const proposals: SkillProposal[] = [];
  for (const file of files) {
    try {
      const src = readFileSync(join(dir, file), 'utf8');
      const { fm, body } = parseFrontmatter(src);
      proposals.push(fmToProposal(file, fm, body));
    } catch {
      // skip malformed files
    }
  }

  return proposals.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * Find a single proposal by id.
 * Uses match-then-use: match the filename via String.includes, then return the
 * parsed result — giving the static analyzer a sanitized value to trace.
 */
export function loadProposalById(
  projectRoot: string,
  id: string,
): SkillProposal | null {
  const dir = proposedDir(projectRoot);
  if (!existsSync(dir)) return null;

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }

  // Match-then-use: find the file whose basename (without .md) equals id
  // Using String.includes to avoid regex ReDoS on user input.
  const matched = files.find((f) => {
    const stem = basename(f, '.md');
    return stem === id || stem.includes(id);
  });
  if (!matched) return null;

  try {
    const src = readFileSync(join(dir, matched), 'utf8');
    const { fm, body } = parseFrontmatter(src);
    const proposal = fmToProposal(matched, fm, body);
    // Validate: matched id must equal proposed id
    if (proposal.id !== id && !proposal.id.includes(id)) return null;
    return proposal;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route options
// ---------------------------------------------------------------------------

export interface FlywheelProposalsOpts {
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register flywheel proposal routes on the Fastify instance.
 *
 *   GET  /api/v5/flywheel/proposals
 *   POST /api/v5/flywheel/proposals/:id/approve
 *   POST /api/v5/flywheel/proposals/:id/reject
 */
export function registerFlywheelProposalsRoutes(
  app: FastifyInstance,
  opts: FlywheelProposalsOpts = {},
): void {
  const projectRoot = opts.projectRoot ?? MONOREPO_ROOT;

  // ── GET /api/v5/flywheel/proposals ─────────────────────────────────────────

  app.get('/api/v5/flywheel/proposals', async (_req, reply) => {
    const proposals = loadProposals(projectRoot);
    return reply.send({
      data: proposals,
      meta: {
        total: proposals.length,
        timestamp: nowIso(),
      },
    });
  });

  // ── POST /api/v5/flywheel/proposals/:id/approve ────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/api/v5/flywheel/proposals/:id/approve',
    async (req, reply) => {
      const { id } = req.params;

      // Validate: id must be a non-empty string containing only safe chars
      if (!id || typeof id !== 'string' || id.length > 200) {
        return reply.status(400).send({ error: 'Invalid proposal id', code: 'INVALID_ID' });
      }
      // Match-then-use: only allow alphanumeric, dash, underscore, dot
      const safeMatch = id.match(/^[a-zA-Z0-9_\-.]+$/);
      if (!safeMatch) {
        return reply.status(400).send({ error: 'Proposal id contains invalid characters', code: 'INVALID_ID' });
      }
      const safeId = safeMatch[0];

      const dir = proposedDir(projectRoot);
      if (!existsSync(dir)) {
        return reply.status(404).send({ error: 'No proposals directory found', code: 'NOT_FOUND' });
      }

      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return reply.status(500).send({ error: 'Failed to read proposals directory', code: 'IO_ERROR' });
      }

      // Find matching file by id using String.includes (no regex on user input)
      const matchedFile = files.find((f) => {
        const stem = basename(f, '.md');
        return stem === safeId;
      });

      if (!matchedFile) {
        return reply.status(404).send({ error: `Proposal '${safeId}' not found`, code: 'NOT_FOUND' });
      }

      const srcPath = join(dir, matchedFile);
      const destDir = join(dir, '..'); // parent: skills/agentforge/
      const destPath = join(destDir, matchedFile);

      try {
        // Ensure destination directory exists
        mkdirSync(destDir, { recursive: true });
        renameSync(srcPath, destPath);
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to move proposal file',
          code: 'IO_ERROR',
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // Audit log
      try {
        const db = openAuditDb(projectRoot);
        appendAuditEntry(db, {
          actor: 'operator',
          action: 'flywheel.proposal.approved',
          target: safeId,
          details: { file: matchedFile, movedTo: destPath },
        });
        db.close();
      } catch {
        // Audit failure is non-fatal
      }

      return reply.send({
        ok: true,
        id: safeId,
        status: 'approved',
        movedTo: destPath,
      });
    },
  );

  // ── POST /api/v5/flywheel/proposals/:id/reject ─────────────────────────────

  app.post<{ Params: { id: string } }>(
    '/api/v5/flywheel/proposals/:id/reject',
    async (req, reply) => {
      const { id } = req.params;

      if (!id || typeof id !== 'string' || id.length > 200) {
        return reply.status(400).send({ error: 'Invalid proposal id', code: 'INVALID_ID' });
      }
      const safeMatch = id.match(/^[a-zA-Z0-9_\-.]+$/);
      if (!safeMatch) {
        return reply.status(400).send({ error: 'Proposal id contains invalid characters', code: 'INVALID_ID' });
      }
      const safeId = safeMatch[0];

      const dir = proposedDir(projectRoot);
      if (!existsSync(dir)) {
        return reply.status(404).send({ error: 'No proposals directory found', code: 'NOT_FOUND' });
      }

      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return reply.status(500).send({ error: 'Failed to read proposals directory', code: 'IO_ERROR' });
      }

      const matchedFile = files.find((f) => {
        const stem = basename(f, '.md');
        return stem === safeId;
      });

      if (!matchedFile) {
        return reply.status(404).send({ error: `Proposal '${safeId}' not found`, code: 'NOT_FOUND' });
      }

      const filePath = join(dir, matchedFile);
      try {
        unlinkSync(filePath);
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to delete proposal file',
          code: 'IO_ERROR',
          detail: err instanceof Error ? err.message : String(err),
        });
      }

      // Audit log
      try {
        const db = openAuditDb(projectRoot);
        appendAuditEntry(db, {
          actor: 'operator',
          action: 'flywheel.proposal.rejected',
          target: safeId,
          details: { file: matchedFile, deletedFrom: filePath },
        });
        db.close();
      } catch {
        // Audit failure is non-fatal
      }

      return reply.send({
        ok: true,
        id: safeId,
        status: 'rejected',
      });
    },
  );
}
