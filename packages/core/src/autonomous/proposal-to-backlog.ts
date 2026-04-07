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

export interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  tags: string[];
  source: 'failed-session' | 'cost-anomaly' | 'task-outcome' | 'flaking-test' | 'todo-marker';
  confidence: number;
  estimatedCostUsd?: number;
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

    if (this.config.sourcing.includeTodoMarkers) {
      const markers = this.scanTodoMarkers();
      for (const m of markers) {
        items.push(m);
      }
    }

    return this.sanitizeItems(this.deduplicate(items));
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
          for (let i = 0; i < lines.length; i++) {
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
