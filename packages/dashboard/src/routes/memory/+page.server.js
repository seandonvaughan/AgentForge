import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// ── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Walk up from CWD until we find a directory that contains a recognised
 * .agentforge sub-path.  Checks both `memory/` (JSONL pipeline) and
 * `data/memories.json` (legacy curated store) so the root is found even
 * when only the legacy file exists.
 */
function findProjectRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, '.agentforge', 'memory')) ||
            existsSync(join(dir, '.agentforge', 'data', 'memories.json')))
            return dir;
        const parent = join(dir, '..');
        if (parent === dir)
            break;
        dir = parent;
    }
    return process.cwd();
}
/**
 * Derive a human-readable summary and display category from an entry's type
 * and raw value string.  Mirrors _deriveJsonlMeta in memory.ts.
 */
function deriveJsonlMeta(type, rawValue) {
    const categoryMap = {
        'cycle-outcome': 'project',
        'gate-verdict': 'feedback',
        'review-finding': 'feedback',
        'failure-pattern': 'lesson',
        'learned-fact': 'lesson',
    };
    const category = categoryMap[type] ?? 'project';
    try {
        const parsed = JSON.parse(rawValue);
        if (type === 'cycle-outcome') {
            const sprint = parsed.sprintVersion ?? '?';
            const stage = parsed.stage ?? '?';
            const cost = typeof parsed.costUsd === 'number'
                ? `$${parsed.costUsd.toFixed(2)}` : '';
            const tests = typeof parsed.testsPassed === 'number'
                ? `${parsed.testsPassed} tests` : '';
            const pr = parsed.prUrl ? ' · PR opened' : '';
            return { summary: [sprint, stage, cost, tests].filter(Boolean).join(' · ') + pr, category };
        }
        if (type === 'gate-verdict') {
            const verdict = parsed.verdict ?? '?';
            const sprint = parsed.sprintVersion ?? '';
            const rationale = typeof parsed.rationale === 'string'
                ? parsed.rationale.slice(0, 160) : '';
            const prefix = [sprint, verdict].filter(Boolean).join(' · ');
            return { summary: rationale ? `${prefix} — ${rationale}` : prefix, category };
        }
        if (type === 'review-finding') {
            const msg = (parsed.message ?? parsed.text ?? parsed.description);
            if (msg)
                return { summary: String(msg).slice(0, 200), category };
        }
        const compact = JSON.stringify(parsed);
        return { summary: compact.slice(0, 200), category };
    }
    catch {
        return { summary: rawValue.slice(0, 200), category };
    }
}
/** Maximum entries returned by SSR (matches V5_MEMORY_LIMIT in memory.ts). */
const SSR_LIMIT = 200;
/**
 * Read the operator-curated .agentforge/data/memories.json and return its
 * entries mapped to MemoryEntrySSR.  Returns an empty array on any error.
 *
 * This is the "basic fallback" wiring described in the sprint item — it
 * ensures the /memory dashboard page shows real content even before the
 * full JSONL pipeline writes its first entry, and keeps curated knowledge
 * visible alongside live cycle data once JSONL entries do exist.
 */
function readMemoriesJson(root) {
    const jsonPath = join(root, '.agentforge', 'data', 'memories.json');
    if (!existsSync(jsonPath))
        return [];
    try {
        const raw = readFileSync(jsonPath, 'utf-8');
        const parsed = JSON.parse(raw);
        const curatedEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
        return curatedEntries.map((e, idx) => {
            const id = e.id ?? `curated-${idx}`;
            // Strip file extensions for a clean display key
            const key = (e.filename ?? id).replace(/\.(md|json)$/i, '');
            const type = e.category ?? 'memory';
            return {
                id,
                key,
                // Use summary as the preview value — most human-readable field
                value: e.summary ?? '',
                summary: e.summary,
                category: type,
                type,
                agentId: e.agentId,
                source: e.agentId,
                tags: e.tags ?? [],
                createdAt: e.createdAt,
                updatedAt: e.updatedAt ?? e.createdAt,
            };
        });
    }
    catch {
        // Skip malformed / unreadable memories.json
        return [];
    }
}
// ── Primary JSONL reader ──────────────────────────────────────────────────────
/**
 * Read all JSONL memory files and return entries sorted newest-first.
 * Merges in the operator-curated memories.json (deduplicated by id so JSONL
 * always wins when the same id appears in both sources).
 * Applies optional filters so the server returns the right initial page.
 *
 * Exported as `_readMemoryEntries` for unit testing (follows the `_helper`
 * convention used by agents and flywheel page servers).
 */
export function _readMemoryEntries(root, opts) {
    return readMemoryEntries(root, opts);
}
/** Exported for unit tests — reads the curated memories.json file. */
export function _readMemoriesJson(root) {
    return readMemoriesJson(root);
}
function readMemoryEntries(root, opts) {
    const memDir = join(root, '.agentforge', 'memory');
    const allEntries = [];
    const seenIds = new Set();
    const agentSet = new Set();
    const typeSet = new Set();
    // ── JSONL files (primary path) ──────────────────────────────────────────
    if (existsSync(memDir)) {
        let files = [];
        try {
            files = readdirSync(memDir).filter(f => f.endsWith('.jsonl'));
        }
        catch {
            // memDir unreadable — continue to curated fallback below
        }
        for (const filename of files) {
            try {
                const raw = readFileSync(join(memDir, filename), 'utf-8');
                const lines = raw.split('\n').filter(l => l.trim().length > 0);
                for (const line of lines) {
                    try {
                        const e = JSON.parse(line);
                        if (!e.id || !e.type)
                            continue;
                        const rawValue = e.value ?? '';
                        const { summary, category } = deriveJsonlMeta(e.type, rawValue);
                        const entry = {
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
                        if (e.source)
                            agentSet.add(e.source);
                        if (e.type)
                            typeSet.add(e.type);
                        seenIds.add(e.id);
                        allEntries.push(entry);
                    }
                    catch {
                        // skip malformed JSONL lines
                    }
                }
            }
            catch {
                // skip unreadable files
            }
        }
    }
    // ── Curated memories.json (merged alongside JSONL, always) ───────────────
    //
    // Operator-curated entries are merged into every response — not just when
    // JSONL is empty.  Deduplication by `id` ensures that a curated entry that
    // was later promoted into a JSONL file doesn't appear twice.
    const curated = readMemoriesJson(root);
    for (const e of curated) {
        if (seenIds.has(e.id))
            continue; // JSONL entry wins
        seenIds.add(e.id);
        if (e.agentId)
            agentSet.add(e.agentId);
        if (e.type)
            typeSet.add(e.type);
        allEntries.push(e);
    }
    // Sort newest-first before filtering so slicing picks the freshest entries
    allEntries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    // Apply filters
    const { searchTerm, agentFilter, typeFilter } = opts;
    const filtered = allEntries.filter(e => {
        if (typeFilter && e.type !== typeFilter)
            return false;
        if (agentFilter && agentFilter !== 'all' && e.agentId !== agentFilter)
            return false;
        if (searchTerm) {
            const haystack = [e.key, e.value, e.summary ?? '', (e.tags ?? []).join(' ')]
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(searchTerm))
                return false;
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
export const load = ({ url }) => {
    const searchTerm = (url.searchParams.get('search') ?? '').toLowerCase().trim() || undefined;
    const agentFilter = url.searchParams.get('agent') ?? undefined;
    const typeFilter = url.searchParams.get('type') ?? undefined;
    const root = findProjectRoot();
    return readMemoryEntries(root, { searchTerm, agentFilter, typeFilter });
};
