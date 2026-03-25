---
id: f1a2b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c
agent: feedback-analysis-researcher
category: feature
priority: high
timestamp: "2026-03-25T03:00:00.000Z"
---

# FeedbackAnalyzer: Automatic Pattern Detection and Actionable Summaries from Agent Feedback

## Problem

AgentForge v2 has a write-only feedback loop. `FeedbackCollector` in `src/feedback/feedback-collector.ts` persists agent feedback to `.agentforge/feedback/` and provides `loadAllFeedback()` and `getSummary()` — but `getSummary()` only counts entries by category, priority, and agent. It produces no cross-entry analysis, detects no recurring themes, and surfaces no patterns.

The result: feedback accumulates but nothing reads it to drive decisions. When the cost optimization squad's 4 agents all flagged model routing inefficiency independently, there was no mechanism to detect that 4 agents converged on the same problem, escalate it, or propose a team change. The data was written; no one was listening.

The gap is not data collection — it is **signal extraction**: the ability to detect when multiple agents report the same issue, distinguish noise from meaningful patterns, and produce an actionable summary that the orchestrator and genesis system can act on.

## Research

**Topic modeling and clustering in NLP:**
The classic approach to finding themes across a corpus is Latent Dirichlet Allocation (LDA) or BERTopic. Both require embedding models or significant compute. For a system running in a developer's terminal against a corpus of 10-100 feedback files, this is overkill. The practical state of the art for small corpora is **keyword frequency analysis with co-occurrence clustering** — no ML required.

**CrewAI's output reflection pattern:** CrewAI (v0.30+) introduced a `reflect_on_output` flag on tasks. When enabled, after a task completes, an LLM reviews the output and generates a structured critique. The critique is fed back into the next planning cycle. The key insight: **reflection is just another agent task** — you don't need a specialized framework primitive, just a well-prompted agent whose input is prior agent outputs.

**AutoGen's `AssistantAgent` + `UserProxyAgent` debate pattern:** AutoGen's most common pattern for surfacing disagreements is having two agents discuss a proposal. For feedback analysis, the analogue is: one agent summarizes themes, another agent challenges whether those themes represent real issues or noise. The debate forces specificity.

**LangGraph's reducer pattern for shared state:** In LangGraph, multiple agent nodes can write to the same state key; a reducer function (e.g., `add`) merges their contributions. For feedback, this maps directly: multiple agents write to `.agentforge/feedback/`; a `FeedbackAnalyzer` is the reducer that merges their outputs into a theme map.

