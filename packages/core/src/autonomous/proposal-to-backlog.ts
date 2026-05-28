// packages/core/src/autonomous/proposal-to-backlog.ts
//
// Bridges SQLite-backed signals (failed sessions, cost anomalies, dead-end
// task outcomes, flaking tests) and codebase TODO(autonomous)/FIXME(autonomous)
// markers into a unified BacklogItem[] for the autonomous cycle's PLAN stage.
//
// The bridge takes a generic ProposalAdapter so it can be tested with mocks
// and so the production wiring (against WorkspaceAdapter) can live elsewhere.
//
// See docs/superpowers/specs/2026-04-06-autonomous-loop-design.md §6.3
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleConfig } from './types.js';
import type { ExecutionProviderKind, RuntimeMode } from '../runtime/types.js';

export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  source: 'failed-session' | 'cost-anomaly' | 'task-outcome' | 'flaking-test' | 'todo-marker' | 'backlog-file' | 'research-plan';
  confidence: number;
  estimatedCostUsd?: number;
  /** Declared complexity (from backlog files). Drives the unattended difficulty gate. */
  estimatedComplexity?: 'low' | 'medium' | 'high';
  /** Declared file scope. Required for unattended auto-pick of backlog-file items. */
  files?: string[];
  /** Optional per-item runtime routing hint from backlog files. */
  runtimeMode?: RuntimeMode;
  /** Optional per-item provider preference hint from backlog files. */
  preferredProvider?: ExecutionProviderKind;
}

export interface ProposalAdapter {
  getRecentFailedSessions(days: number): Promise<Array<{
    id: string;
    agent: string;
    error: string;
    confidence: number;
  }>>;
  getCostAnomalies(days: number): Promise<Array<{
    agent: string;
    anomaly: string;
    confidence: number;
  }>>;
  getFailedTaskOutcomes(days: number): Promise<Array<{
    taskId: string;
    description: string;
    confidence: number;
  }>>;
  getFlakingTests(days: number): Promise<Array<{
    file: string;
    name: string;
    failRate: number;
  }>>;
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', '.git', '.agentforge',
  'coverage', '.turbo', '.next', 'build',
  // v6.4.2: test dirs are excluded because test fixtures often contain
  // escaped TODO(autonomous) marker strings that are test data, not real
  // TODO markers. Scanning them fills the backlog with fixture noise.
  'tests', '__tests__', '__fixtures__', 'fixtures',
  // v14.2.0: Claude Code worktrees + .playwright-mcp/ contain duplicates of
  // the project tree. Scanning them produces TODO itemIds prefixed with
  // `todo--claude-worktrees-...` that confuse the scorer and re-pick items
  // already shipped. Observed in cycle b555cca4 (all 5 items had this
  // prefix and were duplicates of the polish wave's work).
  '.claude', '.playwright-mcp', 'playwright-report', 'test-results',
]);

// v6.4.2: additional per-file exclusions for test files that may live
// outside a tests/ directory (e.g., co-located *.test.ts next to source).
const SKIP_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/,
];

// v6.4.2: added `.md` so README and docs can carry real TODO(autonomous)
// markers. The scanner extracts the comment text from HTML-style comments
// (<!-- TODO(autonomous): ... -->) and from plain text lines.
const SCANNABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md',
]);

export class ProposalToBacklog {
  constructor(
    private readonly adapter: ProposalAdapter,
    private readonly cwd: string,
    private readonly config: CycleConfig,
  ) {}

