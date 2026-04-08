import type { FastifyInstance } from 'fastify';
import type { WorkspaceAdapter } from '@agentforge/db';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface SearchResult {
  id: string;
  content: string;
  score: number;
  type: string;
  source: string;
  metadata?: Record<string, unknown>;
}

/** Tokenise text into lowercase words ≥2 chars. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(t => t.length >= 2);
}

/**
 * Score how well `text` matches `query`.
 *
 * Returns 0 if no terms match, otherwise a value in (0, 1] combining:
 *   - hitRatio   — fraction of unique query terms found (0–1)
 *   - occurrence — average per-term occurrence depth, capped at 3 hits (0–1)
 *
 * The weighting (70 / 30) means a document that contains all query terms
 * but only once scores ~0.80 (yellow), while repeated occurrences push
 * it to 0.90+ (green). Partial matches stay below 0.65.
 */
function scoreText(query: string, text: string): number {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return 0;

  const lowerText = text.toLowerCase();
  let hitCount = 0;
  let occurrenceScore = 0;

  for (const term of queryTerms) {
    if (!lowerText.includes(term)) continue;
    hitCount++;
    let count = 0;
    let idx = 0;
    while ((idx = lowerText.indexOf(term, idx)) !== -1) {
      count++;
      idx += term.length;
    }
    occurrenceScore += Math.min(1, count / 3); // 3+ occurrences = full per-term bonus
  }

  if (hitCount === 0) return 0;

  const hitRatio = hitCount / queryTerms.length;
  const avgOccurrence = occurrenceScore / queryTerms.length;

  return Math.min(1.0, hitRatio * 0.7 + avgOccurrence * 0.3);
}

/**
 * Register the unified keyword search endpoint.
 *
 * POST /api/v5/search
 * Body: { query: string, limit?: number, types?: string[] }
 *
 * Searches across: sessions, agents, sprints, cycles, and memory files.
 * Results are scored by term frequency, sorted descending, and capped at limit.
 */
