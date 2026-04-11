import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getWorkspace } from '@agentforge/core';

// ── Memory display helpers ─────────────────────────────────────────────────

/**
 * Generate a concise human-readable summary for a memory entry's Value
 * column preview in the dashboard table. Returns undefined for unrecognised
 * types so the dashboard falls back to its own formatting logic.
 */
function buildMemorySummary(
  type: string,
  parsedValue: unknown,
  rawValue: string | undefined,
): string | undefined {
  const obj = parsedValue !== null && typeof parsedValue === 'object'
    ? parsedValue as Record<string, unknown>
    : null;

  if (type === 'cycle-outcome' && obj) {
    const stage = typeof obj.stage === 'string' ? obj.stage : '';
    const ver   = typeof obj.sprintVersion === 'string' ? `v${obj.sprintVersion}` : '';
    const tests = obj.testsPassed != null ? `${obj.testsPassed} tests` : '';
    const cost  = obj.costUsd != null ? `$${Number(obj.costUsd).toFixed(2)}` : '';
    return [ver, stage, tests, cost].filter(Boolean).join(' · ');
  }

  if (type === 'gate-verdict' && obj) {
    const verdict = typeof obj.verdict === 'string' ? obj.verdict : '';
    const ver     = typeof obj.sprintVersion === 'string' ? `v${obj.sprintVersion}` : '';
    // Omit criticalFindings from the summary — they can be long nested JSON;
    // the expanded detail view shows the full rationale instead.
    return [ver, verdict].filter(Boolean).join(' · ') || undefined;
  }

  if (type === 'review-finding' && obj) {
    const rat = typeof obj.rationale === 'string' ? obj.rationale : '';
    return rat.slice(0, 140) || undefined;
  }

  if (type === 'failure-pattern' && obj) {
    const desc = typeof obj.description === 'string' ? obj.description : '';
    return desc.slice(0, 140) || undefined;
  }

  if (type === 'learned-fact' && obj) {
    const fact = typeof obj.fact === 'string' ? obj.fact
      : typeof obj.value === 'string' ? obj.value : '';
    return fact.slice(0, 140) || undefined;
  }

  // Generic fallback: first 120 chars of raw string value.
  return rawValue ? rawValue.slice(0, 120) : undefined;
}

/**
 * Build a human-readable key for the dashboard's "Key" column.
 * For cycle-outcome and gate-verdict entries, include the sprint version
 * so rows of the same type are distinguishable at a glance.
 */
