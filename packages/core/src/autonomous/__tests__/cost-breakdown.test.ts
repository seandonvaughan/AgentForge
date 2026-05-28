// packages/core/src/autonomous/__tests__/cost-breakdown.test.ts
//
// Unit tests for the CostBreakdown type contract and pure functions.
// Wave 1 scope: shape correctness, merge math, pricing accuracy.
// Wire-up to CycleRunner is Wave 2.

import { describe, expect, it } from 'vitest';
import {
  extractBreakdownFromAgentRun,
  mergeBreakdowns,
  type CostBreakdown,
  type AgentRun,
} from '../cost-breakdown.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    model: 'claude-sonnet-4-6',
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    inputTokens:   { count: 0, usd: 0 },
    outputTokens:  { count: 0, usd: 0 },
    cacheCreation: { tokens: 0, usd: 0 },
    cacheRead:     { tokens: 0, usd: 0 },
    toolUse: {},
    totalUsd: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CostBreakdown shape
// ---------------------------------------------------------------------------

describe('CostBreakdown shape', () => {
  it('extractBreakdownFromAgentRun returns all required fields', () => {
    const bd = extractBreakdownFromAgentRun(makeRun());

    expect(bd).toHaveProperty('inputTokens');
    expect(bd).toHaveProperty('outputTokens');
    expect(bd).toHaveProperty('cacheCreation');
    expect(bd).toHaveProperty('cacheRead');
    expect(bd).toHaveProperty('toolUse');
    expect(bd).toHaveProperty('totalUsd');

    expect(typeof bd.inputTokens.count).toBe('number');
    expect(typeof bd.inputTokens.usd).toBe('number');
    expect(typeof bd.outputTokens.count).toBe('number');
    expect(typeof bd.outputTokens.usd).toBe('number');
    expect(typeof bd.cacheCreation.tokens).toBe('number');
    expect(typeof bd.cacheCreation.usd).toBe('number');
    expect(typeof bd.cacheRead.tokens).toBe('number');
    expect(typeof bd.cacheRead.usd).toBe('number');
    expect(typeof bd.totalUsd).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// extractBreakdownFromAgentRun — pricing
// ---------------------------------------------------------------------------

describe('extractBreakdownFromAgentRun', () => {
  it('prices sonnet correctly (no cache tokens)', () => {
    // Sonnet: $3/M input, $15/M output
    const run = makeRun({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.inputTokens.count).toBe(1_000_000);
    expect(bd.inputTokens.usd).toBeCloseTo(3.00, 6);
    expect(bd.outputTokens.count).toBe(1_000_000);
    expect(bd.outputTokens.usd).toBeCloseTo(15.00, 6);
    expect(bd.cacheCreation.usd).toBe(0);
    expect(bd.cacheRead.usd).toBe(0);
    expect(bd.totalUsd).toBeCloseTo(18.00, 6);
  });

  it('prices opus correctly', () => {
    // Opus: $15/M input, $75/M output
    const run = makeRun({
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.inputTokens.usd).toBeCloseTo(15.00, 6);
    expect(bd.outputTokens.usd).toBeCloseTo(75.00, 6);
    expect(bd.totalUsd).toBeCloseTo(90.00, 6);
  });

  it('prices haiku correctly', () => {
    // Haiku: $0.80/M input, $4/M output
    const run = makeRun({
      model: 'claude-haiku-4-5-20251001',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.inputTokens.usd).toBeCloseTo(0.80, 6);
    expect(bd.outputTokens.usd).toBeCloseTo(4.00, 6);
    expect(bd.totalUsd).toBeCloseTo(4.80, 6);
  });

  it('applies cache-creation pricing at 125% of normal input rate', () => {
    // Sonnet input rate: $3/M
    // cache-creation pricing: 3 * 1.25 = $3.75/M
    const run = makeRun({
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 0,
      },
    });
    const bd = extractBreakdownFromAgentRun(run);

    // cache_creation_tokens are subtracted from regularInput
    expect(bd.inputTokens.count).toBe(0);
    expect(bd.inputTokens.usd).toBe(0);
    expect(bd.cacheCreation.tokens).toBe(1_000_000);
    expect(bd.cacheCreation.usd).toBeCloseTo(3.75, 6);
    expect(bd.totalUsd).toBeCloseTo(3.75, 6);
  });

  it('applies cache-read pricing at 10% of normal input rate', () => {
    // Sonnet input rate: $3/M
    // cache-read pricing: 3 * 0.10 = $0.30/M
    const run = makeRun({
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1_000_000,
      },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.inputTokens.count).toBe(0);
    expect(bd.cacheRead.tokens).toBe(1_000_000);
    expect(bd.cacheRead.usd).toBeCloseTo(0.30, 6);
    expect(bd.totalUsd).toBeCloseTo(0.30, 6);
  });

  it('resolves short tier alias "sonnet" as the sonnet tier', () => {
    const run = makeRun({
      model: 'sonnet',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.inputTokens.usd).toBeCloseTo(3.00, 6);
  });

  it('falls back to sonnet pricing for an unrecognised model string', () => {
    const run = makeRun({
      model: 'claude-future-model-9-99',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const bd = extractBreakdownFromAgentRun(run);
    // Falls back to sonnet ($3/M input)
    expect(bd.inputTokens.usd).toBeCloseTo(3.00, 6);
  });

  it('uses capabilityTier before inferring from provider model id', () => {
    const run = makeRun({
      model: 'gpt-5.3-codex',
      capabilityTier: 'opus',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.inputTokens.usd).toBeCloseTo(15.00, 6);
  });

  it('includes toolInvocations in the toolUse map', () => {
    const run = makeRun({
      toolInvocations: {
        Bash:  { invocations: 10, usd: 0.05 },
        Write: { invocations: 3,  usd: 0.01 },
      },
    });
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.toolUse['Bash']).toEqual({ invocations: 10, usd: 0.05 });
    expect(bd.toolUse['Write']).toEqual({ invocations: 3,  usd: 0.01 });
    // Tool costs flow into totalUsd
    expect(bd.totalUsd).toBeGreaterThan(0.05);
  });

  it('handles undefined cache token fields gracefully (zero-out)', () => {
    const run: AgentRun = {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.cacheCreation.tokens).toBe(0);
    expect(bd.cacheRead.tokens).toBe(0);
    expect(bd.cacheCreation.usd).toBe(0);
    expect(bd.cacheRead.usd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mergeBreakdowns — element-wise sum
// ---------------------------------------------------------------------------

describe('mergeBreakdowns', () => {
  it('sums inputTokens count and usd element-wise', () => {
    const a = makeBreakdown({ inputTokens: { count: 100, usd: 0.0003 } });
    const b = makeBreakdown({ inputTokens: { count: 200, usd: 0.0006 } });
    const merged = mergeBreakdowns(a, b);
    expect(merged.inputTokens.count).toBe(300);
    expect(merged.inputTokens.usd).toBeCloseTo(0.0009, 9);
  });

  it('sums outputTokens count and usd element-wise', () => {
    const a = makeBreakdown({ outputTokens: { count: 50, usd: 0.00075 } });
    const b = makeBreakdown({ outputTokens: { count: 10, usd: 0.00015 } });
    const merged = mergeBreakdowns(a, b);
    expect(merged.outputTokens.count).toBe(60);
    expect(merged.outputTokens.usd).toBeCloseTo(0.0009, 9);
  });

  it('sums cacheCreation tokens and usd', () => {
    const a = makeBreakdown({ cacheCreation: { tokens: 500, usd: 0.001875 } });
    const b = makeBreakdown({ cacheCreation: { tokens: 100, usd: 0.000375 } });
    const merged = mergeBreakdowns(a, b);
    expect(merged.cacheCreation.tokens).toBe(600);
    expect(merged.cacheCreation.usd).toBeCloseTo(0.00225, 9);
  });

  it('sums cacheRead tokens and usd', () => {
    const a = makeBreakdown({ cacheRead: { tokens: 200, usd: 0.00006 } });
    const b = makeBreakdown({ cacheRead: { tokens: 300, usd: 0.00009 } });
    const merged = mergeBreakdowns(a, b);
    expect(merged.cacheRead.tokens).toBe(500);
    expect(merged.cacheRead.usd).toBeCloseTo(0.00015, 9);
  });

  it('sums totalUsd', () => {
    const a = makeBreakdown({ totalUsd: 1.23 });
    const b = makeBreakdown({ totalUsd: 4.56 });
    expect(mergeBreakdowns(a, b).totalUsd).toBeCloseTo(5.79, 6);
  });

  it('merges toolUse maps by key, summing invocations and usd', () => {
    const a = makeBreakdown({
      toolUse: { Bash: { invocations: 5, usd: 0.01 } },
    });
    const b = makeBreakdown({
      toolUse: { Bash: { invocations: 3, usd: 0.006 }, Read: { invocations: 2, usd: 0.002 } },
    });
    const merged = mergeBreakdowns(a, b);
    expect(merged.toolUse['Bash']).toEqual({ invocations: 8, usd: 0.016 });
    expect(merged.toolUse['Read']).toEqual({ invocations: 2, usd: 0.002 });
  });

  it('handles toolUse keys present in only one operand', () => {
    const a = makeBreakdown({ toolUse: { Write: { invocations: 1, usd: 0.001 } } });
    const b = makeBreakdown({ toolUse: {} });
    const merged = mergeBreakdowns(a, b);
    expect(merged.toolUse['Write']).toEqual({ invocations: 1, usd: 0.001 });
  });

  it('is commutative for totalUsd', () => {
    const a = makeBreakdown({ totalUsd: 2.5 });
    const b = makeBreakdown({ totalUsd: 7.5 });
    expect(mergeBreakdowns(a, b).totalUsd).toBeCloseTo(mergeBreakdowns(b, a).totalUsd, 9);
  });

  it('identity: merging with a zero breakdown returns the original values', () => {
    const a = makeBreakdown({
      inputTokens:   { count: 100, usd: 0.3 },
      outputTokens:  { count: 50,  usd: 0.75 },
      cacheCreation: { tokens: 20, usd: 0.0375 },
      cacheRead:     { tokens: 10, usd: 0.003 },
      toolUse: { Bash: { invocations: 1, usd: 0.01 } },
      totalUsd: 1.0975,
    });
    const zero = makeBreakdown();
    const merged = mergeBreakdowns(a, zero);
    expect(merged.inputTokens.count).toBe(100);
    expect(merged.outputTokens.count).toBe(50);
    expect(merged.cacheCreation.tokens).toBe(20);
    expect(merged.cacheRead.tokens).toBe(10);
    expect(merged.totalUsd).toBeCloseTo(1.0975, 6);
  });
});

// ---------------------------------------------------------------------------
// Provider-keyed pricing (v7 item 3 — unify cost across Claude and Codex/OpenAI)
// ---------------------------------------------------------------------------

describe('extractBreakdownFromAgentRun — resolved provider pricing', () => {
  it('prices a codex-cli run using the OpenAI/Codex table, NOT Anthropic', () => {
    // gpt-5.3-codex: $1.75/M input, $14/M output.
    // 1M input + 1M output = 1.75 + 14.00 = 15.75.
    // The same tokens under Anthropic sonnet pricing would be 3 + 15 = 18.00.
    const run = makeRun({
      model: 'gpt-5.3-codex',
      resolvedProvider: 'codex-cli',
      resolvedModelId: 'gpt-5.3-codex',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.inputTokens.usd).toBeCloseTo(1.75, 6);
    expect(bd.outputTokens.usd).toBeCloseTo(14.0, 6);
    expect(bd.totalUsd).toBeCloseTo(15.75, 6);

    // Anti-fake guard: a breakdown that always applies Anthropic pricing would
    // report 18.00 for these tokens. Prove we did NOT.
    expect(bd.totalUsd).not.toBeCloseTo(18.0, 6);
  });

  it('prices an openai-sdk run using the OpenAI table keyed off resolvedModelId', () => {
    // gpt-5.4: $2.5/M input, $15/M output.
    const run = makeRun({
      model: 'gpt-5.4',
      resolvedProvider: 'openai-sdk',
      resolvedModelId: 'gpt-5.4',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.inputTokens.usd).toBeCloseTo(2.5, 6);
    expect(bd.outputTokens.usd).toBeCloseTo(15.0, 6);
    expect(bd.totalUsd).toBeCloseTo(17.5, 6);
  });

  it('still prices anthropic-sdk runs with the Anthropic tier table', () => {
    const run = makeRun({
      model: 'claude-sonnet-4-6',
      resolvedProvider: 'anthropic-sdk',
      resolvedModelId: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    });
    const bd = extractBreakdownFromAgentRun(run);

    expect(bd.totalUsd).toBeCloseTo(18.0, 6);
  });

  it('keys OpenAI pricing off resolvedModelId even when model says otherwise', () => {
    // resolvedModelId is the source of truth; a stale `model` must not win.
    const run = makeRun({
      model: 'claude-sonnet-4-6',
      resolvedProvider: 'codex-cli',
      resolvedModelId: 'gpt-5.3-codex',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const bd = extractBreakdownFromAgentRun(run);
    expect(bd.inputTokens.usd).toBeCloseTo(1.75, 6);
  });

  it('a cycle mixing providers sums the two DIFFERENT correct figures', () => {
    const codexRun = makeRun({
      model: 'gpt-5.3-codex',
      resolvedProvider: 'codex-cli',
      resolvedModelId: 'gpt-5.3-codex',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, // 15.75
    });
    const anthropicRun = makeRun({
      model: 'claude-sonnet-4-6',
      resolvedProvider: 'anthropic-sdk',
      resolvedModelId: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 }, // 18.00
    });

    const merged = mergeBreakdowns(
      extractBreakdownFromAgentRun(codexRun),
      extractBreakdownFromAgentRun(anthropicRun),
    );

    expect(merged.totalUsd).toBeCloseTo(33.75, 6);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: extract then merge
// ---------------------------------------------------------------------------

describe('extract + merge round-trip', () => {
  it('merging two sonnet runs produces the combined cost', () => {
    const run1 = makeRun({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    const run2 = makeRun({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 1_000_000 },
    });
    const bd = mergeBreakdowns(
      extractBreakdownFromAgentRun(run1),
      extractBreakdownFromAgentRun(run2),
    );
    expect(bd.inputTokens.usd).toBeCloseTo(3.00, 6);
    expect(bd.outputTokens.usd).toBeCloseTo(15.00, 6);
    expect(bd.totalUsd).toBeCloseTo(18.00, 6);
  });
});
