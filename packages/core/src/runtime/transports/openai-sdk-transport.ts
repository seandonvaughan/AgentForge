import { getRequestModelProfile } from '../model-profiles.js';
import { normalizeStrictOutputSchema } from '../output-schema.js';
import {
  TransportAuthError,
  classifyOpenAiError,
} from '../transport-errors.js';
import type {
  AgentOutputSchema,
  ExecutionRequest,
  ExecutionResult,
  ExecutionTransport,
} from '../types.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GPT_53_CODEX_INPUT_PER_MILLION = 1.75;
const GPT_53_CODEX_OUTPUT_PER_MILLION = 14.0;

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
        costUsd: this.estimateCost(inputTokens, outputTokens),
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

  private estimateCost(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens / 1_000_000) * GPT_53_CODEX_INPUT_PER_MILLION +
      (outputTokens / 1_000_000) * GPT_53_CODEX_OUTPUT_PER_MILLION
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
