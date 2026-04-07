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

import { spawn } from 'node:child_process';
import type { AgentRuntimeConfig, RunOptions, RunResult } from './types.js';
import { MODEL_PRICING, MODEL_IDS } from './types.js';
import type { WorkspaceAdapter } from '@agentforge/db';

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
   *
   * v6.4.2 fix: uses `spawn` instead of `execFileAsync`. Node's
   * `execFile` does NOT support the `input` option in async form — only
   * the *Sync variants do. Using execFileAsync with `{input}` silently
   * failed to write stdin, causing `claude -p` to hang on "no stdin
   * data received in 3s" and then exit with "Input must be provided".
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

    return new Promise<ClaudeCliResult>((resolve, reject) => {
      const proc = spawn('claude', args, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(() => reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => {
          if (err.code === 'ENOENT') {
            reject(new Error(
              'claude CLI not found. Install Claude Code: https://claude.com/claude-code',
            ));
          } else {
            reject(err);
          }
        });
      });

      proc.on('close', (code: number | null) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(
              `claude CLI exited with code ${code}\nstderr: ${stderr.slice(0, 1000)}`,
            ));
            return;
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            reject(new Error('claude CLI returned empty output'));
            return;
          }
          try {
            resolve(JSON.parse(trimmed) as ClaudeCliResult);
          } catch (parseErr) {
            reject(new Error(
              `Failed to parse claude CLI output as JSON: ${
                parseErr instanceof Error ? parseErr.message : String(parseErr)
              }\nFirst 500 chars: ${trimmed.slice(0, 500)}`,
            ));
          }
        });
      });

      // Write the user content to stdin and close it to signal EOF
      proc.stdin.on('error', (err: Error) => {
        finish(() => reject(new Error(`Failed to write to claude CLI stdin: ${err.message}`)));
      });
      proc.stdin.write(userContent, 'utf8', (writeErr) => {
        if (writeErr) {
          finish(() => reject(new Error(`stdin write failed: ${writeErr.message}`)));
          return;
        }
        proc.stdin.end();
      });
    });
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
