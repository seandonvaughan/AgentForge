import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

interface StepScoreEntry {
  timestamp: string;
  agent_id: string;
  capability_tag: string;
  step_score: number;
  cost_usd: number;
}

interface AggregateStats {
  capability_tag: string;
  agent_id: string;
  count: number;
  p50: number;
  p95: number;
  mean_cost: number;
}

export function registerReplayCommand(program: Command): void {
  const replay = program
    .command('replay')
    .description('Inspect step-score replay data from autonomous cycles');

  replay
    .command('step-scores')
    .description('Show step-score aggregates grouped by (agent_id, capability_tag)')
    .option('--since <period>', 'Filter by time period: 24h, 7d, 30d, or ISO date', '7d')
    .option('--project-root <path>', 'Project root', process.cwd())
    .option('--json', 'Output as JSON')
    .action(async (commandOptions: {
      since: string;
      projectRoot: string;
      json?: boolean;
    }) => {
      try {
        await showStepScores(commandOptions);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

async function showStepScores(opts: {
  since: string;
  projectRoot: string;
  json?: boolean;
}): Promise<void> {
  const ledgerPath = join(opts.projectRoot, '.agentforge', 'memory', 'step-scores.jsonl');

  if (!existsSync(ledgerPath)) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'step-scores.jsonl not found', results: [] }));
    } else {
      console.log('No step-score replay data found.');
    }
    return;
  }

  const cutoffTime = parseSincePeriod(opts.since);
  const entries = await readStepScoresFromFile(ledgerPath);
  const filtered = entries.filter(e => new Date(e.timestamp) >= cutoffTime);

  const grouped = new Map<string, StepScoreEntry[]>();
  for (const entry of filtered) {
    const key = `${entry.agent_id}|${entry.capability_tag}`;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(entry);
  }

  const results: AggregateStats[] = [];
  for (const [key, entries] of grouped) {
    const parts = key.split('|');
    const agentId = parts[0] ?? '';
    const capabilityTag = parts[1] ?? '';
    const scores = entries.map(e => e.step_score).sort((a, b) => a - b);
    const costs = entries.map(e => e.cost_usd);

    const p50 = scores[Math.floor(scores.length * 0.5)] ?? 0;
    const p95 = scores[Math.floor(scores.length * 0.95)] ?? 0;
    const meanCost = costs.reduce((a, b) => a + b, 0) / costs.length;

    results.push({
      agent_id: agentId,
      capability_tag: capabilityTag,
      count: entries.length,
      p50,
      p95,
      mean_cost: meanCost,
    });
  }

  if (opts.json) {
    console.log(JSON.stringify({ results }, null, 2));
  } else {
    if (results.length === 0) {
      console.log('No step-score data found for the specified period.');
      return;
    }

    console.log('Step-Score Replay');
    console.log(`Period: ${opts.since}`);
    console.log(`Records: ${filtered.length}`);
    console.log('');
    console.log('Agent ID / Capability Tag                           | Count | p50  | p95  | Mean Cost');
    console.log('-'.repeat(85));

    for (const stat of results) {
      const label = `${stat.agent_id} / ${stat.capability_tag}`;
      const padded = label.padEnd(50);
      const costStr = `$${stat.mean_cost.toFixed(4)}`;
      console.log(`${padded} | ${String(stat.count).padStart(5)} | ${stat.p50.toFixed(2)} | ${stat.p95.toFixed(2)} | ${costStr}`);
    }
  }
}

function parseSincePeriod(period: string): Date {
  const now = new Date();

  if (period.includes('h') || period.includes('d') || period.includes('w')) {
    // Simple relative time parsing
    const match = period.match(/^(\d+)([hdw])$/);
    if (match && match[1] && match[2]) {
      const value = Number.parseInt(match[1], 10);
      const unit = match[2];
      const msPerUnit: Record<string, number> = {
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
      };
      const ms = msPerUnit[unit];
      if (ms) {
        return new Date(now.getTime() - value * ms);
      }
    }
  }

  // Try parsing as ISO date
  try {
    const parsed = new Date(period);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  } catch {
    // fall through
  }

  // Default fallback
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

async function readStepScoresFromFile(filePath: string): Promise<StepScoreEntry[]> {
  const entries: StepScoreEntry[] = [];

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filePath),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    rl.on('line', (line: string) => {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as StepScoreEntry;
          entries.push(entry);
        } catch {
          // Silently skip malformed lines
        }
      }
    });

    rl.on('close', () => {
      resolve(entries);
    });

    rl.on('error', (err: Error) => {
      reject(err);
    });
  });
}
