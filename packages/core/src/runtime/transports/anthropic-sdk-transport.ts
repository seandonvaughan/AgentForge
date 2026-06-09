import { MODEL_PRICING } from '../../agent-runtime/types.js';
import {
  TransportAuthError,
  classifyAnthropicError,
} from '../transport-errors.js';
import type {
  AgentOutputSchema,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';
import { withCacheBreakpoints } from '../cache-control.js';
import type { SystemBlock } from '../cache-control.js';

// ---------------------------------------------------------------------------
// Inline schema validation helper
// TODO: replace with import from @agentforge/shared once T1 lands
// ---------------------------------------------------------------------------

function validateAgainstSchema(
  responseText: string,
  schema: AgentOutputSchema,
): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return { ok: false, error: 'Response is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Response is not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  const required = schema.schema.required ?? [];
  for (const key of required) {
    if (!(key in obj)) {
      return { ok: false, error: `Missing required property: ${key}` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum character length of a content block before we attach
 * `cache_control: {type:'ephemeral'}` to it.  4096 chars ≈ 1024 tokens
 * (rough 4-chars-per-token estimate).  Anthropic recommends caching blocks
 * that are large, static, and reused across requests.  The system prompt is
 * always cached regardless of this threshold.
 */
export const CACHE_CONTROL_CHAR_THRESHOLD = 4096;

/**
 * Sampling params (`temperature`, `top_p`, `top_k`) and the extended-thinking
 * `budget_tokens` field are REJECTED with a 400 by the Opus 4.7/4.8 class of
 * models. `supportsSamplingParams` returns false for those model ids so the
 * transport never sends them. Sonnet/Haiku still accept `temperature`, so the
 * gate is keyed on the model id rather than blanket-stripping it.
 *
 * Match is a defensive substring check (never regex on external text): any
 * model id containing `opus-4-7`/`opus-4.7`/`opus-4-8`/`opus-4.8`, or the
 * Fable family (`fable`), is treated as sampling-param-rejecting. Fable 5
 * additionally 400s on an explicit `thinking: {type: "disabled"}` — this
 * transport never sends a `thinking` param, which is the correct shape for it.
 */
export function supportsSamplingParams(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const rejecting =
    id.includes('fable') ||
    id.includes('opus-4-7') ||
    id.includes('opus-4.7') ||
    id.includes('opus-4-8') ||
    id.includes('opus-4.8');
  return !rejecting;
}

// ---------------------------------------------------------------------------
// Internal types — Anthropic wire format
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export class AnthropicSdkTransport implements ExecutionTransport {
  readonly kind = 'anthropic-sdk' as const;

  /**
   * Character-length threshold above which a user content block gets
   * `cache_control: {type:'ephemeral'}`.  Exposed as a mutable property so
   * tests can lower it without monkey-patching.
   */
  cacheControlThreshold: number = CACHE_CONTROL_CHAR_THRESHOLD;

  isAvailable(request: ExecutionRequest): boolean {
    return Boolean(request.apiKey || process.env.ANTHROPIC_API_KEY);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new TransportAuthError(
        'Anthropic SDK transport requires ANTHROPIC_API_KEY or an explicit apiKey.',
      );
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      const response = (await client.messages.create(
        this.buildMessageParams(request) as any,
      )) as unknown as AnthropicMessageResponse;

      const result = this.toExecutionResult(request, response, Date.now() - startedAt);

      // If outputSchema is set, validate and retry once on failure.
      if (request.outputSchema) {
        const validation = validateAgainstSchema(result.response, request.outputSchema);
        if (!validation.ok) {
          // One retry with corrective user message appended.
          const retryRequest: ExecutionRequest = {
            ...request,
            userContent: `${request.userContent}\n\nYour previous response did not match the required schema. Error: ${validation.error}. Re-emit valid JSON only.`,
          };
          const retryResponse = (await client.messages.create(
            this.buildMessageParams(retryRequest) as any,
          )) as unknown as AnthropicMessageResponse;
          const retryResult = this.toExecutionResult(retryRequest, retryResponse, Date.now() - startedAt);
          const retryValidation = validateAgainstSchema(retryResult.response, request.outputSchema);
          return { ...retryResult, schemaValidation: retryValidation };
        }
        return { ...result, schemaValidation: { ok: true } };
      }

      return result;
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }

  async executeStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new TransportAuthError(
        'Anthropic SDK transport requires ANTHROPIC_API_KEY or an explicit apiKey.',
      );
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      // Use messages.stream() — the SDK's dedicated streaming helper — which
      // yields typed MessageStreamEvent objects and exposes helper methods such
      // as .finalMessage() and .finalText().
      const sdkStream = client.messages.stream(
        this.buildMessageParams(request) as any,
        options.signal ? { signal: options.signal } : undefined,
      );

      // Cast to AsyncIterable so we can iterate with our internal event types.
      const stream = sdkStream as unknown as AsyncIterable<AnthropicStreamEvent>;

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
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      const normalizedResponse = response.trim() || (finalMessage ? this.extractText(finalMessage) : '');

      const result: ExecutionResult = {
        providerKind: this.kind,
        response: normalizedResponse,
        model,
        usage: {
          inputTokens,
          outputTokens,
          cacheCreationInputTokens: cacheCreationTokens,
          cacheReadInputTokens: cacheReadTokens,
        },
        costUsd: this.estimateCost(
          request.agent.model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        ),
        durationMs: Date.now() - startedAt,
        raw: finalMessage,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(stopReason ? { stopReason } : {}),
      };

      this.emitEvent(options, {
        type: 'done',
        data: {
          providerKind: this.kind,
          costUsd: result.costUsd,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        },
      });

      return result;
    } catch (err) {
      throw classifyAnthropicError(err);
    }
  }

  /**
   * Build the Anthropic `messages.create` / `messages.stream` parameter object.
   *
   * Cache-control rules:
   * - System prompt: always marked ephemeral (stable, large, reused per agent).
   * - User content: marked ephemeral only when its character length meets or
   *   exceeds `cacheControlThreshold` (default 4096 chars ≈ 1024 tokens).
   *
   * Exposed as a non-private method so tests can inspect the built params
   * without invoking the real SDK.
   */
  buildMessageParams(request: ExecutionRequest): Record<string, unknown> {
    const userContent = request.userContent;
    const shouldCacheUserContent =
      typeof userContent === 'string' && userContent.length >= this.cacheControlThreshold;

    const userContentBlock: unknown = shouldCacheUserContent
      ? [
          {
            type: 'text',
            text: userContent,
            cache_control: { type: 'ephemeral' },
          },
        ]
      : userContent;

    // Build raw system blocks then apply structured cache breakpoints.
    // `withCacheBreakpoints` marks exactly:
    //   (1) the trailing system_prompt segment
    //   (2) the trailing CLAUDE.md segment (if present)
    // Forge-phase requests use ttl:"1h"; cycle-phase uses the 5 min default.
    const rawSystemBlocks: SystemBlock[] = [
      { type: 'text', text: request.agent.systemPrompt },
    ];
    const systemBlocks = withCacheBreakpoints(
      rawSystemBlocks,
      request.phaseHint !== undefined ? { phaseHint: request.phaseHint } : {},
    );

    return {
      model: request.modelId,
      system: systemBlocks,
      max_tokens: request.maxTokens ?? 8096,
      messages: [
        {
          role: 'user',
          content: userContentBlock,
        },
      ],
      // Opus 4.7/4.8 reject `temperature` (and top_p/top_k/budget_tokens) with a
      // 400 — only send sampling params to models that accept them.
      ...(request.temperature !== undefined && supportsSamplingParams(request.modelId)
        ? { temperature: request.temperature }
        : {}),
      // outputFormat plumbing: fall back to response_format json_object since
      // @anthropic-ai/sdk does not expose a top-level outputFormat parameter.
      // Post-validation is handled in execute() via validateAgainstSchema().
      ...(request.outputSchema ? { response_format: { type: 'json_object' } } : {}),
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
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;

    return {
      providerKind: this.kind,
      response: this.extractText(response),
      model: response.model ?? request.modelId,
      usage: {
        inputTokens,
        outputTokens,
        cacheCreationInputTokens: cacheCreationTokens,
        cacheReadInputTokens: cacheReadTokens,
      },
      costUsd: this.estimateCost(
        request.agent.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      ),
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

  /**
   * Estimate total cost in USD for a call, accounting for Anthropic's cache
   * pricing:
   *   - Cache-read tokens: 10% of normal input price.
   *   - Cache-creation tokens: 125% of normal input price.
   *   - Regular input tokens (not cached): 100% of normal input price.
   *   - Output tokens: 100% of output price.
   */
  private estimateCost(
    model: keyof typeof MODEL_PRICING,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): number {
    const pricing = MODEL_PRICING[model];
    // Regular input = total input minus any that were served from cache or created cache entries.
    const regularInput = Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens);
    return (
      (regularInput / 1_000_000) * pricing.input +
      (cacheReadTokens / 1_000_000) * pricing.input * 0.1 +
      (cacheCreationTokens / 1_000_000) * pricing.input * 1.25 +
      (outputTokens / 1_000_000) * pricing.output
    );
  }
}
