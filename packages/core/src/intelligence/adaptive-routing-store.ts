import { appendFileSync, readFileSync } from 'node:fs';

export interface RoutingFeedbackRecord {
  ts: string;
  agentId: string;
  model: string;
  success: boolean;
  latencyMs: number;
  costUsd: number;
}

/**
 * Append one record to the JSONL file at `filePath`.
 * Uses synchronous appendFileSync so callers don't need to await.
 */
export function appendRoutingFeedback(filePath: string, record: RoutingFeedbackRecord): void {
  const line = JSON.stringify(record) + '\n';
  try {
    appendFileSync(filePath, line, 'utf8');
  } catch {
    // Silently ignore write errors (e.g. directory doesn't exist yet)
  }
}

/**
 * Read all valid JSONL records from `filePath`.
 * Returns an empty array if the file does not exist or any line is malformed.
 * Malformed lines are skipped silently.
 */
export function readRoutingFeedback(filePath: string): RoutingFeedbackRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const records: RoutingFeedbackRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (
        obj !== null &&
        typeof obj === 'object' &&
        'agentId' in obj &&
        'model' in obj &&
        'success' in obj &&
        'latencyMs' in obj &&
        'costUsd' in obj
      ) {
        records.push(obj as RoutingFeedbackRecord);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}
