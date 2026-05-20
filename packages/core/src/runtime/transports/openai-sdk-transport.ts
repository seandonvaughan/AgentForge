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

interface OpenAiStreamEvent {
  type?: string;
  model?: string;
  response?: OpenAiResponseBody;
  response_id?: string;
  delta?: string;
  text?: string;
  usage?: OpenAiResponseBody['usage'];
  incomplete_details?: { reason?: string };
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
      });

      if (!response.ok) {
        const rawText = await response.text();
        const body = this.parseResponseBody(rawText);
        throw Object.assign(
          new Error(`OpenAI Responses API error (${response.status}): ${body.error?.message ?? rawText}`),
          { status: response.status, body },
        );
      }

      const streamed = await this.readStreamingResponse(response, options);
      const model = streamed.model ?? profile.modelId;
      const inputTokens = streamed.inputTokens;
      const outputTokens = streamed.outputTokens;
      const result: ExecutionResult = {
        providerKind: this.kind,
        response: streamed.text,
        model,
        ...(profile.effort ? { effort: profile.effort } : {}),
        usage: { inputTokens, outputTokens },
        costUsd: this.estimateCost(model, inputTokens, outputTokens),
        durationMs: Date.now() - startedAt,
        raw: streamed.events,
        ...(streamed.remoteSessionId ? { remoteSessionId: streamed.remoteSessionId } : {}),
        ...(streamed.stopReason ? { stopReason: streamed.stopReason } : {}),
      };

      this.emitEvent(options, {
        type: 'usage_delta',
        data: {
          inputTokens,
          outputTokens,
          costUsd: result.costUsd,
        },
      });

      if (request.outputSchema) {
        return { ...result, schemaValidation: validateAgainstSchema(result.response, request.outputSchema) };
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

  private async readStreamingResponse(
    response: Response,
    options: ExecutionStreamOptions,
  ): Promise<{
      text: string;
      inputTokens: number;
      outputTokens: number;
      model?: string;
      remoteSessionId?: string;
      stopReason?: string;
      events: unknown[];
    }> {
    if (!response.body) {
      const body = this.parseResponseBody(await response.text());
      const text = body.output_text ?? this.extractText(body.output);
      if (text) this.emitChunk(options, text, 0);
      return {
        text,
        inputTokens: body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
        ...(body.model ? { model: body.model } : {}),
        ...(body.id ? { remoteSessionId: body.id } : {}),
        ...(body.incomplete_details?.reason ? { stopReason: body.incomplete_details.reason } : {}),
        events: [body],
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const events: unknown[] = [];
    const textParts: string[] = [];
    let model: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let remoteSessionId: string | undefined;
    let stopReason: string | undefined;
    let chunkIndex = 0;
    let buffer = '';

    const processBlock = (block: string): boolean => {
      const parsed = this.parseSseBlock(block);
      if (!parsed) return false;
      if (parsed.data === '[DONE]') return true;

      let event: OpenAiStreamEvent;
      try {
        event = JSON.parse(parsed.data) as OpenAiStreamEvent;
      } catch {
        return false;
      }

      events.push(event);
      const eventType = typeof event.type === 'string' ? event.type : parsed.event;
      if (typeof event.model === 'string') model = event.model;
      if (typeof event.response?.model === 'string') model = event.response.model;
      if (typeof event.response_id === 'string') remoteSessionId = event.response_id;
      if (typeof event.response?.id === 'string') remoteSessionId = event.response.id;

      const usage = event.response?.usage ?? event.usage;
      if (usage) {
        inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? usage.completion_tokens ?? outputTokens;
      }

      const deltaText = event.delta ?? (eventType === 'response.output_text.delta' ? event.text : undefined);
      if (typeof deltaText === 'string' && deltaText.length > 0) {
        textParts.push(deltaText);
        this.emitChunk(options, deltaText, chunkIndex);
        chunkIndex += 1;
      }

      if (!stopReason) {
        stopReason = event.response?.incomplete_details?.reason ?? event.incomplete_details?.reason;
      }

      return false;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (processBlock(block)) {
          reader.releaseLock();
          return {
            text: textParts.join(''),
            inputTokens,
            outputTokens,
            ...(model ? { model } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            ...(stopReason ? { stopReason } : {}),
            events,
          };
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      void processBlock(trailing);
    }

    return {
      text: textParts.join(''),
      inputTokens,
      outputTokens,
      ...(model ? { model } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(stopReason ? { stopReason } : {}),
      events,
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

  private parseSseBlock(block: string): { event: string; data: string } | null {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
        continue;
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
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

  private emitChunk(options: ExecutionStreamOptions, text: string, index: number): void {
    options.onChunk?.(text, index);
    this.emitEvent(options, {
      type: 'text_delta',
      data: { text, content: text, index },
    });
  }

  private emitEvent(options: ExecutionStreamOptions, event: ExecutionStreamEvent): void {
    options.onEvent?.(event);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
