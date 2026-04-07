// tests/autonomous/fixtures/mock-anthropic.ts
//
// Test fixture that implements the `RuntimeForScoring` shape used by the
// autonomous cycle's ScoringPipeline. Instead of making real Anthropic API
// calls it replays canned JSON responses keyed by agentId, so integration
// tests can exercise the full CycleRunner without spending a dime.
//
// Usage:
//   const runtime = createMockRuntime({
//     responseBank: {
//       'backlog-scorer': JSON.stringify({ rankings: [...], ... }),
//     },
//   });
//   runtime.callsFor('backlog-scorer') // → number of invocations
//
// See tests/autonomous/integration/full-cycle.test.ts (Task 24) for the
// primary consumer and docs/superpowers/plans/2026-04-06-autonomous-loop-part2.md
// §Task 24 for the plan that drove this fixture.

export interface MockRuntimeCall {
  agentId: string;
  task: string;
}

export interface MockRuntimeOptions {
  /**
   * Map of agentId → canned JSON response string. When the scoring pipeline
   * (or any other code path under test) calls `runtime.run(agentId, ...)`,
   * the matching entry is returned as the `output` field of the run result.
   * Missing keys default to `'{}'` so the pipeline fails loudly on a
   * schema-validation error rather than hanging.
   */
  responseBank: Record<string, string>;
}

export interface MockRunResult {
  output: string;
  usage: { input_tokens: number; output_tokens: number };
  costUsd: number;
  durationMs: number;
  model: string;
}

export interface MockRuntime {
  /** Every call made to `run()`, in order, for assertion-friendly inspection. */
  calls: MockRuntimeCall[];
  /**
   * Drop-in replacement for `RuntimeForScoring.run`. Records the call and
   * returns a canned `{ output, usage, costUsd, durationMs, model }` result.
   */
  run: (
    agentId: string,
    task: string,
    options?: { responseFormat?: string },
  ) => Promise<MockRunResult>;
  /**
   * Helper for tests: count how many times any of the given agent ids were
   * invoked. Variadic so callers can do `runtime.callsFor('backlog-scorer')`
   * or `runtime.callsFor('coder', 'reviewer')` without boilerplate.
   */
  callsFor: (...agentIds: string[]) => number;
}

/**
 * Build a mock runtime that satisfies the `RuntimeForScoring` contract used
 * by the autonomous cycle. The returned object is intentionally plain (no
 * class) so tests can spy on `calls` directly without wrestling with private
 * state, and so it composes cleanly with `as any` at the call site when the
 * full `AgentRuntime` surface is not needed.
 */
export function createMockRuntime(opts: MockRuntimeOptions): MockRuntime {
  const calls: MockRuntimeCall[] = [];

  return {
    calls,
    run: async (agentId: string, task: string, _options?: { responseFormat?: string }) => {
      calls.push({ agentId, task });
      const response = opts.responseBank[agentId] ?? '{}';
      return {
        output: response,
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.01,
        durationMs: 200,
        model: 'claude-sonnet-4-6-mock',
      };
    },
    callsFor: (...agentIds: string[]) =>
      calls.filter((c) => agentIds.includes(c.agentId)).length,
  };
}
