/**
 * quality-jsonl-reader.ts
 *
 * Bounded JSONL scan for `.agentforge/memory/step-scores.jsonl`.
 *
 * Reads line-by-line up to LINE_CAP lines; returns `truncated: true` if the
 * cap is hit. Malformed JSON lines are silently skipped.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StepScore {
  id?: string;
  cycle_id?: string;
  agent_id?: string;
  skill_id?: string;
  model?: string;
  quality_score?: number;
  cost_usd?: number;
  created_at?: string;
  /** Allow arbitrary extra fields */
  [key: string]: unknown;
}

export interface ScanResult {
  rows: StepScore[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINE_CAP = 50_000;

const STEP_SCORES_FILE = 'step-scores.jsonl';

// ---------------------------------------------------------------------------
// Core scanner
// ---------------------------------------------------------------------------

/**
 * Scan `<projectRoot>/.agentforge/memory/step-scores.jsonl` and return up to
 * `LINE_CAP` parsed rows. Malformed lines are dropped silently.
 *
 * @returns `{ rows, truncated }` — `truncated` is `true` when LINE_CAP hit.
 */
export async function scanStepScores(projectRoot: string): Promise<ScanResult> {
  const filePath = join(projectRoot, '.agentforge', 'memory', STEP_SCORES_FILE);

  // Gracefully return empty when file does not exist
  const { existsSync } = await import('node:fs');
  if (!existsSync(filePath)) {
    return { rows: [], truncated: false };
  }

  return new Promise<ScanResult>((resolve, reject) => {
    const rows: StepScore[] = [];
    let truncated = false;
    let lineCount = 0;

    const fileStream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      if (truncated) return;

      lineCount++;
      if (lineCount > LINE_CAP) {
        truncated = true;
        rl.close();
        fileStream.destroy();
        return;
      }

      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      try {
        const parsed = JSON.parse(trimmed) as StepScore;
        rows.push(parsed);
      } catch {
        // malformed line — skip
      }
    });

    rl.on('close', () => resolve({ rows, truncated }));
    rl.on('error', reject);
    fileStream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

export type Window = '24h' | '7d' | '30d';

/**
 * Return the ISO cutoff date for a given window relative to now.
 */
export function windowCutoff(window: Window): string {
  const ms: Record<Window, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - ms[window]).toISOString();
}
