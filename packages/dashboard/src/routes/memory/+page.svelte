<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { PageData } from './$types';

  // SSR-loaded initial data from +page.server.ts.
  // Initializes the view immediately on first paint — no loading skeleton needed
  // until the client-side refresh runs and replaces the data with the API result.
  export let data: PageData;

  interface MemoryEntry {
    id: string;
    key: string;
    value: unknown;
    type?: string;
    category?: string;
    createdAt?: string;
    updatedAt?: string;
    agentId?: string;
    /** Original cycleId or agentId from the JSONL source field. */
    source?: string;
    summary?: string;
    tags?: string[];
    /**
     * Structured metadata from the canonical CycleMemoryEntry schema (v10.2+).
     * For gate-verdict entries this replaces the JSON-encoded `value` string
     * and carries typed fields: verdict, sprintVersion, rationale, findings, etc.
     */
    metadata?: Record<string, unknown>;
  }

  // Initialise from SSR data so entries are visible immediately on first paint.
  // The client-side load() in onMount will refresh from the API and replace these.
  let entries: MemoryEntry[] = (data.entries ?? []) as MemoryEntry[];
  let agents: string[] = data.agents ?? [];
  let types: string[] = data.types ?? [];
  // If SSR returned real entries, skip the loading skeleton on first paint.
  let loading = entries.length === 0;
  let error: string | null = null;
  let deleting: Set<string> = new Set();
  let deleteError: string | null = null;
  /** IDs of rows currently expanded to show full JSON value. */
  let expanded: Set<string> = new Set();
  /** IDs of entries that arrived in the most-recent load (highlighted briefly). */
  let newIds: Set<string> = new Set();
  let newCount = 0; // count of new entries from last SSE-triggered refresh
  /** ID of the entry whose JSON was most recently copied to clipboard (cleared after 2s). */
  let copiedId: string | null = null;

  // Live feed state — tracks recent SSE events for the bottom feed panel
  interface LiveEvent {
    type: string;
    category?: string;
    message?: string;
    data?: Record<string, unknown>;
    ts: string;
  }
  let liveEvents: LiveEvent[] = [];
  let feedOpen = false; // live feed panel collapsed by default
  /** Count of new events that arrived while the feed panel was closed. */
  let newFeedCount = 0;
  const MAX_FEED_EVENTS = 30;

  // SSE reconnect backoff constants
  const SSE_BASE_BACKOFF_MS = 2_000;
  const SSE_MAX_BACKOFF_MS  = 60_000;
  let sseBackoffMs = SSE_BASE_BACKOFF_MS;

  // Search and filter state
  let searchQuery = '';
  let agentFilter = 'all';
  let typeFilter = 'all';

  // SSE live-update state
  let eventSource: EventSource | null = null;
  let sseConnected = false;
  let sseReconnecting = false;
  let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRefreshedAt: Date | null = null;

  // Derived: entries after client-side search + agent + type filter
  $: filteredEntries = entries.filter(e => {
    const matchesSearch = searchQuery.trim() === '' || [
      e.key,
      typeof e.value === 'string' ? e.value : JSON.stringify(e.value),
      e.summary ?? '',
      (e.tags ?? []).join(' '),
      // Also search resolved sprint version so operators can type "v9.0.1"
      resolveSprintVersion(e) ?? '',
      // Search inside promoted metadata fields (rationale, verdict, etc.)
      e.metadata ? JSON.stringify(e.metadata) : '',
    ].join(' ').toLowerCase().includes(searchQuery.trim().toLowerCase());

    const matchesAgent = agentFilter === 'all' || e.agentId === agentFilter;
    const matchesType  = typeFilter  === 'all' || e.type === typeFilter;

    return matchesSearch && matchesAgent && matchesType;
  });

  // Derived: per-type entry counts for the stats bar
  $: typeCounts = entries.reduce<Record<string, number>>((acc, e) => {
    const t = e.type ?? 'unknown';
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

  /** True while the NDJSON stream is still being read from the server. */
  let streaming = false;

  /**
   * Load memory entries by consuming the NDJSON streaming endpoint
   * (/api/v5/memory/stream).  Entries are appended to the reactive list as
   * each line arrives, giving a "live feed" feel without waiting for the full
   * corpus to buffer.
   *
   * Falls back to the batch JSON endpoint on any stream error so the page
   * never shows an empty state due to a streaming issue.
   */
  async function load(silent = false) {
    if (!silent) loading = true;
    streaming = false;
    error = null;

    // Snapshot existing IDs so we can detect genuinely new arrivals after refresh
    const prevIds = new Set(entries.map(e => e.id));

    try {
      const res = await fetch('/api/v5/memory/stream');
      if (!res.ok || !res.body) {
        // Stream unavailable — fall back to batch endpoint
        return loadBatch(silent, prevIds);
      }

      // Progressive NDJSON parse: accumulate raw chunks, split on newlines,
      // parse each complete line as a MemoryEntry, and carry incomplete
      // trailing fragments to the next chunk.
      const reader  = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let   buffer  = '';
      const fresh: MemoryEntry[] = [];

      streaming = true;
      loading   = false;  // hide skeleton as soon as first byte arrives

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on newlines: all but the last segment are complete JSON lines.
        const lines = buffer.split('\n');
        // Keep the trailing incomplete fragment for the next chunk.
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as MemoryEntry;
            fresh.push(entry);
            // Append incrementally so the table updates as each batch arrives
            entries = [...fresh];
          } catch { /* skip malformed NDJSON lines */ }
        }
      }

      // Flush any remaining buffer content (last line with no trailing newline)
      if (buffer.trim()) {
        try {
          const entry = JSON.parse(buffer) as MemoryEntry;
          fresh.push(entry);
        } catch { /* ignore */ }
      }

      entries = fresh;
      // Re-derive agent and type lists from the streamed entries
      agents = [...new Set(fresh.map(e => e.agentId).filter((a): a is string => Boolean(a)))];
      types  = [...new Set(fresh.map(e => e.type).filter((t): t is string => Boolean(t)))].sort();
      lastRefreshedAt = new Date();

      // Highlight entries that are genuinely new since the previous load
      const arrivals = fresh.filter(e => !prevIds.has(e.id));
      if (arrivals.length > 0 && prevIds.size > 0) {
        newCount = arrivals.length;
        newIds   = new Set(arrivals.map(e => e.id));
        setTimeout(() => { newIds = new Set(); newCount = 0; }, 3500);
      }
    } catch (e) {
      // Stream failed mid-flight — fall back to batch
      try {
        await loadBatch(true, prevIds);
      } catch {
        error = String(e);
      }
    } finally {
      streaming = false;
      loading   = false;
    }
  }

  /**
   * Batch fallback: fetch all entries from the paginated JSON endpoint and
   * replace the entry list atomically.  Used when the NDJSON stream is
   * unavailable (e.g., older server build) and for silent SSE-triggered
   * refreshes where progressive rendering would cause visible flicker.
   */
  async function loadBatch(silent = false, prevIds?: Set<string>) {
    if (!silent) loading = true;
    error = null;
    const snapshot = prevIds ?? new Set(entries.map(e => e.id));

    try {
      const res = await fetch('/api/v5/memory');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as {
        data?: MemoryEntry[];
        agents?: string[];
        types?: string[];
      };
      const fresh = json.data ?? [];
      entries = fresh;
      agents  = json.agents ?? [];
      types   = json.types ?? [];
      lastRefreshedAt = new Date();

      const arrivals = fresh.filter(e => !snapshot.has(e.id));
      if (arrivals.length > 0 && snapshot.size > 0) {
        newCount = arrivals.length;
        newIds   = new Set(arrivals.map(e => e.id));
        setTimeout(() => { newIds = new Set(); newCount = 0; }, 3500);
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  // ── SSE live-update connection ───────────────────────────────────────────
  function connectSSE() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    sseReconnecting = false;

    // NOTE: All server events are *named* SSE events (event: <type>\ndata: ...).
    // es.onmessage only fires for *unnamed* events — we must use addEventListener
    // per event type to actually receive them.
    const es = new EventSource('/api/v1/stream');
    eventSource = es;

    es.onopen = () => {
      sseConnected = true;
      sseReconnecting = false;
      sseBackoffMs = SSE_BASE_BACKOFF_MS; // reset on successful connect
    };

    /** Prepend an SSE event payload into the live feed array (capped). */
    function pushFeedEvent(rawData: string, overrideType?: string) {
      try {
        const parsed = JSON.parse(rawData) as Record<string, unknown>;
        liveEvents = [{
          type: overrideType ?? (typeof parsed.type === 'string' ? parsed.type : 'unknown'),
          category: typeof parsed.category === 'string' ? parsed.category : undefined,
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
          data: parsed,
          ts: new Date().toISOString(),
        }, ...liveEvents].slice(0, MAX_FEED_EVENTS);
        // Badge counter: increment when panel is collapsed so users see missed events
        if (!feedOpen) newFeedCount += 1;
      } catch { /* ignore malformed */ }
    }

    // cycle_event — emitted on cycle phase transitions and completions
    es.addEventListener('cycle_event', (e: MessageEvent) => {
      pushFeedEvent(e.data as string, 'cycle_event');
      try {
        const parsed = JSON.parse(e.data as string) as { category?: string };
        const cat = parsed.category ?? '';
        if (cat === 'cycle.complete' || cat === 'cycle.completed' || cat === 'cycle.failed') {
          // Use batch refresh for SSE-triggered reloads — avoids streaming flicker
          // when memory is written atomically at cycle completion.
          loadBatch(true);
        }
      } catch { /* ignore */ }
    });

    // session events — agent session lifecycle
    es.addEventListener('session.started',   (e: MessageEvent) => pushFeedEvent(e.data as string, 'session.started'));
    es.addEventListener('session.completed', (e: MessageEvent) => pushFeedEvent(e.data as string, 'session.completed'));
    es.addEventListener('session.failed',    (e: MessageEvent) => pushFeedEvent(e.data as string, 'session.failed'));

    // workflow_event — multi-agent workflow coordination
    es.addEventListener('workflow_event', (e: MessageEvent) => {
      pushFeedEvent(e.data as string, 'workflow_event');
      try {
        const parsed = JSON.parse(e.data as string) as { category?: string };
        if (parsed.category === 'workflow.complete') loadBatch(true);
      } catch { /* ignore */ }
    });

    // refresh_signal — explicit server-side push to reload
    es.addEventListener('refresh_signal', (e: MessageEvent) => {
      pushFeedEvent(e.data as string, 'refresh_signal');
      loadBatch(true);
    });

    // memory_written — emitted by the core when a new memory entry is persisted
    es.addEventListener('memory_written', (e: MessageEvent) => {
      pushFeedEvent(e.data as string, 'memory_written');
      // Batch refresh: the entry is fully written when this event fires,
      // so a streaming read would just re-read everything unnecessarily.
      loadBatch(true);
    });

    es.onerror = () => {
      sseConnected = false;
      sseReconnecting = true;
      es.close();
      eventSource = null;
      // Exponential backoff: double each attempt, cap at SSE_MAX_BACKOFF_MS
      sseReconnectTimer = setTimeout(() => {
        sseBackoffMs = Math.min(sseBackoffMs * 2, SSE_MAX_BACKOFF_MS);
        connectSSE();
      }, sseBackoffMs);
    };
  }

  async function deleteEntry(id: string) {
    deleting = new Set([...deleting, id]);
    deleteError = null;
    try {
      const res = await fetch(`/api/v5/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      entries = entries.filter(e => e.id !== id);
      expanded = new Set([...expanded].filter(x => x !== id));
    } catch (e) {
      deleteError = `Failed to delete: ${e}`;
    } finally {
      deleting = new Set([...deleting].filter(x => x !== id));
    }
  }

  function toggleExpand(id: string) {
    if (expanded.has(id)) {
      expanded = new Set([...expanded].filter(x => x !== id));
    } else {
      expanded = new Set([...expanded, id]);
    }
  }

  /** Copy the full formatted value to the clipboard and show brief feedback. */
  async function copyValue(entry: MemoryEntry, e: MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(formatValueFull(entry.value));
      copiedId = entry.id;
      setTimeout(() => { copiedId = null; }, 2000);
    } catch { /* clipboard API unavailable in this context */ }
  }

  function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v.length > 120 ? v.slice(0, 118) + '…' : v;
    return JSON.stringify(v).slice(0, 120);
  }

  function formatValueFull(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') {
      // Try to pretty-print compact JSON strings (common for JSONL entries)
      if (v.trim().startsWith('{') || v.trim().startsWith('[')) {
        try { return JSON.stringify(JSON.parse(v), null, 2); } catch { /* not JSON */ }
      }
      return v;
    }
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  /**
   * Returns an HTML string with JSON tokens wrapped in span elements for
   * syntax highlighting. No external dependencies — pure regex substitution.
   */
  function highlightJSON(v: unknown): string {
    const raw = formatValueFull(v);
    // Escape HTML entities first so we can safely inject spans
    const escaped = raw
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        if (/^"/.test(match)) {
          return `<span class="${/:$/.test(match) ? 'json-key' : 'json-string'}">${match}</span>`;
        }
        if (/^(true|false|null)$/.test(match)) return `<span class="json-keyword">${match}</span>`;
        return `<span class="json-number">${match}</span>`;
      }
    );
  }

  function formatDate(iso?: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function formatRelative(iso?: string): string {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return formatDate(iso);
  }

  /**
   * Resolve a human-readable sprint version for ANY entry type.
   * Strategy (first match wins):
   *   1. Tags array — looks for a "sprint:vX.Y.Z" tag (review-finding entries).
   *   2. JSON value — parses `value` and reads `sprintVersion` (gate-verdict,
   *      cycle-outcome, and any future type that embeds the field).
   *   3. Metadata object — reads `sprintVersion` from the promoted metadata map.
   * Returns null when no sprint version can be determined.
   */
  function resolveSprintVersion(entry: MemoryEntry): string | null {
    // 1. Tags (review-finding entries carry sprint:vX.Y.Z)
    const fromTag = sprintTagFromEntry(entry);
    if (fromTag) return fromTag;

    // 2. Promoted metadata object (rank-1 schema)
    if (entry.metadata && typeof entry.metadata.sprintVersion === 'string' && entry.metadata.sprintVersion) {
      return entry.metadata.sprintVersion;
    }

    // 3. Inline JSON value (gate-verdict, cycle-outcome)
    if (typeof entry.value === 'string' && entry.value.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(entry.value) as Record<string, unknown>;
        if (typeof parsed.sprintVersion === 'string' && parsed.sprintVersion) {
          return parsed.sprintVersion;
        }
      } catch { /* not JSON */ }
    } else if (entry.value && typeof entry.value === 'object') {
      const v = entry.value as Record<string, unknown>;
      if (typeof v.sprintVersion === 'string' && v.sprintVersion) return v.sprintVersion;
    }

    return null;
  }

  /** Determines whether a source string looks like a UUID cycle ID. */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function isCycleId(s?: string): boolean {
    return !!s && UUID_RE.test(s);
  }

  /** Short identifier for display (first 8 chars of a UUID, else full). */
  function shortSource(s?: string): string {
    if (!s) return '';
    return UUID_RE.test(s) ? s.slice(0, 8) : s;
  }

  /**
   * Extract a human-readable sprint version label from an entry's tags array.
   * Looks for a tag matching "sprint:vX.Y.Z" and returns the version string.
   */
  function sprintTagFromEntry(entry: MemoryEntry): string | null {
    const sprintTag = (entry.tags ?? []).find(t => t.startsWith('sprint:'));
    return sprintTag ? sprintTag.replace('sprint:', '') : null;
  }

  /**
   * Build a human-readable label for a source UUID by scanning the loaded
   * entries for a sprint version associated with the same source.
   * Uses resolveSprintVersion so it works for all entry types (not just
   * those that carry a "sprint:vX.Y.Z" tag).
   */
  function sourceLabel(sourceId: string): string {
    if (!UUID_RE.test(sourceId)) return sourceId;
    // Look up any entry sharing this source and resolve its sprint version.
    const match = entries.find(e => e.source === sourceId || e.agentId === sourceId);
    const version = match ? resolveSprintVersion(match) : null;
    return version ? `cycle · ${version}` : `cycle · ${sourceId.slice(0, 8)}`;
  }

  /**
   * Strip markdown bold/italic markers and backtick code spans from a string
   * so it can be rendered as plain text in a table cell preview.
   */
  function stripMarkdown(text: string): string {
    return text
      .replace(/\*\*\[([A-Z]+)\]\*\*/g, '[$1]')   // **[MAJOR]** → [MAJOR]
      .replace(/\*\*([^*]+)\*\*/g, '$1')            // **bold** → bold
      .replace(/`([^`]+)`/g, '$1')                   // `code` → code
      .replace(/\*([^*]+)\*/g, '$1');                // *italic* → italic
  }

  /**
   * For gate-verdict entries, extract the structured verdict information
   * so it can be rendered as a proper UI panel rather than raw JSON.
   */
  interface VerdictInfo {
    verdict: string;
    sprintVersion: string;
    rationale: string;
    criticalFindings: string[];
    majorFindings: string[];
    cycleId?: string;
  }

  /**
   * Parse a raw finding string, which may be:
   *  (a) A short finding title: "Custom YAML parsers drop dash-list arrays"
   *  (b) A full LLM response blob: '"response": "Now I have...\n**[CRITICAL] ...**\n..."'
   * For case (b), extract all heading titles matching the severity level.
   */
  function parseFindingString(raw: unknown, severity: 'CRITICAL' | 'MAJOR' | 'MINOR'): string[] {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);

    // Detect full LLM response blob — starts with an optional leading quote + "response":
    const isBlob = /^"?response"?\s*:/.test(s.trim());
    if (!isBlob) {
      const clean = s.replace(/^"/, '').replace(/"$/, '');
      return [clean.length > 240 ? clean.slice(0, 237) + '…' : clean];
    }

    // Unwrap the outer "response": "..." envelope — value may have escaped newlines
    const inner = s
      .replace(/^"?response"?\s*:\s*"/, '')
      .replace(/"\s*$/, '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"');

    // Pull **[SEVERITY] Title text** heading lines from the markdown.
    // Character class [^*\n] — allow backticks since finding titles can contain `code`.
    const severityPattern = severity === 'CRITICAL' ? 'CRITICAL' : severity === 'MAJOR' ? 'MAJOR' : 'MINOR';
    const headingRe = new RegExp(`\\*\\*\\[${severityPattern}\\]\\s*([^*\\n]+?)\\*\\*`, 'g');
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((m = headingRe.exec(inner)) !== null) {
      const title = m[1].trim();
      if (title) matches.push(title);
    }
    if (matches.length > 0) return matches;

    // Fallback: first 240 chars of inner content
    const preview = inner.replace(/^[^a-zA-Z]*/, '').trim();
    return [preview.length > 240 ? preview.slice(0, 237) + '…' : preview];
  }

  function extractVerdictInfo(entry: MemoryEntry): VerdictInfo | null {
    if (entry.type !== 'gate-verdict') return null;

    // Resolve the verdict payload: prefer typed metadata (v10.2+ schema promotion),
    // then try parsing value as JSON, then treat value as an object directly.
    let v: Record<string, unknown> | null = null;
    if (entry.metadata && typeof entry.metadata === 'object' && entry.metadata.verdict) {
      v = entry.metadata as Record<string, unknown>;
    } else if (typeof entry.value === 'string' && entry.value.trim().startsWith('{')) {
      try { v = JSON.parse(entry.value) as Record<string, unknown>; } catch { /* ignore */ }
    } else if (entry.value && typeof entry.value === 'object') {
      v = entry.value as Record<string, unknown>;
    }

    if (!v || !v.verdict) return null;
    return {
      verdict: String(v.verdict ?? ''),
      sprintVersion: String(v.sprintVersion ?? ''),
      rationale: String(v.rationale ?? ''),
      criticalFindings: Array.isArray(v.criticalFindings)
        ? (v.criticalFindings as unknown[]).flatMap(f => parseFindingString(f, 'CRITICAL'))
        : [],
      majorFindings: Array.isArray(v.majorFindings)
        ? (v.majorFindings as unknown[]).flatMap(f => parseFindingString(f, 'MAJOR'))
        : [],
      cycleId: typeof v.cycleId === 'string' ? v.cycleId : undefined,
    };
  }

  // ── Per-type structured info extractors ─────────────────────────────────

  interface CycleOutcomeInfo {
    cycleId?: string;
    sprintVersion: string;
    stage: string;
    costUsd?: number;
    testsPassed?: number;
    prUrl?: string;
  }

  /** Parse a cycle-outcome entry's JSON value into structured fields. */
  function extractCycleOutcomeInfo(entry: MemoryEntry): CycleOutcomeInfo | null {
    if (entry.type !== 'cycle-outcome') return null;
    let v: Record<string, unknown> | null = null;
    if (typeof entry.value === 'string' && entry.value.trim().startsWith('{')) {
      try { v = JSON.parse(entry.value) as Record<string, unknown>; } catch { return null; }
    } else if (entry.value && typeof entry.value === 'object') {
      v = entry.value as Record<string, unknown>;
    }
    if (!v) return null;
    return {
      cycleId:      typeof v.cycleId === 'string'       ? v.cycleId     : undefined,
      sprintVersion: String(v.sprintVersion ?? ''),
      stage:        String(v.stage ?? 'unknown'),
      costUsd:      typeof v.costUsd === 'number'       ? v.costUsd     : undefined,
      testsPassed:  typeof v.testsPassed === 'number'   ? v.testsPassed : undefined,
      prUrl:        typeof v.prUrl === 'string'         ? v.prUrl       : undefined,
    };
  }

  type FindingSeverity = 'critical' | 'major' | 'minor';
  interface ReviewFindingInfo {
    severity: FindingSeverity | null;
    text: string;
    sprintVersion: string | null;
    cycleId?: string;
  }

  /** Resolve severity from tags array or the raw value text. */
  function extractReviewFindingInfo(entry: MemoryEntry): ReviewFindingInfo | null {
    if (entry.type !== 'review-finding') return null;
    const raw = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
    const tags = entry.tags ?? [];
    let severity: FindingSeverity | null = null;
    if (tags.includes('critical') || /\[CRITICAL\]/i.test(raw)) severity = 'critical';
    else if (tags.includes('major') || /\[MAJOR\]/i.test(raw)) severity = 'major';
    else if (tags.includes('minor') || /\[MINOR\]/i.test(raw)) severity = 'minor';
    return {
      severity,
      text: raw,
      sprintVersion: sprintTagFromEntry(entry),
      cycleId: entry.source && isCycleId(entry.source) ? entry.source : undefined,
    };
  }

  /** Color class for gate verdict chips. */
  function verdictColorClass(verdict: string): string {
    const v = verdict.toUpperCase();
    if (v === 'PASS' || v === 'APPROVE') return 'verdict--pass';
    if (v === 'REJECT') return 'verdict--reject';
    return 'verdict--neutral';
  }

  /**
   * Badge class and left-border color for a memory entry type.
   * Maps the five canonical types to project colour variables.
   */
  const TYPE_CONFIG: Record<string, { badge: string; color: string; label: string }> = {
    'cycle-outcome':   { badge: 'sonnet',  color: 'var(--color-sonnet)',  label: 'Cycle Outcome'   },
    'gate-verdict':    { badge: 'warning', color: 'var(--color-warning)', label: 'Gate Verdict'    },
    'review-finding':  { badge: 'danger',  color: 'var(--color-danger)',  label: 'Review Finding'  },
    'failure-pattern': { badge: 'opus',    color: 'var(--color-opus)',    label: 'Failure Pattern' },
    'learned-fact':    { badge: 'haiku',   color: 'var(--color-haiku)',   label: 'Learned Fact'    },
    'json':            { badge: 'muted',   color: 'var(--color-text-faint)', label: 'JSON'         },
    'text':            { badge: 'muted',   color: 'var(--color-text-faint)', label: 'Text'         },
  };
  const FALLBACK_CONFIG = { badge: 'muted', color: 'var(--color-text-faint)', label: '' };

  function getTypeConfig(entry: MemoryEntry) {
    return TYPE_CONFIG[entry.type ?? ''] ?? FALLBACK_CONFIG;
  }

  onMount(() => {
    load();
    connectSSE();
  });

  onDestroy(() => {
    if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
    if (eventSource) { eventSource.close(); }
  });
</script>

<svelte:head><title>Memory — AgentForge</title></svelte:head>

<!-- ── Page header ─────────────────────────────────────────────────────── -->
<div class="page-header">
  <div>
    <h1 class="page-title">Memory</h1>
    <p class="page-subtitle">
      {filteredEntries.length}{filteredEntries.length !== entries.length ? ` of ${entries.length}` : ''} entr{filteredEntries.length === 1 ? 'y' : 'ies'}
      {#if streaming}
        <span class="streaming-indicator" aria-live="polite">· streaming…</span>
      {:else if lastRefreshedAt}
        · updated {formatRelative(lastRefreshedAt.toISOString())}
      {/if}
    </p>
  </div>
  <div class="header-actions">
    <!-- SSE connection indicator -->
    <span class="sse-indicator" title={sseConnected ? 'Live — refreshes on cycle completion' : sseReconnecting ? 'Reconnecting…' : 'Disconnected'}>
      <span class="sse-dot {sseConnected ? 'live' : sseReconnecting ? 'reconnecting' : 'offline'}"></span>
      <span class="sse-label">{sseConnected ? 'Live' : sseReconnecting ? 'Reconnecting' : 'Offline'}</span>
    </span>
    <button class="btn btn-ghost btn-sm" onclick={() => load()} disabled={loading || streaming}>
      {loading ? 'Loading…' : streaming ? 'Streaming…' : 'Refresh'}
    </button>
  </div>
</div>

<!-- ── New entries banner ──────────────────────────────────────────────── -->
{#if newCount > 0}
  <div class="new-banner" role="status">
    <span class="new-banner__dot"></span>
    {newCount} new {newCount === 1 ? 'entry' : 'entries'} from latest cycle
  </div>
{/if}

<!-- ── Stats bar (unified type filter + counts) ────────────────────────── -->
{#if !loading && entries.length > 0}
  <div class="stats-bar" role="group" aria-label="Filter by memory type">
    <!-- "All" chip — always the first pill -->
    <button
      class="stats-chip stats-chip--all"
      class:stats-chip--active={typeFilter === 'all'}
      style="--chip-color: var(--color-text-muted);"
      onclick={() => typeFilter = 'all'}
      title="Show all types"
      aria-pressed={typeFilter === 'all'}
    >
      <span class="stats-chip__count">{entries.length}</span>
      <span class="stats-chip__label">All</span>
    </button>
    {#each Object.entries(typeCounts) as [type, count] (type)}
      {@const cfg = TYPE_CONFIG[type] ?? FALLBACK_CONFIG}
      <button
        class="stats-chip"
        class:stats-chip--active={typeFilter === type}
        style="--chip-color: {cfg.color};"
        onclick={() => typeFilter = typeFilter === type ? 'all' : type}
        title="Filter by {type}"
        aria-pressed={typeFilter === type}
      >
        <span class="stats-chip__count">{count}</span>
        <span class="stats-chip__label">{cfg.label || type}</span>
      </button>
    {/each}
  </div>
{/if}

<!-- ── Search + agent filter ──────────────────────────────────────────── -->
<div class="filter-bar">
  <div class="search-wrapper">
    <svg class="search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" stroke-width="1.3"/>
      <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <input
      class="search-input"
      type="search"
      placeholder="Search keys, values, tags, sprint version…"
      bind:value={searchQuery}
      aria-label="Search memory entries"
    />
  </div>
  {#if agents.length > 0}
    <select class="agent-select" bind:value={agentFilter} aria-label="Filter by source">
      <option value="all">All sources ({entries.length})</option>
      {#each agents as agent (agent)}
        <option value={agent}>{sourceLabel(agent)}</option>
      {/each}
    </select>
  {/if}
</div>

{#if deleteError}
  <div class="error-banner">{deleteError}</div>
{/if}

<!-- ── Table ──────────────────────────────────────────────────────────── -->
{#if loading}
  <div class="card" style="padding: 0; overflow: hidden;">
    <table class="data-table">
      <thead>
        <tr><th>Key</th><th>Type</th><th>Value</th><th>Source</th><th>Age</th><th></th></tr>
      </thead>
      <tbody>
        {#each Array(8) as _, i}
          <tr>
            <td><div class="skeleton" style="height: 14px; width: {80 + (i * 17 % 60)}px;"></div></td>
            <td><div class="skeleton" style="height: 18px; width: 90px; border-radius: 4px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: {160 + (i * 23 % 80)}px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 72px;"></div></td>
            <td><div class="skeleton" style="height: 14px; width: 60px;"></div></td>
            <td></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else if error}
  <div class="empty-state">
    <span class="empty-icon">⚠</span>
    <p>Failed to load memory.</p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)" onclick={() => load()}>Retry</button>
  </div>
{:else if entries.length === 0}
  <div class="empty-state">
    <span class="empty-icon">◈</span>
    <p>No memory entries yet.</p>
    <p style="font-size: var(--text-xs); color: var(--color-text-faint); margin-top: var(--space-1);">
      Entries appear when cycles complete and write to .agentforge/memory/
    </p>
  </div>
{:else if filteredEntries.length === 0}
  <div class="empty-state">
    <span class="empty-icon">∅</span>
    <p>No entries match your search.</p>
    <button class="btn btn-ghost btn-sm" style="margin-top: var(--space-3)"
      onclick={() => { searchQuery = ''; agentFilter = 'all'; typeFilter = 'all'; }}>
      Clear filters
    </button>
  </div>
{:else}
  <div class="card mem-card">
    <table class="data-table mem-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Value</th>
          <th>Source</th>
          <th>Age</th>
          <th style="width: 36px;"></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredEntries as entry (entry.id)}
          {@const cfg = getTypeConfig(entry)}
          {@const isNew = newIds.has(entry.id)}
          {@const isExpanded = expanded.has(entry.id)}
          {@const sprintVerForKey = resolveSprintVersion(entry)}
          <tr
            class="mem-row"
            class:mem-row--deleting={deleting.has(entry.id)}
            class:mem-row--expanded={isExpanded}
            class:mem-row--new={isNew}
            style="--row-accent: {cfg.color};"
            onclick={() => toggleExpand(entry.id)}
            role="button"
            tabindex="0"
            onkeydown={(e) => e.key === 'Enter' && toggleExpand(entry.id)}
            aria-expanded={isExpanded}
          >
            <!-- Key column — expand chevron gives visual affordance for the clickable row -->
            <td class="col-key">
              <div class="key-wrap">
                <div class="key-header">
                  <code class="key-cell">{entry.key}</code>
                  <span class="expand-icon" aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                </div>
                {#if entry.tags && entry.tags.length > 0 || sprintVerForKey}
                  <div class="tag-row">
                    {#if sprintVerForKey && !sprintTagFromEntry(entry)}
                      <!-- Sprint version chip for entries whose sprint is in JSON value, not tags -->
                      <span class="tag-chip tag-chip--sprint">{sprintVerForKey}</span>
                    {/if}
                    {#each (entry.tags ?? []) as tag (tag)}
                      <span class="tag-chip" class:tag-chip--sprint-tag={tag.startsWith('sprint:')}>{tag}</span>
                    {/each}
                  </div>
                {/if}
              </div>
            </td>

            <!-- Type chip column -->
            <td class="col-type">
              <span class="badge {cfg.badge}">{cfg.label || (entry.type ?? typeof entry.value)}</span>
            </td>

            <!-- Value column — semantic preview per entry type -->
            <td class="col-value">
              {#if entry.type === 'gate-verdict'}
                {@const vi = extractVerdictInfo(entry)}
                {#if vi}
                  <span class="value-preview value-preview--verdict">
                    <span class="verdict-inline {verdictColorClass(vi.verdict)}">{vi.verdict}</span>
                    {#if vi.sprintVersion}<span class="verdict-version">{vi.sprintVersion}</span>{/if}
                  </span>
                {:else}
                  <span class="value-preview">{entry.summary ?? formatValue(entry.value)}</span>
                {/if}
              {:else if entry.type === 'review-finding'}
                {@const rfi = extractReviewFindingInfo(entry)}
                <span class="value-preview value-preview--finding">
                  {#if rfi?.severity}
                    <span class="finding-sev finding-sev--{rfi.severity}">{rfi.severity}</span>
                  {/if}
                  <span class="finding-preview-text">{entry.summary ? stripMarkdown(entry.summary) : formatValue(entry.value)}</span>
                </span>
              {:else if entry.type === 'cycle-outcome'}
                {@const coi = extractCycleOutcomeInfo(entry)}
                {#if coi}
                  <span class="value-preview value-preview--outcome">
                    <span class="outcome-stage-chip outcome-stage-chip--{coi.stage}">{coi.stage}</span>
                    {#if coi.testsPassed !== undefined}
                      <span class="outcome-tests">{coi.testsPassed.toLocaleString()} tests</span>
                    {/if}
                    {#if coi.costUsd !== undefined}
                      <span class="outcome-cost-chip">${coi.costUsd.toFixed(2)}</span>
                    {/if}
                  </span>
                {:else}
                  <span class="value-preview">{entry.summary ?? formatValue(entry.value)}</span>
                {/if}
              {:else}
                <span class="value-preview">
                  {entry.summary ? stripMarkdown(entry.summary) : formatValue(entry.value)}
                </span>
              {/if}
            </td>

            <!-- Source link column — stopPropagation so click doesn't toggle expand -->
            <td class="col-source" onclick={(e) => e.stopPropagation()}>
              {#if entry.source}
                {#if isCycleId(entry.source)}
                  {@const sprintVer = resolveSprintVersion(entry)}
                  <div class="source-stack">
                    <a
                      class="source-link source-link--cycle"
                      href="/cycles/{entry.source}"
                      title="View cycle {entry.source}"
                    >
                      <span class="source-prefix">cycle</span>
                      {shortSource(entry.source)}
                    </a>
                    {#if sprintVer}
                      <a
                        class="source-link source-link--sprint"
                        href="/sprints/{encodeURIComponent(sprintVer)}"
                        title="View sprint {sprintVer}"
                      >
                        <span class="source-prefix">sprint</span>
                        {sprintVer}
                      </a>
                    {/if}
                  </div>
                {:else}
                  <a
                    class="source-link source-link--agent"
                    href="/agents/{encodeURIComponent(entry.source)}"
                    title="View agent {entry.source}"
                  >
                    <span class="source-prefix">agent</span>
                    {entry.source}
                  </a>
                {/if}
              {:else}
                <span class="source-none">—</span>
              {/if}
            </td>

            <!-- Age column -->
            <td class="col-age">
              {formatRelative(entry.updatedAt ?? entry.createdAt)}
            </td>

            <!-- Delete button -->
            <td class="col-delete" onclick={(e) => e.stopPropagation()}>
              <button
                class="delete-btn"
                onclick={() => deleteEntry(entry.id)}
                disabled={deleting.has(entry.id)}
                aria-label="Delete {entry.key}"
              >
                {deleting.has(entry.id) ? '…' : '×'}
              </button>
            </td>
          </tr>

          <!-- Full-width detail row — visible only when expanded ──────────── -->
          {#if isExpanded}
            <tr class="mem-detail-row" style="--row-accent: {cfg.color};">
              <td colspan="6" class="mem-detail-cell">
                <div class="mem-detail">

                  <!-- Metadata strip: id, dates, tags -->
                  <div class="detail-meta">
                    <span class="detail-meta-item">
                      <span class="detail-label">ID</span>
                      <code class="detail-code">{entry.id}</code>
                    </span>
                    {#if entry.createdAt}
                      <span class="detail-meta-item">
                        <span class="detail-label">Created</span>
                        <time datetime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                      </span>
                    {/if}
                    {#if entry.updatedAt && entry.updatedAt !== entry.createdAt}
                      <span class="detail-meta-item">
                        <span class="detail-label">Updated</span>
                        <time datetime={entry.updatedAt}>{formatDate(entry.updatedAt)}</time>
                      </span>
                    {/if}
                    {#if entry.source}
                      <span class="detail-meta-item">
                        <span class="detail-label">Source</span>
                        {#if isCycleId(entry.source)}
                          <div class="source-stack">
                            <a class="source-link source-link--cycle" href="/cycles/{entry.source}" title="View cycle {entry.source}">
                              <span class="source-prefix">cycle</span>{shortSource(entry.source)}
                            </a>
                          </div>
                        {:else}
                          <a class="source-link source-link--agent" href="/agents/{encodeURIComponent(entry.source)}" title="View agent {entry.source}">
                            <span class="source-prefix">agent</span>{entry.source}
                          </a>
                        {/if}
                      </span>
                    {/if}
                    {#if entry.type}
                      <span class="detail-meta-item">
                        <span class="detail-label">File</span>
                        <code class="detail-code detail-code--file">{entry.type}.jsonl</code>
                      </span>
                    {/if}
                    {#if resolveSprintVersion(entry)}
                      {@const sv = resolveSprintVersion(entry)}
                      <span class="detail-meta-item">
                        <span class="detail-label">Sprint</span>
                        <a
                          class="source-link source-link--sprint detail-sprint-link"
                          href="/sprints/{encodeURIComponent(sv ?? '')}"
                          title="View sprint {sv}"
                          onclick={(e) => e.stopPropagation()}
                        >
                          {sv}
                        </a>
                      </span>
                    {/if}
                  </div>

                  <!-- Summary line (only for types without a dedicated panel) -->
                  {#if entry.summary && entry.type !== 'gate-verdict' && entry.type !== 'review-finding' && entry.type !== 'cycle-outcome'}
                    <p class="detail-summary">{stripMarkdown(entry.summary)}</p>
                  {/if}

                  <!-- Cycle-outcome structured panel ────────────────────────── -->
                  {#if entry.type === 'cycle-outcome'}
                    {@const coi = extractCycleOutcomeInfo(entry)}
                    {#if coi}
                      <div class="outcome-panel">
                        <div class="outcome-hero">
                          <span class="outcome-badge outcome-badge--{coi.stage}">{coi.stage}</span>
                          {#if coi.sprintVersion}
                            <span class="verdict-sprint">Sprint {coi.sprintVersion}</span>
                          {/if}
                          {#if coi.cycleId}
                            <a class="source-link source-link--cycle outcome-cycle-link"
                               href="/cycles/{coi.cycleId}"
                               title="View cycle {coi.cycleId}"
                               onclick={(e) => e.stopPropagation()}>
                              <span class="source-prefix">cycle</span>{coi.cycleId.slice(0, 8)}
                            </a>
                          {/if}
                          {#if coi.prUrl}
                            <a class="outcome-pr-link"
                               href={coi.prUrl}
                               target="_blank"
                               rel="noopener noreferrer"
                               onclick={(e) => e.stopPropagation()}>
                              Open PR ↗
                            </a>
                          {/if}
                        </div>
                        {#if coi.testsPassed !== undefined || coi.costUsd !== undefined}
                          <div class="outcome-stats">
                            {#if coi.testsPassed !== undefined}
                              <div class="outcome-stat-item">
                                <span class="verdict-section-label">Tests passed</span>
                                <span class="outcome-stat-value">{coi.testsPassed.toLocaleString()}</span>
                              </div>
                            {/if}
                            {#if coi.costUsd !== undefined}
                              <div class="outcome-stat-item">
                                <span class="verdict-section-label">Cost</span>
                                <span class="outcome-stat-value">${coi.costUsd.toFixed(2)}</span>
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {/if}
                  {/if}

                  <!-- Review-finding structured panel ───────────────────────── -->
                  {#if entry.type === 'review-finding'}
                    {@const rfi = extractReviewFindingInfo(entry)}
                    {#if rfi}
                      <div class="finding-panel finding-panel--{rfi.severity ?? 'minor'}">
                        <div class="finding-hero">
                          {#if rfi.severity}
                            <span class="finding-badge finding-badge--{rfi.severity}">{rfi.severity.toUpperCase()}</span>
                          {/if}
                          {#if rfi.sprintVersion}
                            <span class="verdict-sprint">Sprint {rfi.sprintVersion}</span>
                          {/if}
                          {#if rfi.cycleId}
                            <a class="source-link source-link--cycle"
                               href="/cycles/{rfi.cycleId}"
                               title="View cycle {rfi.cycleId}"
                               onclick={(e) => e.stopPropagation()}>
                              <span class="source-prefix">cycle</span>{rfi.cycleId.slice(0, 8)}
                            </a>
                          {/if}
                        </div>
                        <p class="finding-text-full">{stripMarkdown(rfi.text)}</p>
                      </div>
                    {/if}
                  {/if}

                  <!-- Gate-verdict structured view ──────────────────────────── -->
                  {#if entry.type === 'gate-verdict'}
                    {@const vi = extractVerdictInfo(entry)}
                    {#if vi}
                      <div class="verdict-panel">
                        <!-- Verdict hero row -->
                        <div class="verdict-hero">
                          <span class="verdict-badge {verdictColorClass(vi.verdict)}">{vi.verdict}</span>
                          {#if vi.sprintVersion}
                            <span class="verdict-sprint">Sprint {vi.sprintVersion}</span>
                          {/if}
                          {#if vi.cycleId}
                            <a class="source-link source-link--cycle verdict-cycle-link"
                               href="/cycles/{vi.cycleId}"
                               title="View cycle {vi.cycleId}"
                               onclick={(e) => e.stopPropagation()}>
                              <span class="source-prefix">cycle</span>{vi.cycleId.slice(0, 8)}
                            </a>
                          {/if}
                        </div>

                        <!-- Rationale -->
                        {#if vi.rationale}
                          <div class="verdict-rationale">
                            <span class="verdict-section-label">Rationale</span>
                            <p class="verdict-rationale-text">{vi.rationale}</p>
                          </div>
                        {/if}

                        <!-- Critical findings -->
                        {#if vi.criticalFindings.length > 0}
                          <div class="verdict-findings verdict-findings--critical">
                            <span class="verdict-section-label">Critical findings ({vi.criticalFindings.length})</span>
                            <ul class="findings-list">
                              {#each vi.criticalFindings as f, i (i)}
                                <li class="findings-item">{f}</li>
                              {/each}
                            </ul>
                          </div>
                        {/if}

                        <!-- Major findings -->
                        {#if vi.majorFindings.length > 0}
                          <div class="verdict-findings verdict-findings--major">
                            <span class="verdict-section-label">Major findings ({vi.majorFindings.length})</span>
                            <ul class="findings-list">
                              {#each vi.majorFindings as f, i (i)}
                                <li class="findings-item">{f}</li>
                              {/each}
                            </ul>
                          </div>
                        {/if}
                      </div>
                    {/if}
                  {/if}

                  <!-- Full value JSON with syntax highlighting + copy button -->
                  <!-- For gate-verdict, collapse into a disclosure to reduce noise -->
                  {#if entry.type === 'gate-verdict'}
                    <details class="raw-json-details">
                      <summary class="raw-json-summary">Raw JSON</summary>
                      <div class="detail-value-wrap">
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        <pre class="value-expanded"><code>{@html highlightJSON(entry.value)}</code></pre>
                        <button
                          class="copy-btn"
                          onclick={(e) => copyValue(entry, e)}
                          aria-label="Copy JSON value for {entry.key}"
                        >{copiedId === entry.id ? '✓ Copied' : 'Copy'}</button>
                      </div>
                    </details>
                  {:else}
                    <div class="detail-value-wrap">
                      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                      <pre class="value-expanded"><code>{@html highlightJSON(entry.value)}</code></pre>
                      <button
                        class="copy-btn"
                        onclick={(e) => copyValue(entry, e)}
                        aria-label="Copy JSON value for {entry.key}"
                      >{copiedId === entry.id ? '✓ Copied' : 'Copy'}</button>
                    </div>
                  {/if}

                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<!-- ── Live event feed ─────────────────────────────────────────────────── -->
<!-- Collapsed by default — click the header to expand. Shows the last     -->
<!-- MAX_FEED_EVENTS SSE events received from /api/v1/stream.              -->
<div class="live-feed" class:live-feed--open={feedOpen}>
  <button
    class="live-feed__header"
    onclick={() => { feedOpen = !feedOpen; if (feedOpen) newFeedCount = 0; }}
    aria-expanded={feedOpen}
    aria-controls="live-feed-body"
  >
    <span class="live-feed__title">
      <span class="sse-dot-sm {sseConnected ? 'live' : sseReconnecting ? 'reconnecting' : 'offline'}"
            aria-hidden="true"></span>
      Live event feed
    </span>
    <span class="live-feed__meta">
      {#if !feedOpen && newFeedCount > 0}
        <span class="live-feed__badge" aria-label="{newFeedCount} new events">{newFeedCount} new</span>
      {:else if liveEvents.length > 0}
        <span class="live-feed__count">{liveEvents.length} event{liveEvents.length === 1 ? '' : 's'}</span>
      {/if}
      <span class="live-feed__chevron" aria-hidden="true">{feedOpen ? '▾' : '▸'}</span>
    </span>
  </button>

  {#if feedOpen}
    <div id="live-feed-body" class="live-feed__body" role="log" aria-live="polite" aria-label="Live SSE event feed">
      {#if liveEvents.length === 0}
        <div class="live-feed__empty">
          <span>No events yet — events appear here as cycles run.</span>
        </div>
      {:else}
        <ol class="live-feed__list" reversed>
          {#each liveEvents as ev, i (i)}
            {@const evLabel = ev.category ?? ev.type}
            {@const isCycleComplete =
              ev.type === 'cycle_event' && (
                ev.category === 'cycle.complete' ||
                ev.category === 'cycle.completed'
              )}
            {@const isFailed =
              (ev.type === 'cycle_event' && ev.category === 'cycle.failed') ||
              ev.type === 'session.failed'}
            {@const isSessionStart = ev.type === 'session.started'}
            <li class="feed-event"
                class:feed-event--complete={isCycleComplete}
                class:feed-event--failed={isFailed}
                class:feed-event--session={isSessionStart}>
              <time class="feed-event__ts" datetime={ev.ts}>{formatRelative(ev.ts)}</time>
              <span class="feed-event__chip feed-event__chip--{ev.type.replace(/[^a-z0-9]/gi, '-')}"
                    title={ev.type}>
                {evLabel}
              </span>
              {#if ev.message}
                <span class="feed-event__msg">{ev.message}</span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* ── Header ──────────────────────────────────────────────────────────────── */
  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .sse-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    cursor: default;
  }
  .sse-dot {
    width: 7px;
    height: 7px;
    border-radius: var(--radius-full);
    flex-shrink: 0;
  }
  .sse-dot.live {
    background: var(--color-success);
    box-shadow: 0 0 5px var(--color-success);
    animation: mem-pulse 2s ease-in-out infinite;
  }
  .sse-dot.reconnecting {
    background: var(--color-warning);
    animation: mem-blink 1s step-end infinite;
  }
  .sse-dot.offline {
    background: var(--color-danger);
  }
  .sse-label {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
  }

  /* Streaming state indicator shown in the page subtitle */
  .streaming-indicator {
    font-size: var(--text-xs);
    color: var(--color-sonnet);
    animation: mem-blink 1.2s step-end infinite;
  }

  @keyframes mem-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px var(--color-success); }
    50%       { opacity: 0.6; box-shadow: 0 0 8px var(--color-success); }
  }
  @keyframes mem-blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.2; }
  }

  /* ── New entries banner ───────────────────────────────────────────────────── */
  .new-banner {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: rgba(76, 175, 130, 0.08);
    border: 1px solid rgba(76, 175, 130, 0.25);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    color: var(--color-haiku);
    margin-bottom: var(--space-3);
    animation: slideIn 0.25s ease;
  }
  .new-banner__dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--color-haiku);
    flex-shrink: 0;
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Stats bar ────────────────────────────────────────────────────────────── */
  .stats-bar {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-bottom: var(--space-3);
  }
  .stats-chip {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
    background: color-mix(in srgb, var(--chip-color) 6%, transparent);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .stats-chip:hover {
    background: color-mix(in srgb, var(--chip-color) 12%, transparent);
    border-color: color-mix(in srgb, var(--chip-color) 50%, transparent);
  }
  .stats-chip--active {
    background: color-mix(in srgb, var(--chip-color) 18%, transparent);
    border-color: var(--chip-color);
  }
  .stats-chip__count {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--chip-color);
  }
  .stats-chip__label {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    white-space: nowrap;
  }

  /* ── Filter bar ───────────────────────────────────────────────────────────── */
  .filter-bar {
    display: flex;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }
  .search-wrapper {
    flex: 1;
    min-width: 200px;
    position: relative;
    display: flex;
    align-items: center;
  }
  .search-icon {
    position: absolute;
    left: var(--space-3);
    width: 14px;
    height: 14px;
    color: var(--color-text-faint);
    pointer-events: none;
    flex-shrink: 0;
  }
  .search-input {
    width: 100%;
    padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-3) + 14px + var(--space-2));
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    outline: none;
    transition: border-color 0.15s;
  }
  .search-input:focus {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 2px rgba(91,138,245,0.12);
  }
  .agent-select {
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s;
  }
  .agent-select:focus { border-color: var(--color-brand); }

  /* ── Error banner ─────────────────────────────────────────────────────────── */
  .error-banner {
    background: rgba(224,90,90,0.08);
    border: 1px solid rgba(224,90,90,0.25);
    color: var(--color-danger);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }

  /* ── Empty states ─────────────────────────────────────────────────────────── */
  .empty-icon {
    font-size: 28px;
    opacity: 0.25;
    margin-bottom: var(--space-2);
    display: block;
  }

  /* ── Memory table card ────────────────────────────────────────────────────── */
  .mem-card {
    padding: 0;
    overflow: hidden;
  }
  /* Remove global card hover transform for the table card */
  .mem-card:hover {
    transform: none;
    box-shadow: none;
  }

  .mem-table { table-layout: auto; }

  /* ── Memory rows — type-accented left border ─────────────────────────────── */
  .mem-row {
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-left-color 0.12s;
  }
  .mem-row:hover {
    background: var(--color-bg-card-hover);
    border-left-color: var(--row-accent);
  }
  .mem-row--expanded {
    background: rgba(255,255,255,0.02);
    border-left-color: var(--row-accent);
  }
  .mem-row--deleting {
    opacity: 0.45;
    pointer-events: none;
  }
  /* New entries: brief glow animation */
  .mem-row--new {
    animation: rowHighlight 3s ease-out forwards;
  }
  @keyframes rowHighlight {
    0%   { background: color-mix(in srgb, var(--row-accent) 12%, transparent); }
    40%  { background: color-mix(in srgb, var(--row-accent) 8%, transparent); }
    100% { background: transparent; }
  }

  /* ── Column widths ───────────────────────────────────────────────────────── */
  .col-key   { width: 18%; vertical-align: top; padding-top: var(--space-3); }
  .col-type  { width: 14%; white-space: nowrap; vertical-align: top; padding-top: var(--space-3); }
  .col-value { width: 40%; vertical-align: top; padding-top: var(--space-3); }
  .col-source{ width: 16%; vertical-align: top; padding-top: var(--space-2); }
  .col-age   {
    width: 10%;
    white-space: nowrap;
    vertical-align: top;
    padding-top: var(--space-3);
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .col-delete{ width: 36px; vertical-align: top; padding-top: var(--space-2); }

  /* ── Key cell ────────────────────────────────────────────────────────────── */
  .key-wrap { display: flex; flex-direction: column; gap: 3px; }
  .key-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-brand);
    word-break: break-all;
  }
  .tag-row { display: flex; flex-wrap: wrap; gap: 3px; }
  .tag-chip {
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-faint);
    white-space: nowrap;
    letter-spacing: 0.02em;
  }
  /* Sprint version chip: amber accent to match --color-opus */
  .tag-chip--sprint,
  .tag-chip--sprint-tag {
    background: color-mix(in srgb, var(--color-opus) 8%, transparent);
    border-color: color-mix(in srgb, var(--color-opus) 25%, transparent);
    color: var(--color-opus);
    font-weight: 600;
  }

  /* ── Value cell ──────────────────────────────────────────────────────────── */
  .value-preview {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360px;
  }
  .value-expanded {
    white-space: pre-wrap;
    word-break: break-word;
    max-width: 480px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.65;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-3) var(--space-4);
    overflow: auto;
    max-height: 240px;
  }

  /* ── Source link ─────────────────────────────────────────────────────────── */
  .source-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    text-decoration: none;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    transition: background 0.12s, border-color 0.12s;
  }
  .source-prefix {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    opacity: 0.6;
  }
  .source-link--cycle {
    color: var(--color-sonnet);
    border-color: rgba(74,158,255,0.2);
    background: rgba(74,158,255,0.06);
  }
  .source-link--cycle:hover {
    border-color: rgba(74,158,255,0.4);
    background: rgba(74,158,255,0.12);
  }
  .source-link--agent {
    color: var(--color-haiku);
    border-color: rgba(76,175,130,0.2);
    background: rgba(76,175,130,0.06);
  }
  .source-link--agent:hover {
    border-color: rgba(76,175,130,0.4);
    background: rgba(76,175,130,0.12);
  }
  .source-link--sprint {
    color: var(--color-opus);
    border-color: rgba(245,200,66,0.2);
    background: rgba(245,200,66,0.05);
  }
  .source-link--sprint:hover {
    border-color: rgba(245,200,66,0.4);
    background: rgba(245,200,66,0.1);
  }
  /* Stacks cycle + sprint links vertically in the source column */
  .source-stack {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
  }
  /* Sprint link in the detail metadata strip — no outer border box */
  .detail-sprint-link {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
  }
  .source-none { color: var(--color-text-faint); }

  /* ── Delete button ───────────────────────────────────────────────────────── */
  .delete-btn {
    background: transparent;
    border: none;
    color: var(--color-text-faint);
    font-size: var(--text-base);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: color 0.12s, background 0.12s;
  }
  .delete-btn:hover {
    color: var(--color-danger);
    background: rgba(224,90,90,0.08);
  }
  .delete-btn:disabled { opacity: 0.4; cursor: default; }

  /* ── Expand chevron in key column ───────────────────────────────────────── */
  .key-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .expand-icon {
    font-size: 10px;
    color: var(--color-text-faint);
    flex-shrink: 0;
    transition: color 0.12s;
  }
  .mem-row:hover .expand-icon,
  .mem-row--expanded .expand-icon {
    color: var(--color-text-muted);
  }

  /* ── Detail row (full-width expanded content) ────────────────────────────── */
  /*
   * Scope to .mem-table to win specificity over the global
   * `.data-table tbody tr:hover { cursor: pointer }` without !important.
   */
  .mem-table .mem-detail-row {
    background: var(--color-surface-1);
    border-left: 3px solid var(--row-accent);
    cursor: default;
  }
  .mem-table .mem-detail-row:hover {
    background: var(--color-surface-1);
  }
  .mem-table .mem-detail-cell {
    padding: 0;
  }
  .mem-detail {
    padding: var(--space-3) var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    border-bottom: 1px solid var(--color-border);
  }

  /* ── Detail metadata strip ───────────────────────────────────────────────── */
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-5);
    align-items: center;
  }
  .detail-meta-item {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
  }
  .detail-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--color-text-faint);
    flex-shrink: 0;
  }
  .detail-code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    background: var(--color-surface-2);
    padding: 1px 5px;
    border-radius: var(--radius-sm);
  }
  /* Dimmer style for the raw file path — it's reference info, not primary data */
  .detail-code--file {
    color: var(--color-text-faint);
    font-size: 10px;
  }

  /* ── Detail value block with copy button ─────────────────────────────────── */
  .detail-value-wrap {
    position: relative;
  }
  .detail-value-wrap .value-expanded {
    max-width: 100%;
    margin: 0;
    padding-right: var(--space-12, 3rem); /* room for copy button */
  }
  .copy-btn {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
    white-space: nowrap;
  }
  .copy-btn:hover {
    background: var(--color-surface-1);
    border-color: var(--color-brand);
    color: var(--color-brand);
  }

  /* ── JSON syntax highlighting ────────────────────────────────────────────── */
  .value-expanded code {
    /* Inherit font/size from the enclosing pre; reset defaults */
    font: inherit;
    background: none;
    padding: 0;
    border: none;
    display: block;
  }
  .value-expanded :global(.json-key)     { color: var(--color-brand); }
  .value-expanded :global(.json-string)  { color: var(--color-haiku); }
  .value-expanded :global(.json-number)  { color: var(--color-opus); }
  .value-expanded :global(.json-keyword) { color: var(--color-warning); }

  /* ── Summary line in expanded detail ────────────────────────────────────── */
  .detail-summary {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.55;
    padding: var(--space-2) var(--space-3);
    background: var(--color-surface-2);
    border-left: 2px solid var(--color-border-strong);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-style: italic;
  }

  /* ── Inline verdict chip (in table value cell) ────────────────────────── */
  .value-preview--verdict {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .verdict-inline {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    text-transform: uppercase;
  }
  .verdict-inline.verdict--pass   { background: rgba(76,175,130,0.15); color: var(--color-haiku); }
  .verdict-inline.verdict--reject { background: rgba(224,90,90,0.12); color: var(--color-danger); }
  .verdict-inline.verdict--neutral{ background: var(--color-surface-2); color: var(--color-text-muted); }
  .verdict-version {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-family: var(--font-mono);
  }

  /* ── Gate-verdict structured panel ──────────────────────────────────────── */
  .verdict-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
  }

  .verdict-hero {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .verdict-badge {
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 4px 12px;
    border-radius: var(--radius-md);
    text-transform: uppercase;
  }
  .verdict-badge.verdict--pass   { background: rgba(76,175,130,0.18); color: var(--color-haiku);  border: 1px solid rgba(76,175,130,0.35); }
  .verdict-badge.verdict--reject { background: rgba(224,90,90,0.15);  color: var(--color-danger); border: 1px solid rgba(224,90,90,0.35); }
  .verdict-badge.verdict--neutral{ background: var(--color-surface-1); color: var(--color-text-muted); border: 1px solid var(--color-border); }

  .verdict-sprint {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    background: var(--color-surface-1);
    padding: 2px 8px;
    border-radius: var(--radius-full);
    border: 1px solid var(--color-border);
  }
  .verdict-cycle-link {
    margin-left: auto;
  }

  .verdict-section-label {
    display: block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--color-text-faint);
    margin-bottom: var(--space-1);
  }

  .verdict-rationale { display: flex; flex-direction: column; }
  .verdict-rationale-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.6;
  }

  .verdict-findings { display: flex; flex-direction: column; }

  .findings-list {
    margin: 0;
    padding-left: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .findings-item {
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    line-height: 1.55;
  }
  .verdict-findings--critical .findings-item { color: var(--color-danger); }
  .verdict-findings--major .findings-item    { color: var(--color-warning, #e0a050); }

  /* ── Raw JSON disclosure (gate-verdict) ──────────────────────────────────── */
  .raw-json-details {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .raw-json-summary {
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
    user-select: none;
    background: var(--color-surface-1);
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .raw-json-summary::before {
    content: '▸';
    font-size: 9px;
    transition: transform 0.15s;
  }
  .raw-json-details[open] .raw-json-summary::before {
    transform: rotate(90deg);
  }
  .raw-json-details .detail-value-wrap {
    border-radius: 0;
  }
  .raw-json-details .value-expanded {
    border-radius: 0;
    border: none;
    border-top: 1px solid var(--color-border);
    max-width: 100%;
  }

  /* ── Stats-bar "All" chip variant ────────────────────────────────────────── */
  .stats-chip--all {
    border-style: dashed;
  }
  .stats-chip--all.stats-chip--active {
    border-style: solid;
    border-color: var(--color-text-muted);
    background: color-mix(in srgb, var(--color-text-muted) 10%, transparent);
  }

  /* ── Live event feed ─────────────────────────────────────────────────────── */
  .live-feed {
    margin-top: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .live-feed__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: var(--space-2) var(--space-4);
    background: var(--color-surface-1);
    border: none;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
    gap: var(--space-3);
  }
  .live-feed__header:hover {
    background: var(--color-bg-card-hover);
  }

  .live-feed__title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .live-feed__meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .live-feed__count {
    font-size: var(--text-xs);
    font-family: var(--font-mono);
    color: var(--color-text-faint);
    background: var(--color-surface-2);
    padding: 1px 6px;
    border-radius: var(--radius-full);
  }
  .live-feed__chevron {
    font-size: 10px;
    color: var(--color-text-faint);
    transition: color 0.12s;
  }
  .live-feed__header:hover .live-feed__chevron {
    color: var(--color-text-muted);
  }

  /* Small SSE dot variant for use in the feed header */
  .sse-dot-sm {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    flex-shrink: 0;
  }
  .sse-dot-sm.live {
    background: var(--color-success);
    animation: mem-pulse 2s ease-in-out infinite;
  }
  .sse-dot-sm.reconnecting {
    background: var(--color-warning);
    animation: mem-blink 1s step-end infinite;
  }
  .sse-dot-sm.offline { background: var(--color-danger); }

  .live-feed__body {
    background: var(--color-bg);
    border-top: 1px solid var(--color-border);
    max-height: 280px;
    overflow-y: auto;
    padding: var(--space-2) 0;
  }

  .live-feed__empty {
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    font-style: italic;
  }

  /* Event list — newest first (list is reversed in HTML) */
  .live-feed__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .feed-event {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-4);
    font-size: var(--text-xs);
    border-left: 2px solid transparent;
    transition: background 0.1s;
  }
  .feed-event:hover {
    background: var(--color-surface-1);
  }
  .feed-event--complete {
    border-left-color: var(--color-success);
  }
  .feed-event--failed {
    border-left-color: var(--color-danger);
  }
  .feed-event--session {
    border-left-color: var(--color-sonnet);
  }

  .feed-event__ts {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--color-text-faint);
    white-space: nowrap;
    flex-shrink: 0;
    width: 52px; /* fixed width keeps columns aligned */
  }

  .feed-event__chip {
    display: inline-block;
    font-size: 9px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: var(--radius-full);
    white-space: nowrap;
    flex-shrink: 0;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    color: var(--color-text-faint);
    letter-spacing: 0.03em;
  }
  /* Semantic colour overrides for known event types */
  .feed-event__chip--cycle_event           { color: var(--color-sonnet);  border-color: rgba(74,158,255,0.25); background: rgba(74,158,255,0.07); }
  .feed-event__chip--session-started       { color: var(--color-haiku);   border-color: rgba(76,175,130,0.25); background: rgba(76,175,130,0.07); }
  .feed-event__chip--session-completed     { color: var(--color-haiku);   border-color: rgba(76,175,130,0.3);  background: rgba(76,175,130,0.1); }
  .feed-event__chip--session-failed        { color: var(--color-danger);  border-color: rgba(224,90,90,0.25);  background: rgba(224,90,90,0.07); }
  .feed-event__chip--workflow_event        { color: var(--color-opus);    border-color: rgba(245,200,66,0.25); background: rgba(245,200,66,0.07); }
  .feed-event__chip--refresh_signal        { color: var(--color-brand);   border-color: rgba(91,138,245,0.25); background: rgba(91,138,245,0.07); }

  .feed-event__msg {
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  /* ── Review-finding severity badge (inline in value column) ─────────────── */
  .value-preview--finding {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    overflow: hidden;
  }
  .finding-sev {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .finding-sev--critical {
    background: rgba(224,90,90,0.15);
    color: var(--color-danger);
    border: 1px solid rgba(224,90,90,0.35);
  }
  .finding-sev--major {
    background: rgba(224,160,80,0.13);
    color: var(--color-warning, #e0a050);
    border: 1px solid rgba(224,160,80,0.35);
  }
  .finding-sev--minor {
    background: var(--color-surface-2);
    color: var(--color-text-faint);
    border: 1px solid var(--color-border);
  }
  .finding-preview-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    min-width: 0;
  }

  /* ── Cycle-outcome inline chips (in value column) ────────────────────────── */
  .value-preview--outcome {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }
  .outcome-stage-chip {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
  }
  .outcome-stage-chip--completed {
    background: rgba(76,175,130,0.12);
    color: var(--color-haiku);
    border: 1px solid rgba(76,175,130,0.3);
  }
  .outcome-stage-chip--failed {
    background: rgba(224,90,90,0.1);
    color: var(--color-danger);
    border: 1px solid rgba(224,90,90,0.3);
  }
  .outcome-stage-chip--running,
  .outcome-stage-chip--in_progress {
    background: rgba(74,158,255,0.1);
    color: var(--color-sonnet);
    border: 1px solid rgba(74,158,255,0.3);
  }
  /* Default / unknown stage */
  .outcome-stage-chip:not([class*="--completed"]):not([class*="--failed"]):not([class*="--running"]):not([class*="--in_progress"]) {
    background: var(--color-surface-2);
    color: var(--color-text-faint);
    border: 1px solid var(--color-border);
  }
  .outcome-tests,
  .outcome-cost-chip {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-faint);
    white-space: nowrap;
  }

  /* ── Cycle-outcome detail panel ──────────────────────────────────────────── */
  .outcome-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
  }
  .outcome-hero {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .outcome-badge {
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 4px 12px;
    border-radius: var(--radius-md);
    text-transform: uppercase;
  }
  .outcome-badge--completed {
    background: rgba(76,175,130,0.18);
    color: var(--color-haiku);
    border: 1px solid rgba(76,175,130,0.35);
  }
  .outcome-badge--failed {
    background: rgba(224,90,90,0.15);
    color: var(--color-danger);
    border: 1px solid rgba(224,90,90,0.35);
  }
  .outcome-badge--running,
  .outcome-badge--in_progress {
    background: rgba(74,158,255,0.12);
    color: var(--color-sonnet);
    border: 1px solid rgba(74,158,255,0.3);
  }
  /* Fallback for unknown stage — uses muted neutral */
  .outcome-badge:not([class*="--completed"]):not([class*="--failed"]):not([class*="--running"]):not([class*="--in_progress"]) {
    background: var(--color-surface-1);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }
  .outcome-cycle-link { margin-left: auto; }
  .outcome-pr-link {
    font-size: var(--text-xs);
    color: var(--color-brand);
    text-decoration: none;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid rgba(91,138,245,0.25);
    background: rgba(91,138,245,0.07);
    transition: background 0.12s, border-color 0.12s;
  }
  .outcome-pr-link:hover {
    background: rgba(91,138,245,0.14);
    border-color: rgba(91,138,245,0.45);
  }
  .outcome-stats {
    display: flex;
    gap: var(--space-6);
    flex-wrap: wrap;
  }
  .outcome-stat-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .outcome-stat-value {
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--color-text);
  }

  /* ── Review-finding detail panel ─────────────────────────────────────────── */
  .finding-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface-2);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
  }
  .finding-panel--critical { border-left: 3px solid var(--color-danger); }
  .finding-panel--major    { border-left: 3px solid var(--color-warning, #e0a050); }
  .finding-panel--minor    { border-left: 3px solid var(--color-border-strong); }
  .finding-hero {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .finding-badge {
    font-size: var(--text-sm);
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 4px 12px;
    border-radius: var(--radius-md);
    text-transform: uppercase;
  }
  .finding-badge--critical {
    background: rgba(224,90,90,0.15);
    color: var(--color-danger);
    border: 1px solid rgba(224,90,90,0.35);
  }
  .finding-badge--major {
    background: rgba(224,160,80,0.13);
    color: var(--color-warning, #e0a050);
    border: 1px solid rgba(224,160,80,0.35);
  }
  .finding-badge--minor {
    background: var(--color-surface-1);
    color: var(--color-text-muted);
    border: 1px solid var(--color-border);
  }
  .finding-text-full {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--color-text-muted);
    line-height: 1.6;
    word-break: break-word;
  }

  /* ── Live feed new-event badge ────────────────────────────────────────────── */
  .live-feed__badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: rgba(91,138,245,0.18);
    border: 1px solid rgba(91,138,245,0.4);
    color: var(--color-brand);
    white-space: nowrap;
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.9); }
    to   { opacity: 1; transform: scale(1); }
  }

  /* ── feed-event chip: memory_written ─────────────────────────────────────── */
  .feed-event__chip--memory_written {
    color: var(--color-haiku);
    border-color: rgba(76,175,130,0.25);
    background: rgba(76,175,130,0.07);
  }

  /* ── Reduced motion ──────────────────────────────────────────────────────── */
  @media (prefers-reduced-motion: reduce) {
    .sse-dot.live { animation: none; }
    .sse-dot.reconnecting { animation: none; }
    .sse-dot-sm.live { animation: none; }
    .sse-dot-sm.reconnecting { animation: none; }
    .mem-row--new { animation: none; }
    .new-banner { animation: none; }
    .streaming-indicator { animation: none; }
  }

  /* ── Mobile ──────────────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .col-source { display: none; }
    .col-age    { display: none; }
    .value-preview { max-width: 200px; }
    .value-expanded { max-width: 100%; }
    .stats-bar  { display: none; }
    .detail-meta { flex-direction: column; gap: var(--space-1); }
    .copy-btn { position: static; margin-top: var(--space-2); }
    .detail-value-wrap .value-expanded { padding-right: var(--space-3); }
    .feed-event__ts { display: none; }
    .live-feed__body { max-height: 180px; }
  }
</style>
