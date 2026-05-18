/**
 * cache-control.ts — Pure utility for injecting Anthropic prompt-cache breakpoints
 * into a system block.
 *
 * Rules (per T2 spec):
 *  - At most 2 breakpoints are placed, covering the two trailing "stable" segments:
 *      1. The trailing system_prompt text segment.
 *      2. The trailing CLAUDE.md segment if one was injected.
 *  - Forge-phase invocations use `ttl: "1h"` (long-lived, rarely changes).
 *  - Cycle-phase invocations use `ttl: "5m"` (Anthropic default ephemeral).
 *  - Dynamic suffixes (DMs, fresh-context injections) are NEVER cache-marked.
 *  - MAX 4 breakpoints per request (Anthropic limit); this utility uses at most 2.
 *
 * The TTL field shape Anthropic expects:
 *   { type: "ephemeral", ttl: "1h" | "5m" }
 *
 * When `ttl` is `"5m"` (the API default) it is omitted from the emitted block to
 * keep the wire format minimal and avoid unexpected rejections on API versions that
 * do not yet accept the `ttl` key.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single content block in the Anthropic `system` array. */
export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' };
}

/**
 * Options for `withCacheBreakpoints`.
 *
 * @param phaseHint - `'forge'` uses a 1-hour TTL; `'cycle'` (default) uses the
 *                    Anthropic ephemeral default (5 min, TTL key omitted).
 */
export interface CacheBreakpointOpts {
  phaseHint?: 'forge' | 'cycle';
}

// ---------------------------------------------------------------------------
// Markers used to identify stable segments
// ---------------------------------------------------------------------------

/**
 * These substring markers identify the two cache-eligible segment types.
 * Matching uses `String.includes()` — never regex on potentially user-supplied
 * text (avoids CodeQL js/redos).
 */
const CLAUDE_MD_MARKER = 'CLAUDE.md';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inject `cache_control` markers into a system block array.
 *
 * Scans `blocks` from the end and marks:
 *   1. The last block whose `.text` does NOT contain the CLAUDE.md marker
 *      (treated as the trailing system_prompt segment).
 *   2. The last block whose `.text` contains the CLAUDE.md marker.
 *
 * Any existing `cache_control` on blocks is preserved unless the block is
 * explicitly targeted, keeping the function idempotent.
 *
 * @param blocks   Ordered system content blocks (text only; other types pass through).
 * @param opts     `phaseHint` controls TTL: `'forge'` → 1 h, `'cycle'` → omit TTL.
 * @returns        A new array of blocks (shallow copy; targeted blocks are new objects).
 */
export function withCacheBreakpoints(
  blocks: SystemBlock[],
  opts: CacheBreakpointOpts = {},
): SystemBlock[] {
  const useLongTtl = opts.phaseHint === 'forge';

  /** Build the cache_control object for this invocation context. */
  const makeCacheControl = (): { type: 'ephemeral'; ttl?: '1h' } =>
    useLongTtl ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

  // --- Find target indices (last matching block of each kind) ----------------

  let systemPromptIdx = -1; // last block that is NOT a CLAUDE.md block
  let claudeMdIdx = -1;     // last block that IS a CLAUDE.md block

  for (let i = blocks.length - 1; i >= 0; i--) {
    const block: SystemBlock | undefined = blocks[i];
    if (block === undefined || block.type !== 'text') continue;

    if (block.text.includes(CLAUDE_MD_MARKER)) {
      if (claudeMdIdx === -1) claudeMdIdx = i;
    } else {
      if (systemPromptIdx === -1) systemPromptIdx = i;
    }

    // Stop early once both candidates found.
    if (systemPromptIdx !== -1 && claudeMdIdx !== -1) break;
  }

  // --- Build output array (shallow copy; patch targeted indices) -------------

  return blocks.map((block, idx): SystemBlock => {
    const isTarget = idx === systemPromptIdx || idx === claudeMdIdx;
    if (!isTarget) return block;
    return { ...block, cache_control: makeCacheControl() };
  });
}
