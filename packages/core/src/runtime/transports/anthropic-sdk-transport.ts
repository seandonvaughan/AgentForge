import { MODEL_PRICING } from '../../agent-runtime/types.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';

interface AnthropicMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: AnthropicMessageUsage;
  content?: Array<{ type?: string; text?: string }>;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: AnthropicMessageResponse;
  index?: number;
  content_block?: { type?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicMessageUsage;
}

export class AnthropicSdkTransport implements ExecutionTransport {
  readonly kind = 'anthropic-sdk' as const;

  isAvailable(request: ExecutionRequest): boolean {
    return Boolean(request.apiKey || process.env.ANTHROPIC_API_KEY);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('Anthropic SDK transport requires ANTHROPIC_API_KEY or an explicit apiKey.');
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = (await client.messages.create(
      this.buildMessageParams(request) as any,
    )) as unknown as AnthropicMessageResponse;

    return this.toExecutionResult(request, response, Date.now() - startedAt);
  }

  async executeStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error('Anthropic SDK transport requires ANTHROPIC_API_KEY or an explicit apiKey.');
    }

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const stream = (await client.messages.create(
      {
        ...this.buildMessageParams(request),
        stream: true,
      } as any,
      options.signal ? { signal: options.signal } : undefined,
    )) as unknown as AsyncIterable<AnthropicStreamEvent>;

    let response = '';
    let chunkIndex = 0;
    let remoteSessionId: string | undefined;
    let model = request.modelId;
    let stopReason: string | undefined;
    let usage: AnthropicMessageUsage = {};
    let finalMessage: AnthropicMessageResponse | undefined;

    this.emitEvent(options, {
      type: 'start',
      data: { providerKind: this.kind, model: request.modelId },
    });

    for await (const event of stream) {
      if (event.type === 'message_start' && event.message) {
        finalMessage = event.message;
        if (event.message.id) remoteSessionId = event.message.id;
        if (event.message.model) model = event.message.model;
        usage = { ...usage, ...(event.message.usage ?? {}) };
        this.emitEvent(options, {
          type: 'metadata',
          data: {
            providerKind: this.kind,
            ...(remoteSessionId ? { remoteSessionId } : {}),
            model,
          },
        });
        this.emitUsage(options, usage);
        continue;
      }

      if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
        const text = event.content_block.text ?? '';
        if (text) {
          response += text;
          this.emitChunk(options, text, chunkIndex++);
        }
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text ?? '';
        if (text) {
          response += text;
          this.emitChunk(options, text, chunkIndex++);
        }
        continue;
      }

      if (event.type === 'message_delta') {
        usage = { ...usage, ...(event.usage ?? {}) };
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        this.emitUsage(options, usage);
      }
    }

    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const normalizedResponse = response.trim() || (finalMessage ? this.extractText(finalMessage) : '');

    return {
      providerKind: this.kind,
      response: normalizedResponse,
      model,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      },
      costUsd: this.estimateCost(request.agent.model, inputTokens, outputTokens),
      durationMs: Date.now() - startedAt,
      raw: finalMessage,
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
  }

  private buildMessageParams(request: ExecutionRequest): Record<string, unknown> {
    return {
      model: request.modelId,
      system: request.agent.systemPrompt,
      max_tokens: request.maxTokens ?? 8096,
      messages: [
        {
          role: 'user',
          content: request.userContent,
        },
      ],
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }

  private toExecutionResult(
    request: ExecutionRequest,
    response: AnthropicMessageResponse,
    durationMs: number,
  ): ExecutionResult {
    const usage = response.usage ?? {};
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;

    return {
      providerKind: this.kind,
      response: this.extractText(response),
      model: response.model ?? request.modelId,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      },
      costUsd: this.estimateCost(request.agent.model, inputTokens, outputTokens),
      durationMs,
      raw: response,
      ...(response.id ? { remoteSessionId: response.id } : {}),
      ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
    };
  }

  private emitChunk(options: ExecutionStreamOptions, text: string, index: number): void {
    options.onChunk?.(text, index);
    this.emitEvent(options, {
      type: 'text_delta',
      data: { text, content: text, index },
    });
  }

  private emitUsage(options: ExecutionStreamOptions, usage: AnthropicMessageUsage): void {
    this.emitEvent(options, {
      type: 'usage_delta',
      data: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      },
    });
  }

  private emitEvent(options: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    options.onEvent?.(event);
  }

  private extractText(response: AnthropicMessageResponse): string {
    const textBlocks = response.content?.filter((block) => block.type === 'text' && block.text);
    return textBlocks?.map((block) => block.text).join('\n').trim() ?? '';
  }

  private estimateCost(model: keyof typeof MODEL_PRICING, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING[model];
    return (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    );
  }
}
