import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Stub endpoints for dashboard pages that need data but don't have full
 * backend implementations yet. These provide sensible defaults and read
 * from file-based data where available.
 */
export async function dashboardStubRoutes(
  app: FastifyInstance,
  opts: { projectRoot?: string } = {},
): Promise<void> {
  const projectRoot = opts.projectRoot ?? process.cwd();

  // ── Flywheel metrics ──────────────────────────────────────────────────────
  // v6.7.4 review fix: the underlying computeFlywheelMetrics() does ~50 sync
  // file reads (every cycle.json, every sprint file, every agent yaml). On a
  // busy server that blocks the Fastify event loop for ~50-200ms per request.
  // Fix: cache the result for 30s. The flywheel display doesn't need
  // sub-second freshness; even a 30s TTL eliminates 99% of repeated I/O.
  let flywheelCache: { at: number; data: ReturnType<typeof computeFlywheelMetrics> } | null = null;
  const FLYWHEEL_TTL_MS = 30_000;
  app.get('/api/v5/flywheel', async (_req, reply) => {
    if (!flywheelCache || Date.now() - flywheelCache.at > FLYWHEEL_TTL_MS) {
      flywheelCache = { at: Date.now(), data: computeFlywheelMetrics(projectRoot) };
    }
    return reply.send({ data: flywheelCache.data, meta: { cachedAtMs: flywheelCache.at } });
  });

  // ── Memory store ──────────────────────────────────────────────────────────
  app.get('/api/v5/memory', async (_req, reply) => {
    // Read memory files from .agentforge if they exist
    const memoryDir = join(projectRoot, '.agentforge/memory');
    const entries: Array<{ id: string; key: string; value: unknown; type: string; createdAt: string }> = [];
    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          entries.push({
            id: file.replace(/\.[^.]+$/, ''),
            key: file.replace(/\.[^.]+$/, ''),
            value: file.endsWith('.json') ? JSON.parse(content) : content.slice(0, 500),
            type: file.endsWith('.json') ? 'json' : 'text',
            createdAt: new Date().toISOString(),
          });
        } catch { /* skip */ }
      }
    }
    return reply.send({ data: entries, meta: { total: entries.length } });
  });

  app.delete('/api/v5/memory/:id', async (req, reply) => {
    return reply.send({ ok: true });
  });

  // ── Autonomous Git Branches ───────────────────────────────────────────────
  // Lists real `autonomous/*` branches from git, enriched with PR status from
  // the `gh` CLI when available. Falls back gracefully if gh is not installed.

  app.get('/api/v5/autonomous-branches', async (_req, reply) => {
    try {
      const data = listAutonomousBranches(projectRoot);
      return reply.send({ data, meta: { total: data.length, updatedAt: new Date().toISOString() } });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });

  // DELETE /api/v5/autonomous-branches/* — delete a stale branch by name.
  //
  // Branch names contain slashes (e.g. "autonomous/v6.8.0"). The frontend
  // sends the full name via encodeURIComponent which produces "autonomous%2Fv6.8.0".
  // Fastify decodes %2F → "/" before routing, so ":name" would only capture
  // the first path segment. A wildcard ("*") captures the full suffix instead.
  app.delete<{ Params: { '*': string } }>(
    '/api/v5/autonomous-branches/*',
    async (req, reply) => {
      // Fastify populates params['*'] with the decoded wildcard suffix
      const branchName = req.params['*'];
      // Safety: only allow deleting branches under the autonomous/ namespace
      if (!branchName.startsWith('autonomous/')) {
        return reply.status(400).send({ error: 'Only autonomous/* branches may be deleted via this endpoint' });
      }
      // Validate against shell-safe characters — branch names are alphanumeric + / . -
      if (!/^autonomous\/[a-zA-Z0-9._/-]+$/.test(branchName)) {
        return reply.status(400).send({ error: 'Invalid branch name format' });
      }
      // Use spawnSync with explicit arg array — no shell, no injection risk
      const result = spawnSync('git', ['-C', projectRoot, 'branch', '-D', branchName], { encoding: 'utf-8' });
      if (result.status !== 0) {
        return reply.status(500).send({ error: `Delete failed: ${(result.stderr ?? '').trim() || 'unknown error'}` });
      }
      return reply.send({ ok: true, deleted: branchName });
    },
  );
}

