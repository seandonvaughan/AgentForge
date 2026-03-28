/** AgentRuntime Streaming Response types */

export interface StreamChunk {
  /** Index of this chunk (0-based) */
  index: number;
  /** The text content of this chunk */
  content: string;
  /** Whether this is the final chunk */
  done: boolean;
  /** ISO timestamp when chunk was produced */
  timestamp: string;
}

export interface StreamConfig {
  /** Number of characters per chunk. Default: 20 */
  chunkSize?: number;
  /** Artificial delay between chunks in milliseconds. Default: 0 */
  delayMs?: number;
}

export interface StreamHandle {
  /** Unique ID for this stream */
  id: string;
  /** Task ID this stream is associated with */
  taskId: string;
  /** Total character length of the content being streamed */
  totalLength: number;
  /** When the stream was started */
  startedAt: string;
}