  async build(): Promise<BacklogItem[]> {
    const items: BacklogItem[] = [];

    const [sessions, costs, outcomes, tests] = await Promise.all([
      this.adapter.getRecentFailedSessions(this.config.sourcing.lookbackDays),
      this.adapter.getCostAnomalies(this.config.sourcing.lookbackDays),
      this.adapter.getFailedTaskOutcomes(this.config.sourcing.lookbackDays),
      this.adapter.getFlakingTests(this.config.sourcing.lookbackDays),
    ]);

    const minConf = this.config.sourcing.minProposalConfidence;

    for (const s of sessions) {
      if (s.confidence < minConf) continue;
      items.push({
        id: `sess-${s.id}`,
        title: `Fix: ${s.agent} error: ${this.truncate(s.error, 80)}`,
        description: `Session ${s.id} failed with: ${s.error}. Investigate root cause and fix.`,
        priority: 'P0',
        tags: ['fix', 'bug'],
        source: 'failed-session',
        confidence: s.confidence,
      });
    }

    for (const c of costs) {
      if (c.confidence < minConf) continue;
      items.push({
        id: `cost-${c.agent}-${items.length}`,
        title: `Investigate cost anomaly in ${c.agent}`,
        description: `Cost anomaly detected: ${c.anomaly}. Investigate and optimize.`,
        priority: 'P1',
        tags: ['chore', 'performance'],
        source: 'cost-anomaly',
        confidence: c.confidence,
      });
    }

    for (const o of outcomes) {
      if (o.confidence < minConf) continue;
      items.push({
        id: `outcome-${o.taskId}`,
        title: `Revisit failed task: ${this.truncate(o.description, 80)}`,
        description: `Task ${o.taskId} reached a dead end. Re-approach or break down.`,
        priority: 'P1',
        tags: ['fix'],
        source: 'task-outcome',
        confidence: o.confidence,
      });
    }

    for (const t of tests) {
      if (t.failRate < 0.3) continue;
      items.push({
        id: `flaky-${t.file.replace(/\W/g, '-')}-${items.length}`,
        title: `Stabilize flaking test: ${t.name}`,
        description: `Test ${t.file} > ${t.name} flakes at ${(t.failRate * 100).toFixed(0)}%.`,
        priority: 'P1',
        tags: ['fix', 'chore'],
        source: 'flaking-test',
        confidence: Math.min(t.failRate + 0.3, 1.0),
      });
    }

    items.push(...this.readBacklogFiles());
    items.push(...this.readResearchPlans());

    if (this.config.sourcing.includeTodoMarkers) {
      const markers = this.scanTodoMarkers();
      for (const m of markers) {
        items.push(m);
      }
    }

    const base = this.applyCompletedItems(
      this.applyQuarantine(this.sanitizeItems(this.deduplicate(items))),
    );
    // Unattended runs must not auto-attempt items too large to ship in one
    // cycle — that was the root trigger of the 2026-05-25 spin. A human
    // (attended mode) can still pick big items or decompose them first.
    return process.env['AGENTFORGE_UNATTENDED'] === '1'
      ? this.applyDifficultyGate(base)
      : base;
  }