// ── CycleRecord ────────────────────────────────────────────────────────────

interface CycleRecord {
  cycleId: string;
  sprintVersion?: string;
  stage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  cost?: { totalUsd?: number; budgetUsd?: number };
  tests?: { passed?: number; failed?: number; total?: number; passRate?: number };
  git?: { branch?: string; commitSha?: string; filesChanged?: string[] };
  pr?: { url?: string | null; number?: number | null };
}

interface SprintItem {
  id?: string;
  status?: string;
}

interface SprintRecord {
  version?: string;
  items?: SprintItem[];
  phase?: string;
}

// ── metric computation ─────────────────────────────────────────────────────

function computeFlywheelMetrics(projectRoot: string) {
  // ── Cycles ────────────────────────────────────────────────────────────────
  const cyclesDir = join(projectRoot, '.agentforge/cycles');
  const cycles: CycleRecord[] = [];
  if (existsSync(cyclesDir)) {
    for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cycleFile = join(cyclesDir, entry.name, 'cycle.json');
      if (!existsSync(cycleFile)) continue;
      try {
        const raw = JSON.parse(readFileSync(cycleFile, 'utf-8')) as CycleRecord;
        cycles.push(raw);
      } catch { /* skip malformed */ }
    }
  }

  // Sort by start time ascending so trend math is chronological
  cycles.sort((a, b) => {
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return ta - tb;
  });

  // Meaningful cycles have real test data (passRate > 0 or stage 'completed')
  const meaningfulCycles = cycles.filter(
    c => c.stage === 'completed' || (c.tests?.passRate ?? 0) > 0,
  );
  const completedCycles = cycles.filter(c => c.stage === 'completed');

  // ── Sprints ───────────────────────────────────────────────────────────────
  const sprintsDir = join(projectRoot, '.agentforge/sprints');
  const sprints: SprintRecord[] = [];
  if (existsSync(sprintsDir)) {
    for (const file of readdirSync(sprintsDir).filter(f => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(readFileSync(join(sprintsDir, file), 'utf-8'));
        // Sprint file may be { sprints: [...] } or the sprint object directly
        if (Array.isArray(raw.sprints)) {
          sprints.push(...(raw.sprints as SprintRecord[]));
        } else if (raw.items) {
          sprints.push(raw as SprintRecord);
        }
      } catch { /* skip */ }
    }
  }

  let totalItems = 0;
  let completedItems = 0;
  for (const s of sprints) {
    const items = s.items ?? [];
    totalItems += items.length;
    completedItems += items.filter(i => i.status === 'completed').length;
  }

  // ── Agents ────────────────────────────────────────────────────────────────
  const agentsDir = join(projectRoot, '.agentforge/agents');
  let agentCount = 0;
  if (existsSync(agentsDir)) {
    agentCount = readdirSync(agentsDir).filter(f => f.endsWith('.yaml')).length;
  }

  // ── 1. Meta-Learning Rate ─────────────────────────────────────────────────
  // Measures how much the system improves between cycles.
  // Components:
  //   (a) Sprint count — more iterations = more learning surface
  //   (b) Pass-rate trend — if recent cycles have higher pass rates than early
  //       ones, the loop is genuinely improving
  const sprintCount = sprints.length;
  const iterationBase = Math.min(100, Math.round((sprintCount / 32) * 60)); // 32 sprints → 60 pts

  let trendBonus = 0;
  const ratedCycles = meaningfulCycles.filter(c => (c.tests?.passRate ?? 0) > 0);
  if (ratedCycles.length >= 2) {
    const half = Math.floor(ratedCycles.length / 2);
    const earlyAvg = ratedCycles.slice(0, half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
    const lateAvg = ratedCycles.slice(-half).reduce((s, c) => s + (c.tests?.passRate ?? 0), 0) / half;
    // If late pass rates are higher, reward; if lower, penalise (capped)
    trendBonus = Math.max(-20, Math.min(40, Math.round((lateAvg - earlyAvg) * 400)));
  } else if (ratedCycles.length === 1) {
    // Single data point: reward the act of completing a real cycle
    trendBonus = 10;
  }
  const metaLearningScore = Math.max(0, Math.min(100, iterationBase + trendBonus));

  // ── 2. Autonomy Score ─────────────────────────────────────────────────────
  // How well is the loop running without human intervention?
  // = completed cycles / meaningful cycles (success rate), weighted by
  //   whether PRs are being opened (full pipeline execution).
  let autonomyScore = 0;
  if (meaningfulCycles.length > 0) {
    const successRate = completedCycles.length / meaningfulCycles.length;
    // Bonus if any completed cycle shipped a real PR
    const prBonus = completedCycles.some(c => c.pr?.number != null) ? 10 : 0;
    autonomyScore = Math.min(100, Math.round(successRate * 90 + prBonus));
  }

  // ── 3. Capability Inheritance ─────────────────────────────────────────────
  // How much specialisation has the team accumulated?
  // Agent count is the primary signal; we normalise against a soft ceiling.
  // Secondary signal: are cycles producing file-level evidence of agent work?
  const AGENT_CEILING = 150; // soft target — update as team grows
  const agentBase = Math.round((agentCount / AGENT_CEILING) * 80);
  // Bonus: each meaningful cycle that modified files shows agents are active
  const cycleFileBonus = Math.min(20, meaningfulCycles.filter(
    c => (c.git?.filesChanged?.length ?? 0) > 0,
  ).length * 5);
  const inheritanceScore = Math.min(100, agentBase + cycleFileBonus);

  // ── 4. Velocity ───────────────────────────────────────────────────────────
  // Sprint-item completion rate across all sprints, blended with cycle
  // throughput (how many meaningful cycles have been run).
  let velocityScore = 0;
  if (totalItems > 0) {
    const itemRate = completedItems / totalItems; // 0-1
    // Scale: 100% completion = 70 pts; remaining 30 from cycle throughput
    const cycleThroughput = Math.min(30, meaningfulCycles.length * 5);
    velocityScore = Math.min(100, Math.round(itemRate * 70 + cycleThroughput));
  } else if (meaningfulCycles.length > 0) {
    velocityScore = Math.min(100, meaningfulCycles.length * 10);
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const overallScore = Math.round(
    (metaLearningScore + autonomyScore + inheritanceScore + velocityScore) / 4,
  );

  const descriptions = {
    meta_learning: ratedCycles.length > 1
      ? `${sprintCount} sprint iterations; pass-rate trend across ${ratedCycles.length} cycles`
      : `${sprintCount} sprint iterations`,
    autonomy: meaningfulCycles.length > 0
      ? `${completedCycles.length}/${meaningfulCycles.length} cycles completed autonomously`
      : 'No cycle data yet',
    inheritance: `${agentCount} agents; ${meaningfulCycles.length} cycles with file evidence`,
    velocity: totalItems > 0
      ? `${completedItems}/${totalItems} sprint items completed`
      : `${meaningfulCycles.length} meaningful cycles`,
  };

  return {
    metrics: [
      { key: 'meta_learning', label: 'Meta-Learning', score: metaLearningScore, description: descriptions.meta_learning },
      { key: 'autonomy', label: 'Autonomy', score: autonomyScore, description: descriptions.autonomy },
      { key: 'inheritance', label: 'Inheritance', score: inheritanceScore, description: descriptions.inheritance },
      { key: 'velocity', label: 'Velocity', score: velocityScore, description: descriptions.velocity },
    ],
    overallScore,
    updatedAt: new Date().toISOString(),
    // Raw counts for debugging / future UI panels
    debug: {
      cycleCount: cycles.length,
      meaningfulCycleCount: meaningfulCycles.length,
      completedCycleCount: completedCycles.length,
      sprintCount,
      agentCount,
      totalItems,
      completedItems,
    },
  };
}

// ── Autonomous Branch Listing ─────────────────────────────────────────────

export interface AutonomousBranch {
  name: string;
  cycle: string;
  /** ISO timestamp of the most recent commit on this branch */
  lastCommitAt: string;
  /** Age of the last commit in milliseconds */
  ageMs: number;
  /** Derived status: open-pr | merged | stale */
  status: 'open-pr' | 'merged' | 'stale';
  prNumber: number | null;
  prUrl: string | null;
}

interface GhPr {
  headRefName: string;
  state: string;
  number: number;
  url: string;
  mergedAt: string | null;
}

/**
 * List all `autonomous/*` local branches enriched with PR status.
 *
 * Uses `git for-each-ref` (always available) and `gh pr list` (optional).
 * A branch is "stale" when it has no open PR and its last commit is older
 * than STALE_DAYS days.
 */
function listAutonomousBranches(cwd: string): AutonomousBranch[] {
  const STALE_DAYS = 3;
  const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;

  // -- 1. Enumerate local autonomous/* branches via git for-each-ref ----------
  const gitResult = spawnSync(
    'git',
    [
      '-C', cwd,
      'for-each-ref',
      '--format=%(refname:short)%09%(creatordate:iso8601)',
      'refs/heads/autonomous/',
    ],
    { encoding: 'utf-8' },
  );

  if (gitResult.status !== 0 || !gitResult.stdout) return [];

  const localBranches: Array<{ name: string; lastCommitAt: string }> = gitResult.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const branchName = parts[0] ?? '';
      const lastCommitAt = parts.slice(1).join('\t').trim();
      return { name: branchName.trim(), lastCommitAt };
    })
    .filter((b) => b.name.startsWith('autonomous/'));

  // -- 2. Fetch PR list from gh CLI (best-effort) ----------------------------
  const prsByBranch = new Map<string, GhPr[]>();
  const ghResult = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'headRefName,state,number,url,mergedAt'],
    { encoding: 'utf-8', cwd },
  );

  if (ghResult.status === 0 && ghResult.stdout) {
    try {
      const prs = JSON.parse(ghResult.stdout) as GhPr[];
      for (const pr of prs) {
        if (!pr.headRefName.startsWith('autonomous/')) continue;
        const existing = prsByBranch.get(pr.headRefName) ?? [];
        existing.push(pr);
        prsByBranch.set(pr.headRefName, existing);
      }
    } catch { /* gh output not parseable — ignore */ }
  }

  // -- 3. Build result -------------------------------------------------------
  return localBranches.map(({ name, lastCommitAt }) => {
    const cycle = name.replace(/^autonomous\//, '');
    const lastCommitDate = new Date(lastCommitAt);
    const ageMs = Date.now() - lastCommitDate.getTime();

    const prs = prsByBranch.get(name) ?? [];
    const openPr = prs.find((p) => p.state === 'OPEN');
    const mergedPr = prs.find((p) => p.state === 'MERGED' || p.mergedAt != null);

    let status: AutonomousBranch['status'];
    let prNumber: number | null = null;
    let prUrl: string | null = null;

    if (openPr) {
      status = 'open-pr';
      prNumber = openPr.number;
      prUrl = openPr.url;
    } else if (mergedPr) {
      status = 'merged';
      prNumber = mergedPr.number;
      prUrl = mergedPr.url;
    } else {
      status = ageMs > STALE_MS ? 'stale' : 'open-pr'; // treat fresh branches without PRs as active
      const firstPr = prs.at(0);
      if (firstPr) {
        prNumber = firstPr.number;
        prUrl = firstPr.url;
      }
    }

    return {
      name,
      cycle,
      lastCommitAt: lastCommitDate.toISOString(),
      ageMs,
      status,
      prNumber,
      prUrl,
    };
  });
}
