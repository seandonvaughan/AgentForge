/**
 * Server-side load for /memory.
 *
 * Reads .agentforge/memory/*.jsonl files directly from the filesystem so the
 * page renders with real memory entries on the first request — no dependency
 * on the Fastify backend at port 4750.
 *
 * Mirrors the logic in src/server/routes/memory.ts (_deriveJsonlMeta,
 * readJsonlMemories) but runs inside SvelteKit's SSR layer.  After hydration,
 * the client-side load() in +page.svelte refreshes via the API and takes over.
 *
 * Accepts optional URL search params:
 *   ?search=<term>   — substring filter applied server-side
 *   ?agent=<id>      — exact match on source/agentId
 *   ?type=<type>     — exact match on entry type
 */
import type { PageServerLoad } from './$types';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryEntrySSR {
  id: string;
  key: string;
  value: string;
  type?: string;
  category?: string;
  agentId?: string;
  source?: string;
  summary?: string;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Walk up from CWD until we find a directory that contains .agentforge/memory. */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.agentforge', 'memory'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Derive a human-readable summary and display category from an entry's type
 * and raw value string.  Mirrors _deriveJsonlMeta in memory.ts.
 */
function deriveJsonlMeta(
  type: string,
  rawValue: string,
): { summary: string; category: string } {
  const categoryMap: Record<string, string> = {
    'cycle-outcome':   'project',
    'gate-verdict':    'feedback',
    'review-finding':  'feedback',
    'failure-pattern': 'lesson',
    'learned-fact':    'lesson',
  };
  const category = categoryMap[type] ?? 'project';

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;

    if (type === 'cycle-outcome') {
      const sprint = parsed.sprintVersion ?? '?';
      const stage  = parsed.stage ?? '?';
      const cost   = typeof parsed.costUsd === 'number'
        ? `$${(parsed.costUsd as number).toFixed(2)}` : '';
      const tests  = typeof parsed.testsPassed === 'number'
        ? `${parsed.testsPassed} tests` : '';
      const pr     = parsed.prUrl ? ' · PR opened' : '';
      return { summary: [sprint, stage, cost, tests].filter(Boolean).join(' · ') + pr, category };
    }

    if (type === 'gate-verdict') {
      const verdict  = parsed.verdict ?? '?';
      const sprint   = parsed.sprintVersion ?? '';
      const rationale = typeof parsed.rationale === 'string'
        ? (parsed.rationale as string).slice(0, 160) : '';
      const prefix = [sprint, verdict].filter(Boolean).join(' · ');
      return { summary: rationale ? `${prefix} — ${rationale}` : prefix, category };
    }

    if (type === 'review-finding') {
      const msg = (parsed.message ?? parsed.text ?? parsed.description) as string | undefined;
      if (msg) return { summary: String(msg).slice(0, 200), category };
    }

    const compact = JSON.stringify(parsed);
    return { summary: compact.slice(0, 200), category };
  } catch {
    return { summary: rawValue.slice(0, 200), category };
  }
}

/** Maximum entries returned by SSR (matches V5_MEMORY_LIMIT in memory.ts). */
const SSR_LIMIT = 200;

/**
 * Read all JSONL memory files and return entries sorted newest-first.
 * Applies optional filters so the server returns the right initial page.
 */
function readMemoryEntries(opts: {
  searchTerm?: string;
  agentFilter?: string;
  typeFilter?: string;
}): { entries: MemoryEntrySSR[]; agents: string[]; types: string[] } {
  const root = findProjectRoot();
  const memDir = join(root, '.agentforge', 'memory');

  if (!existsSync(memDir)) {
    return { entries: [], agents: [], types: [] };
  }

  const allEntries: MemoryEntrySSR[] = [];
  const agentSet = new Set<string>();
  const typeSet = new Set<string>();

  let files: string[] = [];
  try {
    files = readdirSync(memDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return { entries: [], agents: [], types: [] };
  }

  for (const filename of files) {
    try {
      const raw = readFileSync(join(memDir, filename), 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const e = JSON.parse(line) as {
            id?: string;
            type?: string;
            value?: string;
            createdAt?: string;
            source?: string;
            tags?: string[];
            metadata?: Record<string, unknown>;
          };
          if (!e.id || !e.type) continue;

          const rawValue = e.value ?? '';
          const { summary, category } = deriveJsonlMeta(e.type, rawValue);

          const entry: MemoryEntrySSR = {
            id: e.id,
            key: e.source ? `${e.type}/${e.source}` : e.type,
            value: rawValue.slice(0, 500),
            summary,
            category,
            type: e.type,
            agentId: e.source,
            source: e.source,
            tags: e.tags ?? [],
            createdAt: e.createdAt,
            updatedAt: e.createdAt,
            ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
          };

          // Track unique agents and types (from full corpus, before filtering)
          if (e.source) agentSet.add(e.source);
          if (e.type) typeSet.add(e.type);

          allEntries.push(entry);
        } catch {
          // skip malformed JSONL lines
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  // Sort newest-first before filtering so slicing picks the freshest entries
  allEntries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  // Apply filters
  const { searchTerm, agentFilter, typeFilter } = opts;
  const filtered = allEntries.filter(e => {
    if (typeFilter && e.type !== typeFilter) return false;
    if (agentFilter && agentFilter !== 'all' && e.agentId !== agentFilter) return false;
    if (searchTerm) {
      const haystack = [e.key, e.value, e.summary ?? '', (e.tags ?? []).join(' ')]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }
    return true;
  });

  return {
    entries: filtered.slice(0, SSR_LIMIT),
    agents: [...agentSet].sort(),
    types: [...typeSet].sort(),
  };
}

// ── SvelteKit load ───────────────────────────────────────────────────────────

export const load: PageServerLoad = ({ url }) => {
  const searchTerm  = (url.searchParams.get('search') ?? '').toLowerCase().trim() || undefined;
  const agentFilter = url.searchParams.get('agent') ?? undefined;
  const typeFilter  = url.searchParams.get('type') ?? undefined;

  return readMemoryEntries({ searchTerm, agentFilter, typeFilter });
};