  /** Item ids the operator/loop has parked so they are never auto-picked again. */
  private readQuarantineIds(): Set<string> {
    const path = join(this.cwd, '.agentforge', 'backlog', 'quarantine.json');
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const ids = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { ids?: unknown } | null)?.ids)
          ? (parsed as { ids: unknown[] }).ids
          : [];
      return new Set(
        ids
          .map((x) => (typeof x === 'string' ? normalizeBacklogId(x) : null))
          .filter((id): id is string => id !== null),
      );
    } catch {
      return new Set();
    }
  }

  private applyQuarantine(items: BacklogItem[]): BacklogItem[] {
    const quarantined = this.readQuarantineIds();
    if (quarantined.size === 0) return items;
    return items.filter((item) => !quarantined.has(item.id));
  }

  /** Item ids already completed and merged; never pick them again. */
  private readCompletedItemIds(): Set<string> {
    const path = join(this.cwd, '.agentforge', 'backlog', 'completed.json');
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const entries = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { entries?: unknown } | null)?.entries)
          ? (parsed as { entries: unknown[] }).entries
          : [];
      const ids = entries
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const obj = entry as Record<string, unknown>;
          const rawId = typeof obj['itemId'] === 'string'
            ? obj['itemId']
            : typeof obj['id'] === 'string'
              ? obj['id']
              : null;
          if (rawId === null) return null;
          return normalizeBacklogId(rawId);
        })
        .filter((id): id is string => typeof id === 'string');
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  private applyCompletedItems(items: BacklogItem[]): BacklogItem[] {
    const completed = this.readCompletedItemIds();
    if (completed.size === 0) return items;
    return items.filter((item) => !completed.has(item.id));
  }

  /**
   * Unattended difficulty gate: refuse to auto-attempt backlog items that are
   * too large or too vague to ship in one cycle. Cost anomalies are broad
   * investigations with no file scope, so keep them for attended planning.
   */
  private applyDifficultyGate(items: BacklogItem[]): BacklogItem[] {
    return items.filter((item) => {
      if (item.source === 'cost-anomaly') return false;
      if (item.source === 'backlog-file') {
        if (item.estimatedComplexity === 'high') return false;
        if (item.files === undefined || item.files.length === 0) return false;
        return true;
      }
      if (item.source === 'research-plan') {
        if (item.estimatedComplexity !== 'low' && item.estimatedComplexity !== 'medium') return false;
        if (item.files === undefined || item.files.length === 0) return false;
        return true;
      }
      return true;
    });
  }

  private readBacklogFiles(): BacklogItem[] {
    const backlogDir = join(this.cwd, '.agentforge', 'backlog');
    let files: string[];
    try {
      files = readdirSync(backlogDir).filter((file) => file.endsWith('.json'));
    } catch {
      return [];
    }

    const items: BacklogItem[] = [];
    for (const file of files.sort()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(backlogDir, file), 'utf8'));
      } catch {
        continue;
      }

      const rawItems = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown } | null)?.items)
          ? (parsed as { items: unknown[] }).items
          : [];

      for (const raw of rawItems) {
        const item = normalizeBacklogFileItem(raw, file);
        if (item) items.push(item);
      }
    }

    return items;
  }

  private readResearchPlans(): BacklogItem[] {
    const researchDir = join(this.cwd, '.agentforge', 'research-runs');
    let runIds: string[];
    try {
      runIds = readdirSync(researchDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }

    const items: BacklogItem[] = [];
    for (const runId of runIds) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(researchDir, runId, 'run.json'), 'utf8'));
      } catch {
        continue;
      }

      const run = parsed as Record<string, unknown>;
      const plannedCycle = run['plannedCycle'];
      if (!plannedCycle || typeof plannedCycle !== 'object') continue;

      const ideaIds = Array.isArray((plannedCycle as { ideaIds?: unknown }).ideaIds)
        ? (plannedCycle as { ideaIds: unknown[] }).ideaIds
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim())
        : [];
      if (ideaIds.length === 0) continue;

      const plannedSet = new Set(ideaIds);
      const ideas = Array.isArray(run['ideas']) ? run['ideas'] : [];
      for (const rawIdea of ideas) {
        const idea = normalizeResearchIdeaCandidate(rawIdea, runId, plannedSet);
        if (idea) items.push(idea);
      }
    }

    return items;
  }

  private scanTodoMarkers(): BacklogItem[] {
    const items: BacklogItem[] = [];
    const pattern = new RegExp(this.config.sourcing.todoMarkerPattern);

    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          const ext = entry.slice(entry.lastIndexOf('.'));
          if (!SCANNABLE_EXTENSIONS.has(ext)) continue;

          // v6.4.2: skip test files even when they live next to source
          if (SKIP_FILE_PATTERNS.some(p => p.test(entry))) continue;

          let content: string;
          try {
            content = readFileSync(full, 'utf8');
          } catch {
            continue;
          }

          // v6.4.4: strict line-level match — the marker must be preceded
          // only by comment characters (//, /*, *, <!--, #) plus optional
          // text. This prevents false positives from strings, regex
          // literals, and object literals that embed the marker pattern.
          // The comment-prefix group is optional so plain-text lines in
          // Markdown files (no <!-- wrapper needed) are also captured.
          // False positives from embedded strings are still blocked because
          // `^` anchors the pattern — a line starting with `const`/`let`/
          // etc. won't match even without the prefix requirement.
          // `pattern` (from config) is retained as a capability gate; the
          // real extraction uses markerLine below.
          // [^<\n]*? (not [^\n]*?) prevents the non-greedy scan from
          // crossing a `<` character.  Without this, a line like:
          //   // (<!-- TODO(autonomous): ... -->) and from plain text lines.
          // would match because `//` is the prefix and `[^\n]*?` expands
          // past the `<` in `<!--` to reach the marker.  Blocking `<`
          // ensures that a `//` line comment can only match when the marker
          // appears directly after the `//` prefix (no embedded `<!--`).
          // `<!--` itself as a *prefix* still works: after the prefix is
          // consumed the remaining text starts with a space, not `<`.
          const markerLine = /^\s*(?:(?:\/\/|\/\*+|\*|<!--|#)[^<\n]*?)?(TODO|FIXME)\(autonomous\):\s*(.+)$/;
          const lines = content.split('\n');
          // For markdown files, track whether we are inside a fenced code
          // block (``` or ~~~).  Lines inside fences are documentation
          // examples — they must not be treated as real TODO markers.
          // inCodeFence is reset per-file because the outer loop continues
          // to the next file after this inner loop exits.
          let inCodeFence = false;
          for (let i = 0; i < lines.length; i++) {
            if (ext === '.md' && /^\s*(`{3,}|~{3,})/.test(lines[i]!)) {
              inCodeFence = !inCodeFence;
              continue;
            }
            if (inCodeFence) continue;
            if (!pattern.test(lines[i]!)) continue;
            const marker = lines[i]!.match(markerLine);
            if (!marker) continue;
            {
              let text = (marker[2] ?? '').trim();
              if (!text) continue;

              // v6.4.2: strip trailing HTML/markdown comment closers so
              // titles from README <!-- TODO(autonomous): X --> don't include "-->"
              text = text.replace(/\s*-->\s*$/, '').replace(/\s*\*\/\s*$/, '').trim();
              if (!text) continue;

              const rel = full.slice(this.cwd.length + 1);
              items.push({
                id: `todo-${rel.replace(/\W/g, '-')}-${i}`,
                title: text,
                description: `From ${rel}:${i + 1}`,
                priority: lines[i]!.includes('FIXME') ? 'P0' : 'P1',
                tags: this.inferTagsFromMarker(text),
                source: 'todo-marker',
                confidence: 1.0,
              });
            }
          }
        }
      }
    };

    walk(this.cwd);
    return items;
  }

  private inferTagsFromMarker(text: string): string[] {
    const lower = text.toLowerCase();
    if (/\b(breaking|rewrite|migrate|architecture)\b/.test(lower)) return ['breaking'];
    if (/\b(add|new|feature|implement)\b/.test(lower)) return ['feature'];
    if (/\b(fix|bug|security)\b/.test(lower)) return ['fix'];
    return ['chore'];
  }

  // Output-side guard: strip HTML/Markdown comment closers (-->, */) that
  // may arrive via adapter data (session errors, task descriptions, etc.)
  // before items are written into the backlog schema.  The equivalent
  // input-side strip lives in scanTodoMarkers(); this ensures every code
  // path through build() respects the same contract.
  //
  // stripClosers removes trailing --> and */ tokens.  The regex targets only
  // the trailing position so mid-string arrows (e.g. "a -> b") are preserved.
  private stripClosers(s: string): string {
    return s.replace(/\s*-->\s*$/, '').replace(/\s*\*\/\s*$/, '').trim();
  }

  private sanitizeItems(items: BacklogItem[]): BacklogItem[] {
    return items.map(item => ({
      ...item,
      id: this.stripClosers(item.id),
      title: this.stripClosers(item.title),
      description: this.stripClosers(item.description),
    }));
  }

  private deduplicate(items: BacklogItem[]): BacklogItem[] {
    const seen = new Set<string>();
    const result: BacklogItem[] = [];
    for (const item of items) {
      const key = item.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max - 3) + '...' : s;
  }
}

function normalizeBacklogFileItem(raw: unknown, fileName: string): BacklogItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  if (!title) return null;

  const idRaw = typeof obj['id'] === 'string' && obj['id'].trim()
    ? obj['id'].trim()
    : `${fileName}-${title}`;
  const normalizedId = normalizeBacklogId(idRaw);
  if (!normalizedId) return null;
  const priorityRaw = obj['priority'];
  const priority = priorityRaw === 'P0' || priorityRaw === 'P1' || priorityRaw === 'P2'
    ? priorityRaw
    : 'P2';
  const tags = Array.isArray(obj['tags'])
    ? obj['tags'].filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : ['chore'];
  const confidence = typeof obj['confidence'] === 'number' && Number.isFinite(obj['confidence'])
    ? Math.max(0, Math.min(1, obj['confidence']))
    : 0.9;
  const estimatedCostUsd = typeof obj['estimatedCostUsd'] === 'number' && Number.isFinite(obj['estimatedCostUsd'])
    ? obj['estimatedCostUsd']
    : costFromComplexity(obj['estimatedComplexity']);

  const item: BacklogItem = {
    id: normalizedId,
    title,
    description: typeof obj['description'] === 'string' && obj['description'].trim()
      ? obj['description'].trim()
      : title,
    priority,
    tags,
    source: 'backlog-file',
    confidence,
  };

  if (estimatedCostUsd !== undefined) {
    item.estimatedCostUsd = estimatedCostUsd;
  }

  const complexityRaw = typeof obj['estimatedComplexity'] === 'string'
    ? obj['estimatedComplexity'].toLowerCase()
    : undefined;
  if (complexityRaw === 'low' || complexityRaw === 'medium' || complexityRaw === 'high') {
    item.estimatedComplexity = complexityRaw;
  }

  const files = Array.isArray(obj['files'])
    ? obj['files'].filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    : [];
  if (files.length > 0) {
    item.files = files;
  }

  const runtimeMode = typeof obj['runtimeMode'] === 'string'
    ? obj['runtimeMode']
    : undefined;
  if (
    runtimeMode === 'auto'
    || runtimeMode === 'sdk'
    || runtimeMode === 'claude-code-compat'
    || runtimeMode === 'codex-cli'
    || runtimeMode === 'openai-sdk'
    || runtimeMode === 'anthropic-sdk'
  ) {
    item.runtimeMode = runtimeMode;
  }

  const preferredProvider = typeof obj['preferredProvider'] === 'string'
    ? obj['preferredProvider']
    : undefined;
  if (
    preferredProvider === 'claude-code-compat'
    || preferredProvider === 'codex-cli'
    || preferredProvider === 'openai-sdk'
    || preferredProvider === 'anthropic-sdk'
  ) {
    item.preferredProvider = preferredProvider;
  }

  return item;
}

function normalizeResearchIdeaCandidate(raw: unknown, runId: string, plannedIds: Set<string>): BacklogItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const ideaId = typeof obj['ideaId'] === 'string' ? obj['ideaId'].trim() : '';
  if (!ideaId || !plannedIds.has(ideaId)) return null;
  const status = typeof obj['status'] === 'string' ? obj['status'] : '';
  if (status !== 'planned') return null;

  const title = typeof obj['title'] === 'string' ? obj['title'].trim() : '';
  if (!title) return null;
  const problem = typeof obj['problem'] === 'string' ? obj['problem'].trim() : '';
  const hypothesis = typeof obj['hypothesis'] === 'string' ? obj['hypothesis'].trim() : '';
  const expectedImpact = typeof obj['expectedImpact'] === 'string' ? obj['expectedImpact'].trim() : '';
  const acceptanceChecks = Array.isArray(obj['acceptanceChecks'])
    ? obj['acceptanceChecks'].filter((check): check is string => typeof check === 'string' && check.trim().length > 0)
    : [];
  const touchedAreas = Array.isArray(obj['touchedAreas'])
    ? obj['touchedAreas'].filter((area): area is string => typeof area === 'string' && area.trim().length > 0)
    : [];
  const risk = typeof obj['risk'] === 'string' ? obj['risk'].toLowerCase() : '';
  const estimatedComplexity = risk === 'low' || risk === 'medium' || risk === 'high'
    ? risk
    : undefined;
  const estimatedCostUsd = estimatedComplexity === 'low'
    ? 1
    : estimatedComplexity === 'medium'
      ? 2
      : estimatedComplexity === 'high'
        ? 3
        : undefined;

  const normalizedId = normalizeBacklogId(`research-${runId}-${ideaId}`);
  if (!normalizedId) return null;

  const sections = [
    `Problem: ${problem || '(not provided)'}`,
    `Hypothesis: ${hypothesis || '(not provided)'}`,
    `Expected impact: ${expectedImpact || '(not provided)'}`,
    `Acceptance checks: ${acceptanceChecks.length > 0 ? acceptanceChecks.map((c) => `- ${c}`).join('; ') : '(not provided)'}`,
  ];

  return {
    id: normalizedId,
    title,
    description: sections.join('\n'),
    priority: 'P1',
    tags: ['research', 'rd'],
    source: 'research-plan',
    confidence: 0.9,
    ...(estimatedComplexity ? { estimatedComplexity } : {}),
    ...(touchedAreas.length > 0 ? { files: touchedAreas } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

function costFromComplexity(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    default:
      return undefined;
  }
}

function normalizeBacklogId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  normalized = normalized.replace(/^-+|-+$/g, '');
  if (!normalized) return null;

  if (normalized === 'backlog') return null;
  if (normalized.startsWith('backlog-')) return normalized;
  return `backlog-${normalized}`;
}
