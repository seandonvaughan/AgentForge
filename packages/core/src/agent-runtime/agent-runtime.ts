import Anthropic from '@anthropic-ai/sdk';
import type { AgentRuntimeConfig, RunOptions, RunResult } from './types.js';
import { MODEL_PRICING, MODEL_IDS } from './types.js';
import type { WorkspaceAdapter } from '@agentforge/db';

export class AgentRuntime {
  private client: Anthropic;

  constructor(
    private config: AgentRuntimeConfig,
    private adapter?: WorkspaceAdapter,
    apiKey?: string,
  ) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
  }

  async run(opts: RunOptions): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    // MODEL_IDS is keyed on all ModelTier values — assert non-null
    const modelId = MODEL_IDS[this.config.model] as string;
    const maxTokens = this.config.maxTokens ?? 8096;

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
      const response = await this.client.messages.create({
        model: modelId as Anthropic.Model,
        max_tokens: maxTokens,
        system: this.config.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });

      const completedAt = new Date().toISOString();
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      // MODEL_PRICING is exhaustive over ModelTier — assert non-null
      const pricing = MODEL_PRICING[this.config.model] as { input: number; output: number };
      const costUsd =
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output;

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

      const result: RunResult = {
        sessionId: sessionId ?? '',
        response: text,
        model: modelId,
        inputTokens,
        outputTokens,
        costUsd,
        startedAt,
        completedAt,
        status: 'completed',
      };

      // Persist completion
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

  async runStreaming(opts: RunOptions & {
    onChunk?: (text: string, index: number) => void;
    onEvent?: (event: { type: string; data: unknown }) => void;
  }): Promise<RunResult> {
    const startedAt = new Date().toISOString();
    const modelId = MODEL_IDS[this.config.model] as string;
    const maxTokens = this.config.maxTokens ?? 8096;

    const userContent = opts.context
      ? `<context>\n${opts.context}\n</context>\n\n${opts.task}`
      : opts.task;

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
      let chunkIndex = 0;
      const stream = this.client.messages.stream({
        model: modelId as Anthropic.Model,
        max_tokens: maxTokens,
        system: this.config.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });

      stream.on('text', (textDelta: string) => {
        if (opts.onChunk) opts.onChunk(textDelta, chunkIndex);
        if (opts.onEvent) opts.onEvent({ type: 'chunk', data: { text: textDelta, index: chunkIndex } });
        chunkIndex++;
      });

      const response = await stream.finalMessage();

      const completedAt = new Date().toISOString();
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const pricing = MODEL_PRICING[this.config.model] as { input: number; output: number };
      const costUsd =
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output;

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

      const result: RunResult = {
        sessionId: sessionId ?? '',
        response: text,
        model: modelId,
        inputTokens,
        outputTokens,
        costUsd,
        startedAt,
        completedAt,
        status: 'completed',
      };

      if (opts.onEvent) opts.onEvent({ type: 'done', data: result });

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

      const failResult: RunResult = {
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

      if (opts.onEvent) opts.onEvent({ type: 'done', data: failResult });

      return failResult;
    }
  }

  /** Budget check — estimate cost before running. */
  estimateCost(inputChars: number, outputChars: number): number {
    // MODEL_PRICING is exhaustive over ModelTier — assert non-null
    const pricing = MODEL_PRICING[this.config.model] as { input: number; output: number };
    const estimatedInput = Math.ceil(inputChars / 4);
    const estimatedOutput = Math.ceil(outputChars / 4);
    return (
      (estimatedInput / 1_000_000) * pricing.input +
      (estimatedOutput / 1_000_000) * pricing.output
    );
  }
}