export async function searchRoutes(
  app: FastifyInstance,
  opts: { projectRoot: string; adapter?: WorkspaceAdapter },
): Promise<void> {
  const { projectRoot, adapter } = opts;

  app.post('/api/v5/search', async (req, reply) => {
    const { query, limit = 20, types } = req.body as {
      query: string;
      limit?: number;
      types?: string[];
    };

    if (!query?.trim()) {
      return reply.status(400).send({ error: 'query is required' });
    }

    const q = query.trim();
    const results: SearchResult[] = [];
    const includeAll = !types || types.length === 0;

    // ── Sessions (live data via adapter) ─────────────────────────────────────
    if (adapter && (includeAll || types.includes('session'))) {
      const sessions = adapter.listSessions({ limit: 500 });
      for (const s of sessions) {
        const searchText = `${s.agent_id} ${s.task} ${s.status} ${s.model ?? ''}`;
        const score = scoreText(q, searchText);
        if (score > 0) {
          results.push({
            id: `session:${s.id}`,
            content: `Agent: ${s.agent_id}\nTask: ${s.task}`,
            score,
            type: 'session',
            source: s.agent_id,
            metadata: {
              status: s.status,
              model: s.model,
              costUsd: s.cost_usd,
              startedAt: s.started_at,
            },
          });
        }
      }
    }

    // ── Agents (from .agentforge/agents/*.yaml) ───────────────────────────────
    if (includeAll || types.includes('agent')) {
      const agentsDir = join(projectRoot, '.agentforge/agents');
      if (existsSync(agentsDir)) {
        for (const file of readdirSync(agentsDir).filter(f => f.endsWith('.yaml'))) {
          try {
            const content = readFileSync(join(agentsDir, file), 'utf-8');
            const score = scoreText(q, content);
            if (score > 0) {
              const agentId = file.replace('.yaml', '');
              // Extract key fields via regex — avoids adding a YAML parser dep.
              const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? agentId;
              const role = /^role:\s*(.+)$/m.exec(content)?.[1]?.trim();
              const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
              const preview = [
                `Agent: ${name}`,
                role ? `Role: ${role}` : '',
                description ? `Description: ${description}` : '',
              ].filter(Boolean).join('\n');
              results.push({
                id: `agent:${agentId}`,
                content: preview,
                score,
                type: 'agent',
                source: agentId,
                metadata: { file, role, description },
              });
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }

    // ── Sprint items (from .agentforge/sprints/*.json) ────────────────────────
    if (includeAll || types.includes('sprint')) {
      const sprintsDir = join(projectRoot, '.agentforge/sprints');
      if (existsSync(sprintsDir)) {
        for (const file of readdirSync(sprintsDir).filter(f => f.endsWith('.json'))) {
          try {
            const raw = JSON.parse(readFileSync(join(sprintsDir, file), 'utf-8')) as {
              version?: string;
              sprints?: Array<{ version?: string; items?: unknown[] }>;
              items?: Array<{ id?: string; description?: string; status?: string; tags?: string[] }>;
            };
            // Sprint files may contain either { sprints: [...] } or a single sprint object.
            const sprintList = Array.isArray(raw.sprints) ? raw.sprints : [raw];
            for (const sprint of sprintList) {
              const version = sprint.version ?? file.replace('.json', '');
              const items = (sprint.items ?? []) as Array<{
                id?: string; description?: string; status?: string; tags?: string[];
              }>;
              for (const item of items) {
                const searchText = [
                  item.description ?? '',
                  ...(item.tags ?? []),
                  item.status ?? '',
                  version,
                ].join(' ');
                const score = scoreText(q, searchText);
                if (score > 0) {
                  results.push({
                    id: `sprint:${version}:${item.id ?? item.description?.slice(0, 20) ?? '?'}`,
                    content: item.description ?? searchText,
                    score,
                    type: 'sprint',
                    source: `Sprint ${version}`,
                    metadata: { version, status: item.status, tags: item.tags },
                  });
                }
              }
            }
          } catch { /* skip malformed files */ }
        }
      }
    }

    // ── Cycles (from .agentforge/cycles/*/cycle.json) ─────────────────────────
    if (includeAll || types.includes('cycle')) {
      const cyclesDir = join(projectRoot, '.agentforge/cycles');
      if (existsSync(cyclesDir)) {
        for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cycleFile = join(cyclesDir, entry.name, 'cycle.json');
          if (!existsSync(cycleFile)) continue;
          try {
            const raw = JSON.parse(readFileSync(cycleFile, 'utf-8')) as {
              cycleId?: string;
              stage?: string;
              sprintVersion?: string;
              startedAt?: string;
              pr?: { url?: string | null; number?: number | null };
            };
            // Search the full serialised JSON so branch names, PR titles, and
            // item descriptions are all findable by query.
            const searchText = readFileSync(cycleFile, 'utf-8');
            const score = scoreText(q, searchText);
            if (score > 0) {
              const cycleId = raw.cycleId ?? entry.name;
              results.push({
                id: `cycle:${cycleId}`,
                content: [
                  `Cycle: ${cycleId}`,
                  `Stage: ${raw.stage ?? 'unknown'}`,
                  raw.sprintVersion ? `Sprint: ${raw.sprintVersion}` : '',
                ].filter(Boolean).join('\n'),
                score,
                type: 'cycle',
                source: raw.sprintVersion ?? entry.name,
                metadata: {
                  stage: raw.stage,
                  sprintVersion: raw.sprintVersion,
                  startedAt: raw.startedAt,
                  prUrl: raw.pr?.url ?? null,
                  prNumber: raw.pr?.number ?? null,
                },
              });
            }
          } catch { /* skip malformed files */ }
        }
      }
    }

    // ── Memory files (from .agentforge/memory/*.{json,md,jsonl}) ─────────────
    // v6.7.4 fix: include .jsonl, which is the primary format the v6.7.x
    // memory wiring writes (writeMemoryEntry appends one entry per line).
    // The previous .json|.md filter silently dropped every gate-verdict and
    // cycle-outcome entry, making the headline memory feature unsearchable.
    if (includeAll || types.includes('memory')) {
      const memoryDir = join(projectRoot, '.agentforge/memory');
      if (existsSync(memoryDir)) {
        for (const file of readdirSync(memoryDir).filter(
          f => f.endsWith('.json') || f.endsWith('.md') || f.endsWith('.jsonl'),
        )) {
          try {
            const content = readFileSync(join(memoryDir, file), 'utf-8');
            // For .jsonl, score each line separately so a single matching
            // entry surfaces independently from its neighbors. For .json/
            // .md treat the file as one document.
            if (file.endsWith('.jsonl')) {
              const lines = content.split('\n').filter(l => l.trim().length > 0);
              for (const line of lines) {
                const score = scoreText(q, line);
                if (score > 0) {
                  let entryId = file.replace(/\.jsonl$/, '');
                  let snippet = line;
                  try {
                    const parsed = JSON.parse(line);
                    if (parsed?.id) entryId = String(parsed.id);
                    if (typeof parsed?.value === 'string') snippet = parsed.value;
                  } catch { /* line not parseable as JSON, use raw */ }
                  results.push({
                    id: `memory:${entryId}`,
                    content: snippet.slice(0, 500),
                    score,
                    type: 'memory',
                    source: file,
                    metadata: { file },
                  });
                }
              }
            } else {
              const score = scoreText(q, content);
              if (score > 0) {
                const id = file.replace(/\.[^.]+$/, '');
                results.push({
                  id: `memory:${id}`,
                  content: content.slice(0, 500),
                  score,
                  type: 'memory',
                  source: file,
                  metadata: { file },
                });
              }
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }

    // Sort by score descending, cap at limit.
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);

    return reply.send({ data: top, meta: { total: top.length, query } });
  });
}