function buildMemoryKey(type: string, parsedValue: unknown): string {
  const obj = parsedValue !== null && typeof parsedValue === 'object'
    ? parsedValue as Record<string, unknown>
    : null;
  if (!obj) return type;

  const ver = typeof obj.sprintVersion === 'string' ? obj.sprintVersion : null;
  if (ver && (type === 'cycle-outcome' || type === 'gate-verdict')) {
    return `${type} · ${ver}`;
  }
  return type;
}

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
  //
  // v9.0.2: per-workspace cache so ?workspaceId= queries don't share state.
  const flywheelCacheByRoot = new Map<string, { at: number; data: ReturnType<typeof computeFlywheelMetrics> }>();
  const FLYWHEEL_TTL_MS = 30_000;
  app.get('/api/v5/flywheel', async (req, reply) => {
    // Resolve workspace root from optional ?workspaceId= query param (mirrors
    // the pattern used by GET /api/v5/cycles so both views stay in sync when
    // the user has a non-default workspace selected).
    const q = req.query as { workspaceId?: string };
    let root = projectRoot;
    if (q.workspaceId) {
      const ws = getWorkspace(q.workspaceId);
      if (ws) root = ws.path;
    }

    const cached = flywheelCacheByRoot.get(root);
    if (!cached || Date.now() - cached.at > FLYWHEEL_TTL_MS) {
      flywheelCacheByRoot.set(root, { at: Date.now(), data: computeFlywheelMetrics(root) });
    }
    const entry = flywheelCacheByRoot.get(root)!;
    return reply.send({ data: entry.data, meta: { cachedAtMs: entry.at } });
  });

  // ── Memory store ──────────────────────────────────────────────────────────
  //
  // GET /api/v5/memory
  //
  // Returns up to 200 memory entries (newest first) read from
  // .agentforge/memory/*.jsonl.  Legacy .json and .md files in the same
  // directory are still served for backward compatibility.
  //
  // Optional query params:
  //   type    — exact match on the entry's `type` field (e.g. "cycle-outcome")
  //   since   — ISO-8601 timestamp; only entries with createdAt >= since
  //   agentId — exact match on the entry's `agentId` / `source` field
  //   search  — case-insensitive substring across key, value, summary, tags
  //
  // Response shape:
  //   { data: DashboardMemoryEntry[], agents: string[], types: string[],
  //     meta: { total: number, limit: number } }
  const MEMORY_LIMIT = 200;

  app.get('/api/v5/memory', async (req, reply) => {
    const q = req.query as {
      type?: string;
      since?: string;
      agentId?: string;
      /** Legacy alias for agentId — accepted for backward compatibility. */
      agent?: string;
      search?: string;
    };
    const typeFilter = q.type?.trim() ?? '';
    // Accept both `agentId` (canonical) and `agent` (legacy alias from the
    // memory.html page overlay and the v1 API callers).
    const agentIdFilter = (q.agentId ?? q.agent ?? '').trim();
    // Normalised to lowercase so the search is case-insensitive.
    const searchTerm = (q.search ?? '').toLowerCase().trim();
    // Parse `since` once; ignore if not a valid date.
    const sinceMs = q.since ? new Date(q.since).getTime() : NaN;
    const hasSince = !Number.isNaN(sinceMs);

    const memoryDir = join(projectRoot, '.agentforge/memory');

    // Shape the dashboard expects for each row.
    interface DashboardMemoryEntry {
      id: string;
      key: string;
      value: unknown;
      type: string;
      createdAt: string;
      updatedAt?: string;
      agentId?: string;
      /** Original source field (cycleId or agentId) from the JSONL entry. */
      source?: string;
      summary?: string;
      tags?: string[];
    }

    const entries: DashboardMemoryEntry[] = [];

    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir);

      // ── JSONL files (primary path): each line is a CycleMemoryEntry ──────
      // Written by writeMemoryEntry() as .agentforge/memory/<type>.jsonl
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
      for (const file of jsonlFiles) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          const lines = content.split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as {
                id?: string;
                type?: string;
                value?: string;
                createdAt?: string;
                source?: string;
                tags?: string[];
              };
              const id = entry.id ?? `${file}-${entries.length}`;
              const type = entry.type ?? file.replace(/\.jsonl$/, '');
              const createdAt = entry.createdAt ?? new Date().toISOString();

              // Parse value: JSONL stores it as a JSON-encoded string.
              // Convert to an object so the dashboard can display it with
              // proper syntax highlighting instead of a raw string blob.
              let parsedValue: unknown = entry.value ?? '';
              if (typeof parsedValue === 'string' && parsedValue.startsWith('{')) {
                try { parsedValue = JSON.parse(parsedValue); } catch { /* keep as string */ }
              }

              // Generate a type-specific human-readable summary for the
              // Value column preview and the expanded detail view.
              const summary = buildMemorySummary(type, parsedValue, entry.value);

              // Use a version-aware key for cycle-outcome so the "Key" column
              // shows e.g. "9.2.0 · failed" rather than the same type name for
              // every row — makes the table scannable at a glance.
              const key = buildMemoryKey(type, parsedValue);

              // With exactOptionalPropertyTypes, omit optional fields rather than
              // setting them to undefined — use conditional spread instead.
              entries.push({
                id,
                key,
                value: parsedValue,
                type,
                createdAt,
                updatedAt: createdAt,
                // source is cycleId or agentId produced by phase handlers.
                // Expose both as agentId (existing agent-filter UI) and source
                // (new source-link UI in the memory dashboard).
                ...(entry.source !== undefined ? { agentId: entry.source, source: entry.source } : {}),
                ...(summary !== undefined ? { summary } : {}),
                ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
              });
            } catch { /* skip malformed line */ }
          }
        } catch { /* skip unreadable file */ }
      }

      // ── Legacy JSON / Markdown files (fallback for older data) ───────────
      const legacyFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const file of legacyFiles) {
        try {
          const content = readFileSync(join(memoryDir, file), 'utf-8');
          const stem = file.replace(/\.[^.]+$/, '');
          entries.push({
            id: stem,
            key: stem,
            value: file.endsWith('.json') ? JSON.parse(content) : content.slice(0, 500),
            type: file.endsWith('.json') ? 'json' : 'text',
            createdAt: new Date().toISOString(),
          });
        } catch { /* skip */ }
      }
    }

    // ── Operator-curated memories (.agentforge/data/memories.json) ──────────
    //
    // Always merged alongside live JSONL entries so that cross-cycle learned
    // knowledge (feedback, lessons, project notes) surfaces in the dashboard
    // even after the system starts accumulating real cycle data.
    //
    // Previously this was a conditional fallback (only read when entries was
    // empty) which caused the curated knowledge base to disappear entirely once
    // any JSONL file was written — the root cause of the "static content" bug.
    //
    // Deduplication by `id` prevents double-entries when a memory is promoted
    // from the curated JSON into a JSONL file with the same stable identifier.
    const seenIds = new Set<string>(entries.map(e => e.id).filter(Boolean) as string[]);

    const memoriesJsonPath = join(projectRoot, '.agentforge/data/memories.json');
    if (existsSync(memoriesJsonPath)) {
      try {
        const raw = readFileSync(memoriesJsonPath, 'utf-8');
        const curated = JSON.parse(raw) as {
          entries?: Array<{
            id?: string;
            filename?: string;
            category?: string;
            agentId?: string;
            summary?: string;
            tags?: string[];
            createdAt?: string;
            updatedAt?: string;
          }>;
        };
        const curatedEntries = Array.isArray(curated.entries) ? curated.entries : [];
        for (const e of curatedEntries) {
          const id = e.id ?? `curated-${entries.length}`;
          // Skip if this id was already contributed by a JSONL or legacy file.
          if (seenIds.has(id)) continue;
          seenIds.add(id);
          // Strip common extensions for a clean display key.
          const key = (e.filename ?? id).replace(/\.(md|json)$/, '');
          entries.push({
            id,
            key,
            // Use summary as the preview value — it's the most human-readable field.
            value: e.summary ?? '',
            // Category maps 1-to-1 to the frontend's type-chip filter row.
            type: e.category ?? 'memory',
            createdAt: e.createdAt ?? new Date().toISOString(),
            ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
            ...(e.agentId   ? { agentId:   e.agentId }   : {}),
            ...(e.summary   ? { summary:   e.summary }   : {}),
            ...(e.tags      ? { tags:      e.tags }      : {}),
          });
        }
      } catch { /* skip malformed memories.json */ }
    }

    // Newest entries first so the dashboard shows recent learning at the top.
    entries.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });

    // Cap to MEMORY_LIMIT newest entries before filtering so that the
    // agents/types dropdown lists reflect the real recent window — not the
    // full history, which can be very large.
    const recent = entries.slice(0, MEMORY_LIMIT);

    // Unique agent/source IDs for the dashboard's agent-filter dropdown.
    const agents = [...new Set(
      recent.map(e => e.agentId).filter((a): a is string => Boolean(a)),
    )];

    // Unique entry types for the dashboard's type-chip filter row.
    const types = [...new Set(
      recent.map(e => e.type).filter((t): t is string => Boolean(t)),
    )].sort();

    // Apply optional query filters to the capped window.
    const filtered = recent.filter(e => {
      if (typeFilter && e.type !== typeFilter) return false;
      if (agentIdFilter && e.agentId !== agentIdFilter) return false;
      if (hasSince) {
        const entryMs = e.createdAt ? new Date(e.createdAt).getTime() : 0;
        if (entryMs < sinceMs) return false;
      }
      // Full-text search across key, value, summary, and tags.
      if (searchTerm) {
        const valueStr = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
        const haystack = [e.key, valueStr, e.summary ?? '', (e.tags ?? []).join(' ')]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(searchTerm)) return false;
      }
      return true;
    });

    return reply.send({
      data: filtered,
      agents,
      types,
      meta: { total: filtered.length, limit: MEMORY_LIMIT },
    });
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

