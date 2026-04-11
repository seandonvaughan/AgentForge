import type { FastifyInstance } from 'fastify';
import type { SqliteAdapter } from '../../db/index.js';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../../');

/** A stale branch has no open PR and was created more than STALE_DAYS days ago. */
const STALE_DAYS = 30;

interface PrInfo {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** Full GitHub PR URL, e.g. "https://github.com/owner/repo/pull/42" */
  url: string | null;
}

interface BranchRecord {
  name: string;
  cycle: string;
  sha: string;
  /** ISO 8601 timestamp of the branch tip commit */
  createdAt: string;
  /** Human-readable age string, e.g. "14 days" */
  age: string;
  /** Age in milliseconds for sorting */
  ageMs: number;
  /** Derived status */
  status: 'open_pr' | 'merged' | 'stale' | 'active';
  pr: PrInfo | null;
}

/** Run git, returning stdout as a trimmed string. Returns '' on any error. */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 8_000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Run git, throwing on non-zero exit (so callers can detect failure).
 * Used in the DELETE handler where a git error should surface as an HTTP error.
 */
function gitStrict(args: string[]): string {
  return execFileSync('git', args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout: 8_000,
  }).trim();
}

/** Run gh CLI, returning parsed JSON or null on any error. */
function ghJson<T>(args: string[]): T | null {
  try {
    const raw = execFileSync('gh', args, {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Format milliseconds into a human-readable age string. */
function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Extract the cycle version from a branch name like "autonomous/v6.3.1" → "v6.3.1". */
function parseCycle(branchName: string): string {
  return branchName.replace(/^autonomous\//, '');
}

export async function branchesRoutes(
  app: FastifyInstance,
  _opts: { adapter?: SqliteAdapter }
) {
  // GET /api/v1/branches — list all autonomous/* branches with status
  app.get('/api/v1/branches', async (_req, reply) => {
    try {
      // List autonomous/* branches with their tip SHA and commit date
      const raw = git([
        'for-each-ref',
        '--sort=-creatordate',
        '--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso-strict)',
        'refs/heads/autonomous/',
      ]);

      if (!raw) {
        return reply.send({ data: [], meta: { total: 0 } });
      }

      const lines = raw.split('\n').filter(Boolean);

      // Fetch open/merged PRs for autonomous/* branches in one gh call
      const prs = ghJson<PrInfo[]>([
        'pr', 'list',
        '--search', 'head:autonomous/',
        '--state', 'all',
        '--json', 'number,title,state,headRefName,url',
        '--limit', '100',
      ]) ?? [];

      // Build a lookup map: branchName → PrInfo
      const prMap = new Map<string, PrInfo>();
      for (const pr of prs) {
        const raw = pr as unknown as { headRefName: string; url?: string };
        const branchName = raw.headRefName;
        if (branchName) {
          prMap.set(branchName, {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            url: raw.url ?? null,
          });
        }
      }

      const now = Date.now();
      const staleCutoffMs = STALE_DAYS * 24 * 60 * 60 * 1000;

      const data: BranchRecord[] = lines.map(line => {
        const [name, sha, createdAt] = line.split('\t');
        const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
        const ageMs = now - createdMs;
        const pr = prMap.get(name) ?? null;

        let status: BranchRecord['status'];
        if (pr?.state === 'MERGED') {
          status = 'merged';
        } else if (pr?.state === 'OPEN') {
          status = 'open_pr';
        } else if (ageMs > staleCutoffMs) {
          status = 'stale';
        } else {
          status = 'active';
        }

        return {
          name,
          cycle: parseCycle(name),
          sha: sha ?? '',
          createdAt: createdAt ?? '',
          age: formatAge(ageMs),
          ageMs,
          status,
          pr,
        };
      });

      return reply.send({ data, meta: { total: data.length } });
    } catch {
      return reply.send({ data: [], meta: { total: 0 } });
    }
  });

  // DELETE /api/v1/branches/:name — delete a local autonomous/* branch
  // :name is URL-encoded, e.g. "autonomous%2Fv6.3.1"
  app.delete('/api/v1/branches/:name', async (req, reply) => {
    const { name: encodedName } = req.params as { name: string };
    const branchName = decodeURIComponent(encodedName);

    // Safety: only allow deleting autonomous/* branches
    if (!branchName.startsWith('autonomous/')) {
      return reply.status(400).send({
        error: 'Only autonomous/* branches can be deleted via this endpoint',
        name: branchName,
      });
    }

    // Prevent deleting the currently checked-out branch
    const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch === branchName) {
      return reply.status(409).send({
        error: 'Cannot delete the currently checked-out branch',
        name: branchName,
      });
    }

    try {
      // -D = force delete (mirrors the dashboard intent: stale branch cleanup).
      // gitStrict throws on non-zero exit so we surface git errors as HTTP 500.
      gitStrict(['branch', '-D', branchName]);
      return reply.send({ ok: true, name: branchName });
    } catch {
      return reply.status(500).send({
        error: 'Failed to delete branch',
        name: branchName,
      });
    }
  });
}
