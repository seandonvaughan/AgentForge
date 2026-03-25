/**
 * FeedbackAnalyzer — Detects recurring themes in agent feedback via keyword
 * clustering and cross-agent corroboration, producing actionable recommendations.
 *
 * Pure function over feedback entries. No I/O or external dependencies.
 */

import type {
  AgentFeedback,
  FeedbackTheme,
  RecommendedAction,
  FeedbackAnalysis,
  FeedbackSummary,
  FeedbackPriority,
  FeedbackCategory,
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
  // Return tokens that appear at least once in this entry
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
 */
export class FeedbackAnalyzer {
  private corroborationThreshold: number;
  private maxThemes: number;

  constructor(options?: FeedbackAnalyzerOptions) {
    this.corroborationThreshold = options?.corroborationThreshold ?? DEFAULT_CORROBORATION_THRESHOLD;
    this.maxThemes = options?.maxThemes ?? 10;
  }

  /**
   * Analyze a set of feedback entries and produce a FeedbackAnalysis
   * with detected themes, corroboration scores, and recommended actions.
   */
  analyze(entries: AgentFeedback[]): FeedbackAnalysis {
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

      // Use the keyword as the theme canonical key
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
      if (data.agents.size < this.corroborationThreshold) continue;

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
    const topThemes = themes.slice(0, this.maxThemes);

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
}
