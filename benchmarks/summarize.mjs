#!/usr/bin/env node
/**
 * benchmarks/summarize.mjs
 *
 * Thin CLI for aggregating benchmark result JSON files.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBenchmarkResults } from './lib/summarize.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = resolve(__dirname, 'results');

function printHelp() {
  process.stdout.write(`
AgentForge Benchmark Summary
============================

Aggregates benchmark result files from benchmarks/results/*.json.

USAGE
  node benchmarks/summarize.mjs [options]

OPTIONS
  --json     Print the summary object as JSON.
  --help     Print this message and exit 0.

`);
}

function parseArgs(argv) {
  const opts = {
    help: false,
    json: false,
  };

  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else {
      process.stderr.write(`[benchmark-summary] ERROR: Unknown option: ${arg}\n`);
      process.stderr.write('Run with --help for usage.\n');
      process.exit(1);
    }
  }

  return opts;
}

function readResults() {
  if (!existsSync(RESULTS_DIR)) {
    return [];
  }

  const files = readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const results = [];
  for (const file of files) {
    const filePath = join(RESULTS_DIR, file);
    try {
      results.push(JSON.parse(readFileSync(filePath, 'utf8')));
    } catch (err) {
      process.stderr.write(
        `[benchmark-summary] WARN: Skipping malformed result ${file}: ${err.message ?? err}\n`
      );
    }
  }

  return results;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}

function printTable(summary) {
  const rows = [
    ['Runs', String(summary.runs)],
    ['Fully succeeded runs', String(summary.fullySucceededRuns)],
    ['Merged-PR success rate', formatPercent(summary.mergedPrSuccessRate)],
    ['Total merged PRs', String(summary.totalMergedPrs)],
    ['Mean $/cycle', formatUsd(summary.meanUsd)],
    ['Total $', formatUsd(summary.totalUsd)],
    ['Mean tests passed', summary.meanTestsPassed.toFixed(2)],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  process.stdout.write('AgentForge Benchmark Summary\n');
  process.stdout.write('----------------------------\n');
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(labelWidth)}  ${value}\n`);
  }
}

const opts = parseArgs(process.argv);
if (opts.help) {
  printHelp();
  process.exit(0);
}

const summary = summarizeBenchmarkResults(readResults());
if (opts.json) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  printTable(summary);
}
