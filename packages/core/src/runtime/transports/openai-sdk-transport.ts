import { getRequestModelProfile } from '../model-profiles.js';
import { estimateOpenAiCostUsd } from '../openai-pricing.js';
import { normalizeStrictOutputSchema } from '../output-schema.js';
import {
  TransportAuthError,
  classifyOpenAiError,
} from '../transport-errors.js';
import type {
  AgentOutputSchema,
  ExecutionRequest,
  ExecutionResult,
  ExecutionStreamEvent,
  ExecutionStreamOptions,
  ExecutionTransport,
} from '../types.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

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

interface OpenAiResponseBody {
  id?: string;
  model?: string;
  output_text?: string;
  output?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  status?: string;
  incomplete_details?: { reason?: string };
  error?: { message?: string };
}

export class OpenAiSdkTransport implements ExecutionTransport {
  readonly kind = 'openai-sdk' as const;

  isAvailable(request: ExecutionRequest): boolean {
    return Boolean(request.apiKey || process.env.OPENAI_API_KEY);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.OPENAI_API_KEY;
    const profile = getRequestModelProfile(this.kind, request);
    if (!apiKey) {
      throw new TransportAuthError('OpenAI transport requires OPENAI_API_KEY or an explicit apiKey.');
    }

    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildResponsePayload(request)),
      });

      const rawText = await response.text();
      const body = this.parseResponseBody(rawText);
      if (!response.ok) {
        throw Object.assign(
          new Error(`OpenAI Responses API error (${response.status}): ${body.error?.message ?? rawText}`),
          { status: response.status, body },
        );
      }

      const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0;
      const text = body.output_text ?? this.extractText(body.output);
      const result: ExecutionResult = {
        providerKind: this.kind,
        response: text,
        model: body.model ?? profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: { inputTokens, outputTokens },
        costUsd: this.estimateCost(body.model ?? profile.modelId, inputTokens, outputTokens),
        durationMs: Date.now() - startedAt,
        raw: body,
        ...(body.id ? { remoteSessionId: body.id } : {}),
        ...(body.incomplete_details?.reason ? { stopReason: body.incomplete_details.reason } : {}),
      };

      if (request.outputSchema) {
        return { ...result, schemaValidation: validateAgainstSchema(text, request.outputSchema) };
      }
      return result;
    } catch (err) {
      throw classifyOpenAiError(err);
    }
  }

  async executeStreaming(
    request: ExecutionRequest,
    options: ExecutionStreamOptions = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const apiKey = request.apiKey ?? process.env.OPENAI_API_KEY;
    const profile = getRequestModelProfile(this.kind, request);
    if (!apiKey) {
      throw new TransportAuthError('OpenAI transport requires OPENAI_API_KEY or an explicit apiKey.');
    }

    this.emitEvent(options, {
      type: 'start',
      data: {
        providerKind: this.kind,
        model: profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
      },
    });

    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...this.buildResponsePayload(request),
          stream: true,
        }),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok) {
        const rawText = await response.text();
        const body = this.parseResponseBody(rawText);
        throw Object.assign(
          new Error(`OpenAI Responses API error (${response.status}): ${body.error?.message ?? rawText}`),
          { status: response.status, body },
        );
      }

      const streamResult = await this.readStreamingResponse(response, options);
      const result: ExecutionResult = {
        providerKind: this.kind,
        response: streamResult.responseText,
        model: streamResult.model ?? profile.modelId,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: {
          inputTokens: streamResult.inputTokens,
          outputTokens: streamResult.outputTokens,
        },
        costUsd: this.estimateCost(
          streamResult.model ?? profile.modelId,
          streamResult.inputTokens,
          streamResult.outputTokens,
        ),
        durationMs: Date.now() - startedAt,
        raw: { events: streamResult.events },
        ...(streamResult.responseId ? { remoteSessionId: streamResult.responseId } : {}),
        ...(streamResult.stopReason ? { stopReason: streamResult.stopReason } : {}),
      };

      this.emitEvent(options, {
        type: 'usage_delta',
        data: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.costUsd,
        },
      });

      if (request.outputSchema) {
        return {
          ...result,
          schemaValidation: validateAgainstSchema(streamResult.responseText, request.outputSchema),
        };
      }
      return result;
    } catch (err) {
      throw classifyOpenAiError(err);
    }
  }

  buildResponsePayload(request: ExecutionRequest): Record<string, unknown> {
    const profile = getRequestModelProfile(this.kind, request);
    const outputSchema = request.outputSchema
      ? normalizeStrictOutputSchema(request.outputSchema)
      : undefined;
    const instructions = request.outputSchema
      ? `${request.agent.systemPrompt}\n\nReturn a JSON object matching this schema: ${JSON.stringify(outputSchema?.schema)}`
      : request.agent.systemPrompt;

    return {
      model: profile.modelId,
      instructions,
      input: request.userContent,
      max_output_tokens: request.maxTokens ?? 8096,
      ...(profile.effort ? { reasoning: { effort: profile.effort } } : {}),
      ...(outputSchema
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: outputSchema.name,
                schema: outputSchema.schema,
                strict: outputSchema.strict ?? true,
              },
            },
          }
        : {}),
    };
  }

  private parseResponseBody(rawText: string): OpenAiResponseBody {
    if (!rawText) return {};
    try {
      return JSON.parse(rawText) as OpenAiResponseBody;
    } catch {
      return { error: { message: rawText } };
    }
  }

  private async readStreamingResponse(
    response: Response,
    options: ExecutionStreamOptions,
  ): Promise<{
    responseText: string;
    responseId?: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    stopReason?: string;
    events: unknown[];
  }> {
    const events: unknown[] = [];
    const body = response.body;
    if (!body) {
      return {
        responseText: '',
        inputTokens: 0,
        outputTokens: 0,
        events,
      };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkIndex = 0;
    let emittedAnyText = false;
    let responseText = '';
    let responseId: string | undefined;
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;
    let completedOutputText = '';
    let pendingDataLines: string[] = [];

    const processDataPayload = (rawPayload: string): void => {
      const trimmed = rawPayload.trim();
      if (!trimmed || trimmed === '[DONE]') return;

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      events.push(event);

      if (!this.isRecord(event)) return;
      const type = typeof event.type === 'string' ? event.type : '';
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        const delta = event.delta;
        responseText += delta;
        emittedAnyText = true;
        options.onChunk?.(delta, chunkIndex);
        this.emitEvent(options, {
          type: 'text_delta',
          data: { text: delta, content: delta, index: chunkIndex },
        });
        chunkIndex += 1;
        return;
      }

      if (type === 'response.completed' && this.isRecord(event.response)) {
        const responseRecord = event.response;
        if (typeof responseRecord.id === 'string') responseId = responseRecord.id;
        if (typeof responseRecord.model === 'string') model = responseRecord.model;
        const usage = this.extractUsageRecord(responseRecord);
        if (usage.inputTokens > 0 || usage.outputTokens > 0) {
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
        }
        const extractedText = this.extractCompletedResponseText(responseRecord);
        if (extractedText) completedOutputText = extractedText;
        if (this.isRecord(responseRecord.incomplete_details) && typeof responseRecord.incomplete_details.reason === 'string') {
          stopReason = responseRecord.incomplete_details.reason;
        }
        return;
      }

      if ((type === 'error' || type === 'response.error') && this.isRecord(event.error)) {
        const message = typeof event.error.message === 'string' ? event.error.message : 'OpenAI streaming error';
        throw new Error(message);
      }
    };

    const flushPendingEvent = (): void => {
      if (pendingDataLines.length === 0) return;
      const payload = pendingDataLines.join('\n');
      pendingDataLines = [];
      processDataPayload(payload);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') {
          flushPendingEvent();
          continue;
        }
        if (line.startsWith('data:')) {
          pendingDataLines.push(line.slice(5).trimStart());
        }
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const tailLines = buffer.split(/\r?\n/);
      for (const line of tailLines) {
        if (line === '') {
          flushPendingEvent();
        } else if (line.startsWith('data:')) {
          pendingDataLines.push(line.slice(5).trimStart());
        }
      }
    }
    flushPendingEvent();

    if (!responseText && completedOutputText) {
      responseText = completedOutputText;
      if (!emittedAnyText && responseText.length > 0) {
        options.onChunk?.(responseText, chunkIndex);
        this.emitEvent(options, {
          type: 'text_delta',
          data: { text: responseText, content: responseText, index: chunkIndex },
        });
      }
    }

    const usageFromEvents = this.extractUsageFromEvents(events);
    if (usageFromEvents.inputTokens > 0 || usageFromEvents.outputTokens > 0) {
      inputTokens = usageFromEvents.inputTokens;
      outputTokens = usageFromEvents.outputTokens;
    }

    return {
      responseText,
      ...(responseId ? { responseId } : {}),
      ...(model ? { model } : {}),
      inputTokens,
      outputTokens,
      ...(stopReason ? { stopReason } : {}),
      events,
    };
  }

  private extractUsageFromEvents(events: unknown[]): { inputTokens: number; outputTokens: number } {
    for (const event of events) {
      if (!this.isRecord(event)) continue;
      const usage = this.extractUsageRecord(event);
      if (usage.inputTokens > 0 || usage.outputTokens > 0) return usage;
      if (this.isRecord(event.response)) {
        const nestedUsage = this.extractUsageRecord(event.response);
        if (nestedUsage.inputTokens > 0 || nestedUsage.outputTokens > 0) return nestedUsage;
      }
    }
    return { inputTokens: 0, outputTokens: 0 };
  }

  private extractUsageRecord(value: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
    const usage = this.isRecord(value.usage) ? value.usage : null;
    if (!usage) return { inputTokens: 0, outputTokens: 0 };
    return {
      inputTokens:
        (typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined) ??
        (typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined) ??
        0,
      outputTokens:
        (typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined) ??
        (typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined) ??
        0,
    };
  }

  private extractCompletedResponseText(value: Record<string, unknown>): string {
    if (typeof value.output_text === 'string' && value.output_text.trim()) {
      return value.output_text;
    }
    return this.extractText(value.output);
  }

  private extractText(output: unknown): string {
    if (!Array.isArray(output)) return '';
    const pieces: string[] = [];
    for (const item of output) {
      if (!this.isRecord(item)) continue;
      const content = Array.isArray(item.content) ? item.content : [];
      for (const block of content) {
        if (!this.isRecord(block)) continue;
        if (typeof block.text === 'string') pieces.push(block.text);
        if (typeof block.output_text === 'string') pieces.push(block.output_text);
      }
    }
    return pieces.join('\n').trim();
  }

  private estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
    return estimateOpenAiCostUsd(modelId, inputTokens, outputTokens);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private emitEvent(options: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    options.onEvent?.(event);
  }
}
