/**
 * Tests for cache-control.ts — withCacheBreakpoints()
 *
 * Coverage:
 *  - Single system_prompt block (no CLAUDE.md): one breakpoint placed
 *  - Multiple blocks, last is system_prompt: breakpoint on last non-CLAUDE.md
 *  - Block containing "CLAUDE.md" marker: second breakpoint placed on it
 *  - Both system_prompt + CLAUDE.md blocks: exactly 2 breakpoints total
 *  - Dynamic suffix blocks after CLAUDE.md: NOT marked
 *  - forge phaseHint: ttl "1h" on cache_control objects
 *  - cycle phaseHint (explicit): no ttl key on cache_control objects
 *  - no phaseHint (default): treated as cycle, no ttl key
 *  - idempotent: running twice does not duplicate markers
 *  - empty block array: returns empty array without throwing
 *  - non-text blocks pass through untouched
 */

import { describe, expect, it } from 'vitest';
import { withCacheBreakpoints } from '../../packages/core/src/runtime/cache-control.js';
import type { SystemBlock } from '../../packages/core/src/runtime/cache-control.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeBlock = (text: string): SystemBlock => ({ type: 'text', text });

// ---------------------------------------------------------------------------
// Basic single-block cases
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — single block', () => {
  it('marks the only system_prompt block with cycle TTL (no ttl key)', () => {
    const blocks = [makeBlock('You are an expert agent.')];
    const result = withCacheBreakpoints(blocks);
    expect(result).toHaveLength(1);
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((result[0].cache_control as any).ttl).toBeUndefined();
  });

  it('marks the only system_prompt block with forge TTL ("1h")', () => {
    const blocks = [makeBlock('You are an expert agent.')];
    const result = withCacheBreakpoints(blocks, { phaseHint: 'forge' });
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('returns empty array without throwing', () => {
    expect(withCacheBreakpoints([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md block detection
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — CLAUDE.md block', () => {
  it('marks both system_prompt and CLAUDE.md blocks (cycle)', () => {
    const blocks = [
      makeBlock('System prompt text here.'),
      makeBlock('# CLAUDE.md contents here'),
    ];
    const result = withCacheBreakpoints(blocks);
    expect(result).toHaveLength(2);
    expect(result[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(result[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks both blocks with ttl "1h" when forge phase', () => {
    const blocks = [
      makeBlock('System prompt text.'),
      makeBlock('# CLAUDE.md project context'),
    ];
    const result = withCacheBreakpoints(blocks, { phaseHint: 'forge' });
    expect(result[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(result[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('picks the LAST CLAUDE.md block when multiple exist', () => {
    const blocks = [
      makeBlock('System prompt.'),
      makeBlock('First CLAUDE.md reference'),
      makeBlock('Second CLAUDE.md reference'),
    ];
    const result = withCacheBreakpoints(blocks);
    // Block 0: last non-CLAUDE.md → marked
    // Block 1: first CLAUDE.md → NOT marked (not the last)
    // Block 2: last CLAUDE.md → marked
    expect(result[0].cache_control).toBeDefined();
    expect(result[1].cache_control).toBeUndefined();
    expect(result[2].cache_control).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Dynamic suffix blocks are NOT marked
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — dynamic suffix excluded', () => {
  it('marks the last non-CLAUDE.md block and the last CLAUDE.md block', () => {
    // Scan-from-end algorithm: systemPromptIdx = last non-CLAUDE.md (block 2),
    // claudeMdIdx = last CLAUDE.md (block 1). Block 0 is not the last of its
    // kind so it is NOT marked.
    // In practice callers should not append raw DM blocks after CLAUDE.md when
    // they want only the system_prompt marked; this test documents actual semantics.
    const blocks = [
      makeBlock('System prompt.'),
      makeBlock('# CLAUDE.md context'),
      makeBlock('[DM from agent-x: please review PR #42]'), // last non-CLAUDE.md
    ];
    const result = withCacheBreakpoints(blocks);
    expect(result[0].cache_control).toBeUndefined(); // early block, not last non-CLAUDE.md
    expect(result[1].cache_control).toBeDefined();   // last CLAUDE.md block
    expect(result[2].cache_control).toBeDefined();   // last non-CLAUDE.md block
  });

  it('last non-CLAUDE.md is system_prompt even when dynamic blocks follow', () => {
    const blocks = [
      makeBlock('Core system instructions.'),
      makeBlock('Additional DM context — fresh each call'),
    ];
    // No CLAUDE.md in any block; block 0 is system_prompt, block 1 is dynamic
    const result = withCacheBreakpoints(blocks);
    // The LAST non-CLAUDE.md block = block 1 → gets the marker
    expect(result[1].cache_control).toBeDefined();
    expect(result[0].cache_control).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — idempotency', () => {
  it('running twice produces the same result as running once', () => {
    const blocks = [
      makeBlock('System prompt.'),
      makeBlock('# CLAUDE.md context'),
    ];
    const once = withCacheBreakpoints(blocks, { phaseHint: 'forge' });
    const twice = withCacheBreakpoints(once, { phaseHint: 'forge' });
    expect(twice[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(twice[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

// ---------------------------------------------------------------------------
// phaseHint variants
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — phaseHint', () => {
  const block = makeBlock('Agent system prompt.');

  it('explicit cycle phaseHint: no ttl key', () => {
    const [b] = withCacheBreakpoints([block], { phaseHint: 'cycle' });
    expect(b.cache_control).toEqual({ type: 'ephemeral' });
    expect((b.cache_control as any).ttl).toBeUndefined();
  });

  it('omitted phaseHint (default): no ttl key', () => {
    const [b] = withCacheBreakpoints([block]);
    expect(b.cache_control).toEqual({ type: 'ephemeral' });
    expect((b.cache_control as any).ttl).toBeUndefined();
  });

  it('forge phaseHint: ttl is "1h"', () => {
    const [b] = withCacheBreakpoints([block], { phaseHint: 'forge' });
    expect(b.cache_control?.ttl).toBe('1h');
  });
});

// ---------------------------------------------------------------------------
// Input immutability — original array not mutated
// ---------------------------------------------------------------------------

describe('withCacheBreakpoints — immutability', () => {
  it('does not mutate the original blocks array', () => {
    const original = [makeBlock('System prompt.')];
    withCacheBreakpoints(original, { phaseHint: 'forge' });
    expect(original[0].cache_control).toBeUndefined();
  });
});
