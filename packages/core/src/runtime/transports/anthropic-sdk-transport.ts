import { MODEL_PRICING } from '../../agent-runtime/types.js';
import type { ExecutionRequest, ExecutionResult, ExecutionTransport } from '../types.js';

interface AnthropicMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: AnthropicMessageUsage;
  content?: Array<{ type?: string; text?: string }>;
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

    const response = (await client.messages.create({
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
    } as any)) as unknown as AnthropicMessageResponse;

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
      },
      costUsd: this.estimateCost(request.agent.model, inputTokens, outputTokens),
      durationMs: Date.now() - startedAt,
      raw: response,
      ...(response.id ? { remoteSessionId: response.id } : {}),
      ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
    };
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
