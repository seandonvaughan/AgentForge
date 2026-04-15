import { spawn, spawnSync } from 'node:child_process';
import { MODEL_PRICING } from '../../agent-runtime/types.js';
import type { ExecutionRequest, ExecutionResult, ExecutionTransport } from '../types.js';

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

export class ClaudeCodeCompatTransport implements ExecutionTransport {
  readonly kind = 'claude-code-compat' as const;

  isAvailable(): boolean {
    const probe = process.platform === 'win32'
      ? spawnSync('where', ['claude'], { stdio: 'ignore' })
      : spawnSync('which', ['claude'], { stdio: 'ignore' });
    return probe.status === 0;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const cliResult = await this.invokeClaudeCli(request);
    if (cliResult.is_error) {
      throw new Error(
        `claude CLI reported error: subtype=${cliResult.subtype}, terminal=${cliResult.terminal_reason ?? 'unknown'}`,
      );
    }

    const inputTokens = this.sumInputTokens(cliResult);
    const outputTokens = cliResult.usage?.output_tokens ?? 0;

    return {
      providerKind: this.kind,
      response: cliResult.result ?? '',
      model: request.modelId,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cliResult.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: cliResult.usage?.cache_read_input_tokens ?? 0,
      },
      costUsd: cliResult.total_cost_usd ?? this.estimateCost(request.agent.model, inputTokens, outputTokens),
      durationMs: cliResult.duration_ms ?? 0,
      raw: cliResult,
      ...(cliResult.session_id ? { remoteSessionId: cliResult.session_id } : {}),
      ...(cliResult.stop_reason ? { stopReason: cliResult.stop_reason } : {}),
    };
  }

  private async invokeClaudeCli(request: ExecutionRequest): Promise<ClaudeCliResult> {
    const args = [
      '-p',
      '--model', request.modelId,
      '--output-format', 'json',
      '--no-session-persistence',
      '--system-prompt', request.agent.systemPrompt,
    ];

    if (request.allowedTools && request.allowedTools.length > 0) {
      args.push('--allowed-tools', request.allowedTools.join(','));
    }

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
            return;
          }
          reject(err);
        });
      });

      proc.on('close', (code: number | null) => {
        finish(() => {
          if (code !== 0) {
            reject(new Error(
              `claude CLI exited with code ${code}\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 1000)}`,
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

      proc.stdin.on('error', (err: Error) => {
        finish(() => reject(new Error(`Failed to write to claude CLI stdin: ${err.message}`)));
      });
      proc.stdin.write(request.userContent, 'utf8', (writeErr) => {
        if (writeErr) {
          finish(() => reject(new Error(`stdin write failed: ${writeErr.message}`)));
          return;
        }
        proc.stdin.end();
      });
    });
  }

  private sumInputTokens(cli: ClaudeCliResult): number {
    const usage = cli.usage;
    if (!usage) return 0;
    return (
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
    );
  }

  private estimateCost(model: keyof typeof MODEL_PRICING, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model];
    return (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    );
  }
}
