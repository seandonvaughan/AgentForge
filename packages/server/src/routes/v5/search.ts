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

              // Extract description, handling YAML block scalars (> and |).
              // When the description value is a bare > or |, read the indented
              // lines that follow and collapse them into a single-line summary.
              let description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
              if (description === '>' || description === '|') {
                const blockMatch = /^description:\s*[>|][^\n]*\n((?:[ \t]+[^\n]*(?:\n|$))+)/m.exec(content);
                if (blockMatch?.[1]) {
                  description = blockMatch[1]
                    .split('\n')
                    .map(l => l.trim())
                    .filter(Boolean)
                    .join(' ')
                    .slice(0, 200);
                }
              }

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
              items?: Array<{ id?: string; title?: string; description?: string; status?: string; tags?: string[]; assignee?: string }>;
            };
            // Sprint files may contain either { sprints: [...] } or a single sprint object.
            const sprintList = Array.isArray(raw.sprints) ? raw.sprints : [raw];
            for (const sprint of sprintList) {
              const version = sprint.version ?? file.replace('.json', '');
              const items = (sprint.items ?? []) as Array<{
                id?: string; title?: string; description?: string; status?: string; tags?: string[]; assignee?: string;
              }>;
              for (const item of items) {
                // Include title + assignee so operators can find items by those fields too.
                const searchText = [
                  item.title ?? '',
                  item.description ?? '',
                  ...(item.tags ?? []),
                  item.status ?? '',
                  item.assignee ?? '',
                  version,
                ].join(' ');
                const score = scoreText(q, searchText);
                if (score > 0) {
                  const displayContent = [item.title, item.description].filter(Boolean).join('\n') || searchText;
                  results.push({
                    id: `sprint:${version}:${item.id ?? item.description?.slice(0, 20) ?? '?'}`,
                    content: displayContent,
                    score,
                    type: 'sprint',
                    source: `Sprint ${version}`,
                    metadata: { version, status: item.status, tags: item.tags, assignee: item.assignee },
                  });
                }
              }
            }
          } catch { /* skip malformed files */ }
        }
      }
    }

    // ── Cycles (from .agentforge/cycles/*/cycle.json or sprint-link.json) ───────
    // Completed cycles have a cycle.json with full metadata. In-progress cycles
    // only have sprint-link.json + events.jsonl — we fall back to those so that
    // active cycles are also discoverable via search.
    if (includeAll || types.includes('cycle')) {
      const cyclesDir = join(projectRoot, '.agentforge/cycles');
      if (existsSync(cyclesDir)) {
        for (const entry of readdirSync(cyclesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const cycleDir = join(cyclesDir, entry.name);
          const cycleFile = join(cycleDir, 'cycle.json');

          type CycleMeta = {
            cycleId?: string;
            stage?: string;
            sprintVersion?: string;
            startedAt?: string;
            pr?: { url?: string | null; number?: number | null };
          };

          let meta: CycleMeta | null = null;
          let searchText = '';

          if (existsSync(cycleFile)) {
            try {
              searchText = readFileSync(cycleFile, 'utf-8');
              meta = JSON.parse(searchText) as CycleMeta;
            } catch { continue; }
          } else {
            // Fallback: in-progress cycle — read sprint-link.json + events.jsonl
            const sprintLinkFile = join(cycleDir, 'sprint-link.json');
            if (!existsSync(sprintLinkFile)) continue;
            try {
              const sprintLink = JSON.parse(readFileSync(sprintLinkFile, 'utf-8')) as {
                sprintVersion?: string;
                assignedAt?: string;
              };
              // Spread conditionally to avoid assigning `undefined` to optional
              // properties, which is disallowed by exactOptionalPropertyTypes.
              meta = {
                cycleId: entry.name,
                stage: 'in-progress',
                ...(sprintLink.sprintVersion !== undefined ? { sprintVersion: sprintLink.sprintVersion } : {}),
                ...(sprintLink.assignedAt !== undefined ? { startedAt: sprintLink.assignedAt } : {}),
              };
              const eventsFile = join(cycleDir, 'events.jsonl');
              const eventsText = existsSync(eventsFile)
                ? readFileSync(eventsFile, 'utf-8')
                : '';
              searchText = JSON.stringify(meta) + '\n' + eventsText;
            } catch { continue; }
          }

          if (!meta) continue;
          // Search the full serialised text so branch names, PR titles, sprint
          // versions, and event types are all findable.
          const score = scoreText(q, searchText);
          if (score > 0) {
            const cycleId = meta.cycleId ?? entry.name;
            results.push({
              id: `cycle:${cycleId}`,
              content: [
                `Cycle: ${cycleId}`,
                `Stage: ${meta.stage ?? 'unknown'}`,
                meta.sprintVersion ? `Sprint: ${meta.sprintVersion}` : '',
              ].filter(Boolean).join('\n'),
              score,
              type: 'cycle',
              source: meta.sprintVersion ?? entry.name,
              metadata: {
                stage: meta.stage,
                sprintVersion: meta.sprintVersion,
                startedAt: meta.startedAt,
                prUrl: meta.pr?.url ?? null,
                prNumber: meta.pr?.number ?? null,
              },
            });
          }
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
