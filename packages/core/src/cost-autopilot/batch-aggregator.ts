import type { BatchRequest, BatchResult } from './types.js';

export type BatchExecutor = (requests: BatchRequest[]) => Promise<BatchResult[]>;

export interface BatchAggregatorConfig {
  windowMs: number;
  maxBatch: number;
}

interface PendingItem {
  request: BatchRequest;
  resolve: (result: BatchResult) => void;
  reject: (err: Error) => void;
}

export class BatchAggregator {
  private pending: PendingItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private config: BatchAggregatorConfig;
  private executor: BatchExecutor;
  private totalBatches = 0;
  private totalRequests = 0;

  constructor(executor: BatchExecutor, config: Partial<BatchAggregatorConfig> = {}) {
    this.executor = executor;
    this.config = {
      windowMs: config.windowMs ?? 100,
      maxBatch: config.maxBatch ?? 10,
    };
  }

  enqueue(request: BatchRequest): Promise<BatchResult> {
    return new Promise<BatchResult>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
      this.totalRequests++;

      if (this.pending.length >= this.config.maxBatch) {
        this.flushNow();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flushNow(), this.config.windowMs);
      }
    });
  }

  async flush(): Promise<void> {
    if (this.pending.length > 0) {
      await this.flushNow();
    }
  }

  private async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pending.length === 0) return;

    const batch = this.pending.splice(0, this.config.maxBatch);
    this.totalBatches++;

    const batchId = `batch-${this.totalBatches}-${Date.now()}`;

    try {
      const results = await this.executor(batch.map(item => item.request));
      for (let i = 0; i < batch.length; i++) {
        const result = results[i] ?? {
          requestId: batch[i].request.id,
          response: null,
          costUsd: 0,
          fromCache: false,
          batchId,
        };
        batch[i].resolve({ ...result, batchId });
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const item of batch) {
        item.reject(error);
      }
    }
  }

  getStats() {
    return {
      totalBatches: this.totalBatches,
      totalRequests: this.totalRequests,
      pendingRequests: this.pending.length,
      avgBatchSize: this.totalBatches > 0 ? this.totalRequests / this.totalBatches : 0,
    };
  }
}
