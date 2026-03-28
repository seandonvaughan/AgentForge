import type { StreamChunk } from './types.js';
import { ResponseStreamer } from './response-streamer.js';

/**
 * StreamingExecutor wraps any async executor function and streams its output.
 */
export class StreamingExecutor {
  private streamer = new ResponseStreamer();

  /**
   * Execute a task via the provided async executor and stream the result
   * to the onChunk callback.
   *
   * @param task - The task string passed to the executor
   * @param onChunk - Callback invoked for each StreamChunk
   * @returns The full assembled response string
   */
  async execute(
    task: string,
    onChunk: (chunk: StreamChunk) => void,
    executor?: (task: string) => Promise<string>,
  ): Promise<string> {
    // Default executor: returns the task string as a simple echo response
    const fn = executor ?? ((t: string) => Promise.resolve(`Executed: ${t}`));
    const result = await fn(task);

    for await (const chunk of this.streamer.stream(result)) {
      onChunk(chunk);
    }

    return result;
  }
}