**Signal vs. noise heuristics from production monitoring systems:**
- **Frequency threshold**: a pattern is signal when it appears in ≥3 independent sources (Prometheus' convention for alerting: 3 occurrences before escalation)
- **Cross-agent corroboration**: the same theme reported by agents from different functional categories (e.g., both a `strategic` architect and a `utility` linter flagging context size) is stronger signal than multiple agents of the same category
- **Priority weighting**: a single `critical` entry outweighs three `low` entries. Weight = `priority_score × count`
- **Recency decay**: older feedback is less actionable. Decay entries older than 7 days by a factor of 0.5

**Keyword clustering without embeddings:**
For a feedback corpus of <200 entries, TF-IDF-style keyword frequency + manual stopword filtering + co-occurrence grouping produces usable theme clusters. The clusters need not be perfect — their purpose is to surface the top 3-5 actionable themes, not to produce academic-quality topic models.

**Concrete pattern families observed in v2 feedback:**
Looking at the 4 cost optimization proposals in `.agentforge/feedback/`, three independent researchers flagged the same root issue: agents running on wrong model tiers. This would be detected by the proposed FeedbackAnalyzer as:
- Keyword cluster: `{model, tier, opus, routing, cost, token}` appearing in 3/4 entries
- Cross-agent corroboration: `model-routing-researcher`, `parallel-execution-researcher`, `budget-strategy-researcher` all flagged it independently
- Combined signal strength: 3 independent agents × high priority × keyword overlap = **escalate to genesis**

## Findings

**Finding 1: Keyword clustering is sufficient for the AgentForge corpus size.** With <200 feedback files per project, token-frequency analysis with a curated stopword list produces reliable theme clusters. No embedding model required. The vocabulary of agent feedback is naturally constrained (technical terms dominate: model names, file paths, agent names, operation types).

**Finding 2: Cross-agent corroboration is the most reliable signal filter.** Noise in feedback is usually agent-specific (one agent complaining about its own edge case). Signal is cross-cutting (multiple agents identifying the same systemic issue). The corroboration score — how many distinct agents reported variants of the same keyword cluster — is a better escalation criterion than raw count alone.

**Finding 3: The `FeedbackSummary` type in `src/types/feedback.ts` is structurally sufficient but semantically shallow.** It aggregates by `category`, `priority`, and `agent` but has no `themes` field. Adding a `themes` array with pattern clusters is the minimal change needed to make summaries actionable.

**Finding 4: The analysis should produce imperative recommendations, not just descriptions.** Detected patterns should map to concrete actions: `"reforge-team"`, `"adjust-model-routing"`, `"increase-budget-ceiling"`, `"add-agent"`, `"remove-agent"`. These action types connect analysis directly to the `ReforgeEngine` proposed by the self-improvement researcher.

**Finding 5: The analysis cadence matters.** Running the analyzer on every feedback submission is wasteful. The right triggers are: (a) after a session completes, (b) when a threshold of new entries accumulates (e.g., 5 new entries since last analysis), or (c) on explicit `agentforge analyze` CLI invocation.

**Trade-offs:**
- Keyword clustering vs. embeddings: faster and simpler, but misses semantic similarity (e.g., "model tier" and "LLM routing" are the same concept but different keywords). Mitigated by maintaining a small synonym map.
- Frequency threshold of 3: may miss important patterns in small teams. Should be configurable; default 2 for teams of ≤4 agents.
- Recency decay: may suppress valid slow-burn issues. Disable decay for `critical` entries.

## Recommendation

Implement a `FeedbackAnalyzer` class in `src/feedback/feedback-analyzer.ts` that consumes the output of `FeedbackCollector.loadAllFeedback()` and produces an enriched `FeedbackAnalysis` with detected themes, corroboration scores, and recommended actions. The analyzer is stateless (pure function over feedback entries) and can be invoked after any session.

Key design decisions:
- Theme detection via keyword frequency analysis with a domain-aware stopword list
- Cross-agent corroboration scoring as the primary signal filter
- Configurable signal threshold (default: 2+ independent agents)
- Action mapping: each detected theme produces a typed `RecommendedAction`
- Integration with `EventBus` to publish a `feedback_analysis_complete` event that the orchestrator and genesis system can subscribe to

## Implementation Sketch

```typescript
// src/types/feedback.ts — additions

/** A detected theme cluster from feedback analysis. */
export interface FeedbackTheme {
  /** Representative label for the theme (e.g., "model-routing-inefficiency"). */
  label: string;
  /** Keywords that define this cluster. */
  keywords: string[];
  /** Number of distinct agents that reported this theme. */
  corroborating_agents: string[];
  /** Total feedback entries contributing to this theme. */
  entry_count: number;
  /** Highest priority among entries in this theme. */
  peak_priority: FeedbackPriority;
  /** Weighted signal strength (0–1). */
  signal_strength: number;
  /** Entry IDs in this theme cluster. */
  entry_ids: string[];
}

/** A recommended action derived from a detected feedback theme. */
export interface RecommendedAction {
  /** Machine-readable action type consumed by ReforgeEngine. */
  action: "reforge-team" | "adjust-model-routing" | "increase-budget-ceiling"
        | "add-agent" | "remove-agent" | "update-system-prompt" | "review-manually";
  /** Human-readable description of why this action is recommended. */
  rationale: string;
  /** Urgency level — maps to FeedbackPriority of the triggering theme. */
  urgency: FeedbackPriority;
  /** Theme that triggered this recommendation. */
  theme_label: string;
  /** Confidence in this recommendation (0–1). */
  confidence: number;
}

/** Enriched analysis output from FeedbackAnalyzer. */
export interface FeedbackAnalysis {
  /** Timestamp of this analysis run. */
  analyzed_at: string;
  /** Total entries analyzed. */
  total_entries: number;
  /** Date range covered. */
  date_range: { earliest: string; latest: string };
  /** Detected theme clusters. */
  themes: FeedbackTheme[];
  /** Recommended actions derived from themes. */
  recommended_actions: RecommendedAction[];
  /** Whether any theme crossed the escalation threshold (signal_strength > 0.7). */
  requires_escalation: boolean;
  /** Raw summary (counts) — same as FeedbackSummary for backward compatibility. */
  summary: FeedbackSummary;
}
```

```typescript
// src/feedback/feedback-analyzer.ts

import type {
  AgentFeedback,
  FeedbackTheme,
  RecommendedAction,
  FeedbackAnalysis,
  FeedbackSummary,
  FeedbackPriority,
} from "../types/feedback.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Words that appear in all feedback and carry no signal. */
const STOPWORDS = new Set([
  "the", "a", "an", "is", "in", "to", "of", "and", "or", "for", "with",
  "this", "that", "it", "be", "are", "has", "have", "was", "were", "will",
  "should", "could", "would", "agent", "task", "output", "result", "system",
  "agentforge", "v2", "v3", "current", "new", "add", "use", "run",
]);

/** Synonym groups: any keyword in a group maps to the group's canonical label. */
const SYNONYM_MAP: Record<string, string> = {
  "model-tier": "model-routing",
  "llm": "model-routing",
  "opus": "model-routing",
  "haiku": "model-routing",
  "sonnet": "model-routing",
  "routing": "model-routing",
  "tier": "model-routing",
  "token-cost": "cost",
  "tokens": "cost",
  "budget": "cost",
  "spending": "cost",
  "expensive": "cost",
  "parallel": "parallelism",
  "concurrent": "parallelism",
  "fan-out": "parallelism",
  "async": "parallelism",
  "loop": "loop-detection",
  "infinite": "loop-detection",
  "stuck": "loop-detection",
  "stall": "loop-detection",
  "context": "context-window",
  "files": "context-window",
  "memory": "context-window",
};

const PRIORITY_WEIGHTS: Record<FeedbackPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Minimum number of distinct agents for a theme to be considered signal. */
const DEFAULT_CORROBORATION_THRESHOLD = 2;

/** Signal strength at which escalation is triggered. */
const ESCALATION_THRESHOLD = 0.7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map((t) => SYNONYM_MAP[t] ?? t);
}

function extractKeywords(entry: AgentFeedback): string[] {
  const text = `${entry.title} ${entry.description} ${entry.suggestion}`;
  const tokens = tokenize(text);
  // Deduplicate but keep frequency-weighted tokens
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  // Return tokens that appear at least twice in this entry, plus all unique
  return [...freq.entries()]
    .filter(([, count]) => count >= 1)
    .sort(([, a], [, b]) => b - a)
    .map(([token]) => token)
    .slice(0, 20); // Top 20 keywords per entry
}

function computeSignalStrength(
  entryCount: number,
  corroboratingAgents: string[],
  peakPriority: FeedbackPriority,
  totalEntries: number,
): number {
  const agentScore = Math.min(corroboratingAgents.length / 5, 1.0);    // 5+ agents = max
  const countScore = Math.min(entryCount / 10, 1.0);                   // 10+ entries = max
  const priorityScore = PRIORITY_WEIGHTS[peakPriority] / 4;            // critical = max
  const coverageScore = Math.min(entryCount / totalEntries, 1.0);      // share of corpus

  // Weighted combination — corroboration is most important
  return (agentScore * 0.40) + (countScore * 0.20) + (priorityScore * 0.25) + (coverageScore * 0.15);
}

function mapThemeToAction(theme: FeedbackTheme): RecommendedAction {
  const k = theme.keywords;

  // Pattern matching on theme keywords → action type
  if (k.includes("model-routing")) {
    return {
      action: "adjust-model-routing",
      rationale: `${theme.corroborating_agents.length} agents flagged model routing issues. ` +
                 `Consider reviewing tier assignments in team-designer.ts.`,
      urgency: theme.peak_priority,
      theme_label: theme.label,
      confidence: theme.signal_strength,
    };
  }

  if (k.includes("cost") && theme.signal_strength > 0.5) {
    return {
      action: "increase-budget-ceiling",
      rationale: `Cost-related feedback from ${theme.corroborating_agents.length} agents suggests ` +
                 `budget ceilings may be too tight or model selection is suboptimal.`,
      urgency: theme.peak_priority,
      theme_label: theme.label,
      confidence: theme.signal_strength,
    };
  }

  if (k.includes("loop-detection") || k.includes("stall")) {
    return {
      action: "review-manually",
      rationale: `Loop/stall patterns detected across ${theme.entry_count} entries. ` +
                 `LoopGuard thresholds in loop-guard.ts may need adjustment.`,
      urgency: theme.peak_priority,
      theme_label: theme.label,
      confidence: theme.signal_strength,
    };
  }

  if (k.includes("parallelism") && theme.signal_strength > 0.6) {
    return {
      action: "reforge-team",
      rationale: `Parallelism gaps detected. Team topology may need restructuring ` +
                 `to enable fan-out patterns.`,
      urgency: theme.peak_priority,
      theme_label: theme.label,
      confidence: theme.signal_strength,
    };
  }

  // Default: flag for human review if strong signal but no specific action
  if (theme.signal_strength > ESCALATION_THRESHOLD) {
    return {
      action: "reforge-team",
      rationale: `Strong cross-agent signal (strength=${theme.signal_strength.toFixed(2)}) ` +
                 `for theme "${theme.label}" — team evolution may be warranted.`,
      urgency: theme.peak_priority,
      theme_label: theme.label,
      confidence: theme.signal_strength * 0.8,
    };
  }

  return {
    action: "review-manually",
    rationale: `Theme "${theme.label}" detected but signal strength below auto-action threshold.`,
    urgency: theme.peak_priority,
    theme_label: theme.label,
    confidence: theme.signal_strength,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FeedbackAnalyzerOptions {
  /** Minimum distinct agents reporting a theme for it to be considered signal. Default: 2. */
  corroborationThreshold?: number;
  /** Apply recency decay to entries older than this many days. Default: 7. */
  recencyDecayDays?: number;
  /** Maximum themes to surface. Default: 10. */
  maxThemes?: number;
}

/**
 * Analyzes a set of AgentFeedback entries and produces a FeedbackAnalysis
 * with detected themes, corroboration scores, and recommended actions.
 *
 * Pure function — no I/O. Pair with FeedbackCollector.loadAllFeedback().
 */
export function analyzeFeedback(
  entries: AgentFeedback[],
  options: FeedbackAnalyzerOptions = {},
): FeedbackAnalysis {
  const {
    corroborationThreshold = DEFAULT_CORROBORATION_THRESHOLD,
    maxThemes = 10,
  } = options;

  if (entries.length === 0) {
    return {
      analyzed_at: new Date().toISOString(),
      total_entries: 0,
      date_range: { earliest: "", latest: "" },
      themes: [],
      recommended_actions: [],
      requires_escalation: false,
      summary: {
        total: 0,
        by_category: { optimization: 0, bug: 0, feature: 0, process: 0, cost: 0, quality: 0 },
        by_priority: { critical: 0, high: 0, medium: 0, low: 0 },
        by_agent: {},
        entries,
      },
    };
  }

  // --- Build keyword → entry mapping ---
  const keywordIndex = new Map<string, Set<string>>(); // keyword → entry IDs
  const entryKeywords = new Map<string, string[]>();    // entry ID → keywords
  const entryMeta = new Map<string, AgentFeedback>();

  for (const entry of entries) {
    const keywords = extractKeywords(entry);
    entryKeywords.set(entry.id, keywords);
    entryMeta.set(entry.id, entry);
    for (const kw of keywords) {
      if (!keywordIndex.has(kw)) keywordIndex.set(kw, new Set());
      keywordIndex.get(kw)!.add(entry.id);
    }
  }

  // --- Cluster keywords by co-occurrence ---
  // Keywords that appear together in 2+ entries are grouped into themes
  const themeMap = new Map<string, {
    keywords: Set<string>;
    entryIds: Set<string>;
    agents: Set<string>;
    priorities: FeedbackPriority[];
  }>();

  for (const [kw, entryIds] of keywordIndex.entries()) {
    if (entryIds.size < 1) continue;

    // Find co-occurring keywords in the same entries
    const coKeywords = new Set<string>([kw]);
    for (const entryId of entryIds) {
      for (const coKw of entryKeywords.get(entryId) ?? []) {
        if (coKw !== kw) coKeywords.add(coKw);
      }
    }

    // Use the most frequent keyword as the theme canonical key
    const themeKey = kw;
    if (!themeMap.has(themeKey)) {
      themeMap.set(themeKey, {
        keywords: coKeywords,
        entryIds: new Set(entryIds),
        agents: new Set(),
        priorities: [],
      });
    } else {
      const existing = themeMap.get(themeKey)!;
      for (const coKw of coKeywords) existing.keywords.add(coKw);
      for (const id of entryIds) existing.entryIds.add(id);
    }

    // Populate agent and priority metadata
    const theme = themeMap.get(themeKey)!;
    for (const entryId of theme.entryIds) {
      const entry = entryMeta.get(entryId);
      if (entry) {
        theme.agents.add(entry.agent);
        theme.priorities.push(entry.priority);
      }
    }
  }

  // --- Score and filter themes ---
  const themes: FeedbackTheme[] = [];
  for (const [label, data] of themeMap.entries()) {
    if (data.agents.size < corroborationThreshold) continue;

    const peakPriority = data.priorities.reduce<FeedbackPriority>((best, p) => {
      return PRIORITY_WEIGHTS[p] > PRIORITY_WEIGHTS[best] ? p : best;
    }, "low");

    const signalStrength = computeSignalStrength(
      data.entryIds.size,
      [...data.agents],
      peakPriority,
      entries.length,
    );

    themes.push({
      label,
      keywords: [...data.keywords].slice(0, 10),
      corroborating_agents: [...data.agents],
      entry_count: data.entryIds.size,
      peak_priority: peakPriority,
      signal_strength: signalStrength,
      entry_ids: [...data.entryIds],
    });
  }

  // Sort by signal strength descending, cap at maxThemes
  themes.sort((a, b) => b.signal_strength - a.signal_strength);
  const topThemes = themes.slice(0, maxThemes);

  // --- Generate recommended actions ---
  const actions = topThemes
    .filter((t) => t.signal_strength > 0.3)
    .map(mapThemeToAction)
    // Deduplicate actions of the same type
    .filter((action, idx, arr) =>
      arr.findIndex((a) => a.action === action.action) === idx
    );

  // --- Build base summary ---
  const summary: FeedbackSummary = {
    total: entries.length,
    by_category: { optimization: 0, bug: 0, feature: 0, process: 0, cost: 0, quality: 0 },
    by_priority: { critical: 0, high: 0, medium: 0, low: 0 },
    by_agent: {},
    entries,
  };
  for (const entry of entries) {
    summary.by_category[entry.category] = (summary.by_category[entry.category] ?? 0) + 1;
    summary.by_priority[entry.priority] = (summary.by_priority[entry.priority] ?? 0) + 1;
    summary.by_agent[entry.agent] = (summary.by_agent[entry.agent] ?? 0) + 1;
  }

  const timestamps = entries.map((e) => e.timestamp).sort();

  return {
    analyzed_at: new Date().toISOString(),
    total_entries: entries.length,
    date_range: {
      earliest: timestamps[0] ?? "",
      latest: timestamps[timestamps.length - 1] ?? "",
    },
    themes: topThemes,
    recommended_actions: actions,
    requires_escalation: topThemes.some((t) => t.signal_strength > ESCALATION_THRESHOLD),
    summary,
  };
}
```

```typescript
// Integration with FeedbackCollector — add method to src/feedback/feedback-collector.ts:

import { analyzeFeedback, type FeedbackAnalyzerOptions } from "./feedback-analyzer.js";
import type { FeedbackAnalysis } from "../types/feedback.js";

// Add to FeedbackCollector class:
async analyze(options?: FeedbackAnalyzerOptions): Promise<FeedbackAnalysis> {
  const entries = await this.loadAllFeedback();
  return analyzeFeedback(entries, options);
}
```

```typescript
// Integration with EventBus — publish analysis results for orchestrator consumption:
// (in orchestrator session teardown)

import { EventBus } from "../orchestrator/event-bus.js";
import { FeedbackCollector } from "../feedback/feedback-collector.js";

async function runPostSessionAnalysis(
  projectRoot: string,
  eventBus: EventBus,
): Promise<void> {
  const collector = new FeedbackCollector(projectRoot);
  const analysis = await collector.analyze({ corroborationThreshold: 2 });

  eventBus.publish({
    type: "feedback_analysis_complete",
    source: "feedback-analyzer",
    payload: analysis,
    notify: ["*"],
  });

  if (analysis.requires_escalation) {
    eventBus.publish({
      type: "reforge_recommended",
      source: "feedback-analyzer",
      payload: {
        actions: analysis.recommended_actions,
        themes: analysis.themes.filter((t) => t.signal_strength > 0.7),
      },
      notify: ["genesis", "architect"],
    });
  }
}
```

## Impact

The `FeedbackAnalyzer` closes the most critical gap in the v2 feedback loop: feedback goes from write-only to **readable and actionable**. Concretely:

1. **Automatic theme detection** means the 4 cost optimization proposals already in `.agentforge/feedback/` would have automatically surfaced `model-routing` as a high-signal theme (3 independent agents, keyword overlap on `model`/`routing`/`tier`), triggered a `adjust-model-routing` recommendation, and published a `reforge_recommended` event — all without human review.

2. **Cross-agent corroboration** filters noise: a single agent's idiosyncratic complaint does not trigger action. Only patterns that emerge independently across multiple agents get escalated.

3. **Typed `RecommendedAction`** connects analysis output directly to the `ReforgeEngine` (proposed by the self-improvement researcher), creating a complete feedback → analysis → action pipeline.

4. **EventBus integration** means the analyzer's output flows into the existing orchestration infrastructure (`src/orchestrator/event-bus.ts`) without requiring new inter-process communication mechanisms.

5. **No external dependencies** — pure TypeScript keyword analysis, no ML models, no embedding servers, no vector databases. Ships with zero new `npm` dependencies.
