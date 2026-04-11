/**
 * ExecutePhaseHandler — Sprint Execute Phase Memory Injector
 *
 * Called before each sprint item is dispatched to its agent.
 * Queries the MemoryRegistry for entries whose tags overlap with the
 * sprint item's tags, then formats them as a "Memory: Past failures on
 * similar work" section for prompt injection.
 *
 * This closes the learning loop for the execute phase: ReviewPhaseHandler
 * writes findings and GatePhaseHandler writes verdicts; ExecutePhaseHandler
 * reads both back at execute time so agents avoid repeating past mistakes
 * on similar work.
 *
 * Pure projection — no writes, no side effects beyond MemoryRegistry
 * access-timestamp updates on each entry read.
 */

import type { MemoryRegistry } from "../registry/memory-registry.js";
import type { MemoryRegistryEntry } from "../types/v4-api.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Output of buildMemorySection. */
export interface ExecutePhaseMemorySection {
  /** The formatted Markdown section to prepend to the agent prompt. */
  section: string;
  /** Number of memory entries matched and surfaced. */
  matchedCount: number;
  /** The item tags used for the lookup. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum number of past memory entries to surface per item. */
const DEFAULT_ENTRY_LIMIT = 5;

// ---------------------------------------------------------------------------
// ExecutePhaseHandler
// ---------------------------------------------------------------------------

export class ExecutePhaseHandler {
  constructor(private readonly registry: MemoryRegistry) {}

  /**
   * Build a "Memory: Past failures on similar work" section for a sprint item.
   *
   * Finds MemoryRegistry entries whose tags overlap with `itemTags` (OR match),
   * sorted by descending relevanceScore so the most severe/recent findings
   * rank highest (CRITICAL at 0.95 before MAJOR at 0.85).
   *
   * Returns an empty section string when no matching entries exist so callers
   * can safely prepend the result without a null check.
   *
   * @param itemTags - Tags from the sprint item (e.g. ["memory", "execute"]).
   * @param limit    - Maximum number of entries to surface (default: 5).
   */
  buildMemorySection(itemTags: string[], limit = DEFAULT_ENTRY_LIMIT): ExecutePhaseMemorySection {
    if (itemTags.length === 0) {
      return { section: "", matchedCount: 0, tags: [] };
    }

    const matched = this.registry
      .searchByTags(itemTags)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    if (matched.length === 0) {
      return { section: "", matchedCount: 0, tags: itemTags };
    }

    const lines: string[] = [
      "## Memory: Past Failures on Similar Work",
      "",
      "The following entries from prior cycles matched this item's tags.",
      "Use them to avoid repeating past mistakes.",
      "",
    ];

    for (const entry of matched) {
      const label = formatCategoryLabel(entry);
      lines.push(`- **[${label}]** ${entry.summary}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");

    return {
      section: lines.join("\n"),
      matchedCount: matched.length,
      tags: itemTags,
    };
  }

  /**
   * Inject relevant past memory into an agent task prompt.
   *
   * When matching memory entries exist, prepends the formatted section to
   * the prompt so the agent has immediate context about past failures on
   * similar work. When no entries match, the original prompt is returned
   * unchanged.
   *
   * @param prompt   - The agent's original task prompt.
   * @param itemTags - Tags from the sprint item to match against memory.
   * @param limit    - Maximum number of entries to surface (default: 5).
   */
  injectMemoryIntoPrompt(
    prompt: string,
    itemTags: string[],
    limit = DEFAULT_ENTRY_LIMIT,
  ): string {
    const { section } = this.buildMemorySection(itemTags, limit);
    if (!section) return prompt;
    return `${section}${prompt}`;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Format a memory entry's category as a display label for the injected section.
 *
 * Maps internal category strings (e.g. "review-finding") to their canonical
 * display form (e.g. "review-finding") so the injected section is readable
 * without further parsing.
 */
function formatCategoryLabel(entry: MemoryRegistryEntry): string {
  // Use the entry category directly — it already reads well (e.g. "review-finding",
  // "gate-verdict") and matches the tag vocabulary agents already know.
  return entry.category;
}
