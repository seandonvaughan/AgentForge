// packages/core/src/agent-runtime/agent-runtime.ts
//
// v6.4.1 refactor: AgentRuntime now shells out to the `claude` CLI instead of
// calling the Anthropic SDK directly. This lets it use the logged-in Claude
// Code session (Max/Pro plan) rather than requiring ANTHROPIC_API_KEY.
//
// The constructor signature is preserved for backward compatibility. The
// optional `apiKey` parameter is accepted but ignored — `claude -p` uses the
// user's logged-in OAuth session. Callers that rely on environment-based auth
// continue to work because the subprocess inherits the parent's environment.
//
// Streaming is currently degraded: runStreaming() delegates to run() and
// invokes callbacks once at the end with the full result. Proper incremental
// streaming via --output-format stream-json is future work (see CHANGELOG).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRuntimeConfig, RunOptions, RunResult } from './types.js';
import { MODEL_PRICING, MODEL_IDS } from './types.js';
import type { WorkspaceAdapter } from '@agentforge/db';

const execFileAsync = promisify(execFile);

/** JSON shape returned by `claude -p --output-format json`. */
interface ClaudeCliResult {
  type: string;
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns?: number;
  result: string;
  stop_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  terminal_reason?: string;
}

export class AgentRuntime {
  constructor(
    private config: AgentRuntimeConfig,
    private adapter?: WorkspaceAdapter,
    // apiKey is accepted for backward compatibility but ignored — the claude
    // CLI uses the logged-in OAuth session, not a programmatic API key.
    _apiKey?: string,
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const modelId = MODEL_IDS[this.config.model] as string;

    // Build user message (with optional context)
    const userContent = opts.context
      ? `<context>\n${opts.context}\n</context>\n\n${opts.task}`
      : opts.task;

    // Persist session start — adapter generates the id and returns the row
    let sessionId: string | undefined;
    if (this.adapter) {
      const sessionRow = this.adapter.createSession({
        agentId: this.config.agentId,
        task: opts.task,
        model: modelId,
        parentSessionId: opts.parentSessionId,
      });
      sessionId = sessionRow.id;
    }

    try {
      const cliResult = await this.invokeClaudeCli(modelId, userContent);

      const completedAt = new Date().toISOString();

      if (cliResult.is_error) {
        throw new Error(
          `claude CLI reported error: subtype=${cliResult.subtype}, terminal=${cliResult.terminal_reason ?? 'unknown'}`,
        );
      }

      // Prefer the CLI's own cost calculation — it reflects actual billed
      // tokens including cache creation/read overhead. Fall back to local
      // MODEL_PRICING estimate only if the CLI omits total_cost_usd.
      const inputTokens = this.sumInputTokens(cliResult);
      const outputTokens = cliResult.usage?.output_tokens ?? 0;
      const costUsd = cliResult.total_cost_usd ?? this.estimateFromPricing(inputTokens, outputTokens);

      const result: RunResult = {
        sessionId: sessionId ?? cliResult.session_id ?? '',
        response: cliResult.result ?? '',
        model: modelId,
        inputTokens,
        outputTokens,
        costUsd,
        startedAt,
        completedAt,
        status: 'completed',
      };

      if (this.adapter && sessionId) {
        this.adapter.completeSession(sessionId, 'completed', costUsd);
        this.adapter.recordCost({
          sessionId,
          agentId: this.config.agentId,
          model: modelId,
          inputTokens,
          outputTokens,
          costUsd,
        });
      }

      return result;
    } catch (err: unknown) {
      const completedAt = new Date().toISOString();
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (this.adapter && sessionId) {
        this.adapter.completeSession(sessionId, 'failed', 0);
      }

      return {
        sessionId: sessionId ?? '',
        response: '',
        model: modelId,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt,
        completedAt,
        status: 'failed',
        error: errorMessage,
      };
    }
  }

  /**
   * Streaming method — v6.4.1 degraded implementation.
   *
   * Delegates to run() and invokes callbacks once at the end with the full
   * result. The dashboard will see "running" → "complete" without incremental
   * token deltas until proper stream-json parsing is implemented.
   */
  async runStreaming(opts: RunOptions & {
    onChunk?: (text: string, index: number) => void;
    onEvent?: (event: { type: string; data: unknown }) => void;
  }): Promise<RunResult> {
    const result = await this.run(opts);

    if (result.status === 'completed' && opts.onChunk && result.response) {
      opts.onChunk(result.response, 0);
    }
    if (opts.onEvent) {
      opts.onEvent({ type: 'done', data: result });
    }

    return result;
  }

  /** Budget check — estimate cost before running. */
  estimateCost(inputChars: number, outputChars: number): number {
    const pricing = MODEL_PRICING[this.config.model] as { input: number; output: number };
    const estimatedInput = Math.ceil(inputChars / 4);
    const estimatedOutput = Math.ceil(outputChars / 4);
    return (
      (estimatedInput / 1_000_000) * pricing.input +
      (estimatedOutput / 1_000_000) * pricing.output
    );
  }

  /**
   * Invoke `claude -p` with the agent's system prompt and user content.
   * Pipes the user content via stdin, receives JSON on stdout.
   */
  private async invokeClaudeCli(
    modelId: string,
    userContent: string,
  ): Promise<ClaudeCliResult> {
    const args = [
      '-p',
      '--model', modelId,
      '--output-format', 'json',
      '--no-session-persistence',
      '--system-prompt', this.config.systemPrompt,
    ];

    // Default timeout: 10 minutes. Agents with heavier workloads should
    // raise this via AgentRuntimeConfig.maxTokens as a rough proxy for now.
    const timeoutMs = 10 * 60 * 1000;

    try {
      const { stdout } = await execFileAsync('claude', args, {
        input: userContent,
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
        env: { ...process.env },
      });

      const trimmed = stdout.toString().trim();
      if (!trimmed) {
        throw new Error('claude CLI returned empty output');
      }

      try {
        return JSON.parse(trimmed) as ClaudeCliResult;
      } catch (parseErr) {
        throw new Error(
          `Failed to parse claude CLI output as JSON: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }\nFirst 500 chars: ${trimmed.slice(0, 500)}`,
        );
      }
    } catch (err: unknown) {
      // execFileAsync wraps errors — unwrap code/signal if present
      if (err && typeof err === 'object') {
        const e = err as { code?: string | number; killed?: boolean; signal?: string; stderr?: Buffer | string; message?: string };
        if (e.code === 'ENOENT') {
          throw new Error(
            'claude CLI not found. Install Claude Code: https://claude.com/claude-code',
          );
        }
        if (e.killed || e.signal === 'SIGTERM') {
          throw new Error(`claude CLI timed out after ${timeoutMs}ms`);
        }
        if (e.stderr) {
          const stderrText = typeof e.stderr === 'string' ? e.stderr : e.stderr.toString();
          throw new Error(
            `claude CLI failed: ${e.message ?? 'unknown'}\nstderr: ${stderrText.slice(0, 500)}`,
          );
        }
      }
      throw err;
    }
  }

  /** Sum all categories of input tokens (new + cache_creation + cache_read). */
  private sumInputTokens(cli: ClaudeCliResult): number {
    const u = cli.usage;
    if (!u) return 0;
    return (
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    );
  }

  /** Fallback cost estimate when CLI omits total_cost_usd (shouldn't happen in normal usage). */
  private estimateFromPricing(inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[this.config.model] as { input: number; output: number };
    return (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    );
  }
}