interface SessionRecord {
  /** Task UUID — present on all real session files. */
  task_id?: string;
  /** Whether the agent judged its own task as fully complete. */
  is_request_satisfied?: boolean;
  /** 0–1 self-confidence score the agent reported at the end of the session. */
  confidence?: number;
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

  // ── Sessions ──────────────────────────────────────────────────────────────
  // Agent task execution sessions provide a sub-cycle health signal.
  // Files are {task_id}-{timestamp}.json; sorting alphabetically gives
  // chronological order because the numeric timestamp is part of the name.
  const sessionsDir = join(projectRoot, '.agentforge/sessions');
  const sessions: SessionRecord[] = [];
  if (existsSync(sessionsDir)) {
    for (const file of readdirSync(sessionsDir).filter(f => f.endsWith('.json')).sort()) {
      try {
        const raw = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8')) as SessionRecord;
        if (raw.task_id) sessions.push(raw);
      } catch { /* skip malformed */ }
    }
  }

  const satisfiedSessions = sessions.filter(s => s.is_request_satisfied === true).length;
  const sessionSuccessRate = sessions.length > 0 ? satisfiedSessions / sessions.length : null;

  // Session confidence trend: compare early vs. recent confidence scores.
  // A rising trend means agents are becoming more decisive over time.
  const confSessions = sessions
    .map(s => s.confidence ?? null)
    .filter((c): c is number => c !== null);
  let sessionConfidenceBonus = 0;
  if (confSessions.length >= 4) {
    const half = Math.floor(confSessions.length / 2);
    const earlyConf = confSessions.slice(0, half).reduce((s, c) => s + c, 0) / half;
    const lateConf = confSessions.slice(-half).reduce((s, c) => s + c, 0) / half;
    // Rising confidence → up to +10 pts; falling confidence → down to -10 pts
    sessionConfidenceBonus = Math.max(-10, Math.min(10, Math.round((lateConf - earlyConf) * 50)));
  }

