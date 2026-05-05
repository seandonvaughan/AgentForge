import { spawn, spawnSync } from 'node:child_process';
import { MODEL_PRICING } from '../../agent-runtime/types.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';

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

interface ClaudeStreamInvocationResult {
  cliResult: ClaudeCliResult;
  chunksEmitted: number;
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
    return this.toExecutionResult(request, cliResult);
  }

  async executeStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions = {},
  ): Promise<ExecutionResult> {
    const { cliResult, chunksEmitted } = await this.invokeClaudeCliStreaming(request, options);
    const execution = this.toExecutionResult(request, cliResult);

    if (chunksEmitted === 0 && execution.response) {
      this.emitChunk(options, execution.response, 0);
    }

    return execution;
  }

  private toExecutionResult(
    request: ExecutionRequest,
    cliResult: ClaudeCliResult,
  ): ExecutionResult {
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
    const args = this.buildClaudeArgs(request, 'json');
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

  private async invokeClaudeCliStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions,
  ): Promise<ClaudeStreamInvocationResult> {
    const args = this.buildClaudeArgs(request, 'stream-json');
    const timeoutMs = 10 * 60 * 1000;

    return new Promise<ClaudeStreamInvocationResult>((resolve, reject) => {
      const proc = spawn('claude', args, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let lineBuffer = '';
      let settled = false;
      let finalResult: ClaudeCliResult | undefined;
      let accumulatedText = '';
      let chunksEmitted = 0;
      let chunkIndex = 0;
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abortHandler);
        fn();
      };

      const abortHandler = () => {
        proc.kill('SIGTERM');
        finish(() => reject(new Error('claude CLI streaming run was aborted')));
      };

      timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(() => reject(new Error(`claude CLI timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      if (options.signal?.aborted) {
        abortHandler();
        return;
      }
      options.signal?.addEventListener('abort', abortHandler, { once: true });

      this.emitEvent(options, {
        type: 'start',
        data: { providerKind: this.kind, model: request.modelId },
      });

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: unknown;
        try {
          event = JSON.parse(trimmed);
        } catch (parseErr) {
          finish(() => reject(new Error(
            `Failed to parse claude CLI stream JSON: ${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }\nLine: ${trimmed.slice(0, 500)}`,
          )));
          return;
        }

        const metadata = this.extractClaudeMetadata(event);
        if (metadata) {
          this.emitEvent(options, { type: 'metadata', data: metadata });
        }

        const text = this.extractClaudeStreamText(event, accumulatedText);
        if (text) {
          accumulatedText += text;
          this.emitChunk(options, text, chunkIndex++);
          chunksEmitted += 1;
        }

        if (this.isClaudeResultEvent(event)) {
          finalResult = event;
          this.emitUsage(options, event);
        }
      };

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        lineBuffer += text;

        let newlineIndex = lineBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = lineBuffer.slice(0, newlineIndex);
          lineBuffer = lineBuffer.slice(newlineIndex + 1);
          handleLine(line);
          if (settled) return;
          newlineIndex = lineBuffer.indexOf('\n');
        }
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
        if (settled) return;
        if (lineBuffer.trim()) {
          handleLine(lineBuffer);
          if (settled) return;
        }

        finish(() => {
          if (code !== 0) {
            reject(new Error(
              `claude CLI exited with code ${code}\nstderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 1000)}`,
            ));
            return;
          }

          if (!finalResult && accumulatedText) {
            finalResult = {
              type: 'result',
              subtype: 'success',
              is_error: false,
              duration_ms: Date.now() - startedAt,
              result: accumulatedText,
            };
          }

          if (!finalResult) {
            reject(new Error('claude CLI stream returned no result event'));
            return;
          }

          resolve({ cliResult: finalResult, chunksEmitted });
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

  private buildClaudeArgs(
    request: ExecutionRequest,
    outputFormat: 'json' | 'stream-json',
  ): string[] {
    const args = [
      '-p',
      '--model', request.modelId,
      '--output-format', outputFormat,
      '--no-session-persistence',
      '--system-prompt', request.agent.systemPrompt,
    ];

    if (outputFormat === 'stream-json') {
      args.push('--verbose', '--include-partial-messages');
    }

    if (request.allowedTools && request.allowedTools.length > 0) {
      args.push('--allowed-tools', request.allowedTools.join(','));
    }

    return args;
  }

  private extractClaudeMetadata(event: unknown): Record<string, unknown> | null {
    if (!this.isRecord(event)) return null;

    if (event.type === 'system') {
      return {
        providerKind: this.kind,
        ...(typeof event.session_id === 'string' ? { remoteSessionId: event.session_id } : {}),
        ...(typeof event.model === 'string' ? { model: event.model } : {}),
      };
    }

    const message = this.isRecord(event.message) ? event.message : null;
    if (event.type === 'assistant' && message) {
      return {
        providerKind: this.kind,
        ...(typeof event.session_id === 'string' ? { remoteSessionId: event.session_id } : {}),
        ...(typeof message.model === 'string' ? { model: message.model } : {}),
      };
    }

    return null;
  }

  private extractClaudeStreamText(event: unknown, previousText: string): string {
    const directDelta = this.extractDirectTextDelta(event);
    if (directDelta) return directDelta;

    const fullText = this.extractAssistantSnapshotText(event);
    if (!fullText || fullText === previousText) return '';

    if (fullText.startsWith(previousText)) {
      return fullText.slice(previousText.length);
    }

    return fullText;
  }

  private extractDirectTextDelta(event: unknown): string {
    if (!this.isRecord(event)) return '';

    const delta = this.isRecord(event.delta) ? event.delta : null;
    if (delta && typeof delta.text === 'string') {
      return delta.text;
    }

    if (typeof event.text === 'string' && event.type === 'text_delta') {
      return event.text;
    }

    return '';
  }

  private extractAssistantSnapshotText(event: unknown): string {
    if (!this.isRecord(event)) return '';

    const message = this.isRecord(event.message) ? event.message : event;
    const content = Array.isArray(message.content) ? message.content : null;
    if (!content) return '';

    return content
      .map((block) => {
        if (!this.isRecord(block)) return '';
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }

  private isClaudeResultEvent(event: unknown): event is ClaudeCliResult {
    return this.isRecord(event) && event.type === 'result';
  }

  private emitChunk(options: ExecutionStreamOptions, text: string, index: number): void {
    options.onChunk?.(text, index);
    this.emitEvent(options, {
      type: 'text_delta',
      data: { text, content: text, index },
    });
  }

  private emitUsage(options: ExecutionStreamOptions, cliResult: ClaudeCliResult): void {
    this.emitEvent(options, {
      type: 'usage_delta',
      data: {
        inputTokens: this.sumInputTokens(cliResult),
        outputTokens: cliResult.usage?.output_tokens ?? 0,
        cacheCreationInputTokens: cliResult.usage?.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: cliResult.usage?.cache_read_input_tokens ?? 0,
        ...(cliResult.total_cost_usd !== undefined ? { costUsd: cliResult.total_cost_usd } : {}),
      },
    });
  }

  private emitEvent(options: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    options.onEvent?.(event);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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
