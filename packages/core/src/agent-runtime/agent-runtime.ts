import type { AgentRuntimeConfig, RunOptions, RunResult } from './types.js';
import { MODEL_PRICING } from './types.js';
import type { WorkspaceAdapter } from '@agentforge/db';
import { ExecutionService } from '../runtime/execution-service.js';
import type { ExecutionStreamOptions } from '../runtime/types.js';

export class AgentRuntime {
  private readonly executionService: ExecutionService;

  constructor(
    private config: AgentRuntimeConfig,
    private adapter?: WorkspaceAdapter,
    private apiKey?: string,
    executionService?: ExecutionService,
  ) {
    this.executionService = executionService ?? new ExecutionService();
  }

  async run(opts: RunOptions): Promise<RunResult> {
    return this.executionService.run(this.config, opts, this.adapter, this.apiKey);
  }

  async runStreaming(opts: RunOptions & ExecutionStreamOptions): Promise<RunResult> {
    return this.executionService.runStreaming(this.config, opts, this.adapter, this.apiKey);
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
}