  // ── 1. Meta-Learning Rate ─────────────────────────────────────────────────
  // Measures how much the system improves between cycles.
  // Components:
  //   (a) Sprint count — more iterations = more learning surface
  //   (b) Pass-rate trend — if recent cycles have higher pass rates than early
  //       ones, the loop is genuinely improving
  //   (c) Session confidence trend — rising confidence is a sub-cycle signal
  //       that agents are becoming more decisive and self-directed
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
  const metaLearningScore = Math.max(0, Math.min(100, iterationBase + trendBonus + sessionConfidenceBonus));

  // Derive a trend direction label from the component scores.
  // trendBonus maps to a delta of ±5% pass-rate (equivalent to legacy threshold).
  // sessionConfidenceBonus provides a secondary signal when no rated cycles exist.
  const metaTrend: 'improving' | 'stable' | 'declining' =
    trendBonus >= 20 ? 'improving' :
    trendBonus <= -20 ? 'declining' :
    sessionConfidenceBonus > 5 ? 'improving' :
    sessionConfidenceBonus < -5 ? 'declining' :
    'stable';

  // ── 2. Autonomy Score ─────────────────────────────────────────────────────
  // How well is the loop running without human intervention?
  // Primary signal: completed cycles / meaningful cycles (full pipeline success).
  // Secondary signal: session success rate (sub-task autonomy).
  // When both exist we blend 60% cycle + 40% session to keep the harder
  // pipeline signal dominant. If no cycles exist yet, sessions seed the score
  // (capped at 40 so it rises meaningfully once full cycles start running).
  let autonomyScore = 0;
  if (meaningfulCycles.length > 0) {
    const cycleSuccessRate = completedCycles.length / meaningfulCycles.length;
    // Bonus if any completed cycle shipped a real PR
    const prBonus = completedCycles.some(c => c.pr?.number != null) ? 10 : 0;
    const blendedRate = sessionSuccessRate !== null
      ? cycleSuccessRate * 0.6 + sessionSuccessRate * 0.4
      : cycleSuccessRate;
    autonomyScore = Math.min(100, Math.round(blendedRate * 90 + prBonus));
  } else if (sessionSuccessRate !== null && sessions.length >= 3) {
    autonomyScore = Math.min(40, Math.round(sessionSuccessRate * 40));
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
  // Sprint-item completion rate across all sprints, blended with cycle and
  // session throughput.
  // Session throughput: every 2 satisfied sessions adds 1 pt, capped at 15.
  // This rewards rapid sub-task iteration even when sprint items are broad.
  let velocityScore = 0;
  if (totalItems > 0) {
    const itemRate = completedItems / totalItems; // 0-1
    const cycleThroughput = Math.min(30, meaningfulCycles.length * 5);
    const sessionBoost = Math.min(15, Math.floor(satisfiedSessions / 2));
    velocityScore = Math.min(100, Math.round(itemRate * 70 + cycleThroughput + sessionBoost));
  } else if (meaningfulCycles.length > 0) {
    velocityScore = Math.min(100, meaningfulCycles.length * 10);
  } else if (sessions.length > 0) {
    // No sprint data yet — seed velocity from raw session throughput.
    velocityScore = Math.min(30, satisfiedSessions * 3);
  }

  // ── Memory Stats ─────────────────────────────────────────────────────────
  // Read all JSONL memory entries to compute:
  //   totalEntries           — raw count across all entry types
  //   entriesPerCycleTrend   — per-cycle write counts for the last 12 cycles
  //   hitRate                — fraction of completed cycles that had prior
  //                            memory available when they started
  const memoryStats = computeMemoryStats(projectRoot, cycles, completedCycles);

  // ── Assemble ──────────────────────────────────────────────────────────────
  const overallScore = Math.round(
    (metaLearningScore + autonomyScore + inheritanceScore + velocityScore) / 4,
  );

  const avgConf = confSessions.length > 0
    ? Math.round((confSessions.reduce((s, c) => s + c, 0) / confSessions.length) * 100)
    : null;

  const descriptions = {
    meta_learning: ratedCycles.length > 1
      ? `${sprintCount} sprint iterations; pass-rate ${metaTrend} across ${ratedCycles.length} cycles`
      : avgConf !== null
        ? `${sprintCount} sprint iterations; session confidence avg ${avgConf}% — ${metaTrend}`
        : `${sprintCount} sprint iterations — ${metaTrend}`,
    autonomy: meaningfulCycles.length > 0
      ? `${completedCycles.length}/${meaningfulCycles.length} cycles; ${satisfiedSessions}/${sessions.length} sessions satisfied`
      : sessions.length > 0
        ? `${satisfiedSessions}/${sessions.length} sessions satisfied`
        : 'No cycle data yet',
    inheritance: `${agentCount} agents; ${meaningfulCycles.length} cycles with file evidence`,
    velocity: totalItems > 0
      ? `${completedItems}/${totalItems} sprint items; ${satisfiedSessions} sessions completed`
      : sessions.length > 0
        ? `${satisfiedSessions}/${sessions.length} sessions satisfied`
        : `${meaningfulCycles.length} meaningful cycles`,
  };

  return {
    metrics: [
      { key: 'meta_learning', label: 'Meta-Learning', score: metaLearningScore, description: descriptions.meta_learning, trend: metaTrend },
      { key: 'autonomy', label: 'Autonomy', score: autonomyScore, description: descriptions.autonomy },
      { key: 'inheritance', label: 'Inheritance', score: inheritanceScore, description: descriptions.inheritance },
      { key: 'velocity', label: 'Velocity', score: velocityScore, description: descriptions.velocity },
    ],
    overallScore,
    updatedAt: new Date().toISOString(),
    // Raw counts for the Loop Data panel and debugging
    debug: {
      cycleCount: cycles.length,
      meaningfulCycleCount: meaningfulCycles.length,
      completedCycleCount: completedCycles.length,
      sprintCount,
      agentCount,
      totalItems,
      completedItems,
      sessionCount: sessions.length,
      satisfiedSessionCount: satisfiedSessions,
    },
    memoryStats,
  };
}

// ── Memory Stats Computation ───────────────────────────────────────────────

interface MemoryRawEntry {
  source?: string;
  createdAt?: string;
}

interface CycleEntryPoint {
  cycleId: string;
  count: number;
  startedAt: string;
}

interface MemoryStats {
  totalEntries: number;
  entriesPerCycleTrend: CycleEntryPoint[];
  hitRate: number;
}

/**
 * Scan `.agentforge/memory/*.jsonl` and derive three metrics for the flywheel
 * memory stats card:
 *
 *  totalEntries         — total rows across all JSONL files
 *  entriesPerCycleTrend — per-cycle write count for the most recent 12 cycles
 *                         (chronological order, using the cycle's startedAt)
 *  hitRate              — fraction of completed cycles whose startedAt is
 *                         strictly after the earliest memory entry's createdAt.
 *                         This is the best proxy we can compute without an
 *                         explicit "memory consulted" event: if memory existed
 *                         before the cycle began, the audit phase had context
 *                         available to influence the plan.
 */
function computeMemoryStats(
  projectRoot: string,
  cycles: CycleRecord[],
  completedCycles: CycleRecord[],
): MemoryStats {
  const memoryDir = join(projectRoot, '.agentforge/memory');

  let totalEntries = 0;
  // cycleId → number of memory entries written by that cycle (via `source`)
  const entriesByCycleId = new Map<string, number>();
  // Creation timestamps of all entries, sorted ascending, for hit-rate calc
  const allEntryTimesMs: number[] = [];

  if (existsSync(memoryDir)) {
    const jsonlFiles = readdirSync(memoryDir).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      try {
        const content = readFileSync(join(memoryDir, file), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as MemoryRawEntry;
            totalEntries++;
            const createdMs = entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
            allEntryTimesMs.push(createdMs);
            if (entry.source) {
              entriesByCycleId.set(entry.source, (entriesByCycleId.get(entry.source) ?? 0) + 1);
            }
          } catch { /* skip malformed line */ }
        }
      } catch { /* skip unreadable file */ }
    }
  }

  allEntryTimesMs.sort((a, b) => a - b);

  // Trend: last 12 cycles (already sorted ascending by startedAt) with their
  // per-cycle entry counts.  Cycles with 0 entries are included so the chart
  // accurately shows silent cycles.
  const TREND_LIMIT = 12;
  const entriesPerCycleTrend: CycleEntryPoint[] = cycles.slice(-TREND_LIMIT).map(c => ({
    cycleId: c.cycleId,
    count: entriesByCycleId.get(c.cycleId) ?? 0,
    startedAt: c.startedAt ?? new Date().toISOString(),
  }));

  // Hit rate: prefer the precise `memoriesInjected` count written to each
  // cycle's audit.json by the audit phase handler (added in v9.0.x).
  // For cycles that pre-date this field (no audit.json or memoriesInjected
  // absent), fall back to the timestamp proxy: a cycle "hit" if it started
  // after the earliest memory entry existed.
  const earliestEntryMs = allEntryTimesMs.at(0) ?? Infinity;

  const hitCount = completedCycles.filter(c => {
    const auditJsonPath = join(
      projectRoot,
      '.agentforge',
      'cycles',
      c.cycleId,
      'phases',
      'audit.json',
    );
    if (existsSync(auditJsonPath)) {
      try {
        const auditData = JSON.parse(readFileSync(auditJsonPath, 'utf-8')) as {
          memoriesInjected?: number;
        };
        if (typeof auditData.memoriesInjected === 'number') {
          return auditData.memoriesInjected > 0;
        }
      } catch { /* fall through to proxy */ }
    }
    // Timestamp proxy fallback for older cycles lacking audit.json
    const startMs = c.startedAt ? new Date(c.startedAt).getTime() : 0;
    return startMs > earliestEntryMs;
  }).length;

  const hitRate = completedCycles.length > 0 ? hitCount / completedCycles.length : 0;

  return { totalEntries, entriesPerCycleTrend, hitRate };
}

// ── Autonomous Branch Listing ─────────────────────────────────────────────

export interface AutonomousBranch {
  name: string;
  cycle: string;
  /** ISO timestamp of the most recent commit on this branch */
  lastCommitAt: string;
  /** Age of the last commit in milliseconds */
  ageMs: number;
  /**
   * Derived status:
   * - open-pr   → branch has an open PR on GitHub
   * - merged    → branch PR was merged
   * - active    → branch is fresh (< STALE_DAYS old) but no PR yet
   * - stale     → branch has no PR and is older than STALE_DAYS days
   */
  status: 'open-pr' | 'merged' | 'active' | 'stale';
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
      // No open or merged PR found — classify by age.
      // 'active' = fresh branch, PR likely being created soon.
      // 'stale'  = old branch, no PR, should be cleaned up.
      status = ageMs > STALE_MS ? 'stale' : 'active';
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
