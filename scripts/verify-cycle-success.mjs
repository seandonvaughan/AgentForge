#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const opts = {
    projectRoot: process.cwd(),
    cycle: 'latest',
    allowMissingPr: false,
    allowZeroTests: false,
    requireAllTestsPass: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    } else if (arg === '--project-root') {
      opts.projectRoot = argv[++i] ?? opts.projectRoot;
    } else if (arg === '--cycle') {
      opts.cycle = argv[++i] ?? opts.cycle;
    } else if (arg === '--allow-missing-pr') {
      opts.allowMissingPr = true;
    } else if (arg === '--allow-zero-tests') {
      opts.allowZeroTests = true;
    } else if (arg === '--require-all-tests-pass') {
      opts.requireAllTestsPass = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/verify-cycle-success.mjs [--cycle latest|<id>] [--project-root <path>]

Validates that an AgentForge autonomous cycle actually completed:
  - cycle.json stage is completed
  - gateVerdict is APPROVE
  - execute.json has no final failed/blocked items
  - tests are nonzero and have no new failures
  - PR metadata is present

Strict test flag:
  --require-all-tests-pass

Fixture-only flags:
  --allow-missing-pr
  --allow-zero-tests`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveCycleId(projectRoot, cycleArg) {
  if (cycleArg !== 'latest') return cycleArg;
  const cyclesDir = join(projectRoot, '.agentforge', 'cycles');
  if (!existsSync(cyclesDir)) {
    throw new Error(`cycles directory does not exist: ${cyclesDir}`);
  }
  const dirs = readdirSync(cyclesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      mtimeMs: readCycleMtime(projectRoot, entry.name),
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (dirs.length === 0) {
    throw new Error(`no cycle directories found in ${cyclesDir}`);
  }
  return dirs[0].name;
}

function readCycleMtime(projectRoot, cycleId) {
  const cyclePath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'cycle.json');
  if (!existsSync(cyclePath)) return 0;
  try {
    const cycle = readJson(cyclePath);
    const completed = Date.parse(String(cycle.completedAt ?? ''));
    const started = Date.parse(String(cycle.startedAt ?? ''));
    return Number.isFinite(completed) ? completed : Number.isFinite(started) ? started : 0;
  } catch {
    return 0;
  }
}

function hasPrMetadata(projectRoot, cycleId, cycle) {
  const pr = cycle.pr && typeof cycle.pr === 'object' ? cycle.pr : {};
  if (typeof pr.url === 'string' && pr.url.length > 0) return true;
  if (typeof pr.number === 'number' && pr.number > 0) return true;

  const prsPath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'agent-prs.json');
  if (!existsSync(prsPath)) return false;
  try {
    const entries = readJson(prsPath);
    return Array.isArray(entries) && entries.some((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (typeof entry.cycleId === 'string' && entry.cycleId !== cycleId) return false;
      return (
        (typeof entry.prUrl === 'string' && entry.prUrl.length > 0) ||
        (typeof entry.prNumber === 'number' && entry.prNumber > 0)
      );
    });
  } catch {
    return false;
  }
}

function validate(opts) {
  const projectRoot = resolve(opts.projectRoot);
  const cycleId = resolveCycleId(projectRoot, opts.cycle);
  const cyclePath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'cycle.json');
  const executePath = join(projectRoot, '.agentforge', 'cycles', cycleId, 'phases', 'execute.json');
  const failures = [];

  if (!existsSync(cyclePath)) {
    throw new Error(`cycle.json not found: ${cyclePath}`);
  }
  if (!existsSync(executePath)) {
    throw new Error(`execute.json not found: ${executePath}`);
  }

  const cycle = readJson(cyclePath);
  const execute = readJson(executePath);

  if (cycle.stage !== 'completed') {
    failures.push(`cycle stage is ${JSON.stringify(cycle.stage)}, expected "completed"`);
  }
  if (cycle.gateVerdict !== 'APPROVE') {
    failures.push(`gateVerdict is ${JSON.stringify(cycle.gateVerdict)}, expected "APPROVE"`);
  }

  const itemResults = Array.isArray(execute.itemResults) ? execute.itemResults : [];
  if (itemResults.length === 0) {
    failures.push('execute.itemResults is empty; expected final execute results');
  }
  const badItems = itemResults.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    return row.status === 'failed' || row.status === 'blocked';
  });
  if (badItems.length > 0) {
    failures.push(
      `execute has final failed/blocked items: ${badItems
        .map((row) => `${row.itemId ?? '(unknown)'}:${row.status}`)
        .join(', ')}`,
    );
  }

  const tests = cycle.tests && typeof cycle.tests === 'object' ? cycle.tests : {};
  const testsTotal = Number(tests.total ?? 0);
  const testsPassed = Number(tests.passed ?? 0);
  const testsFailed = Number(tests.failed ?? 0);
  const hasNewFailures = Array.isArray(tests.newFailures);
  const newFailures = hasNewFailures ? tests.newFailures.length : 0;
  if (!opts.allowZeroTests && testsTotal <= 0) {
    failures.push('cycle tests.total is 0; expected nonzero verification evidence');
  }
  if (testsTotal > 0 && !hasNewFailures) {
    failures.push('cycle tests.newFailures is missing; cannot verify regression status');
  }
  if (testsTotal > 0 && newFailures > 0) {
    failures.push(`cycle has new test failures: newFailures=${newFailures}`);
  }
  if (opts.requireAllTestsPass && testsTotal > 0 && (testsPassed !== testsTotal || testsFailed !== 0)) {
    failures.push(`tests not fully green: passed=${testsPassed}/${testsTotal} failed=${testsFailed}`);
  }

  if (!opts.allowMissingPr && !hasPrMetadata(projectRoot, cycleId, cycle)) {
    failures.push('cycle has no PR metadata in cycle.json or agent-prs.json');
  }

  if (failures.length > 0) {
    console.error(`[verify:cycle-success] FAILED cycle=${cycleId}`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  if (testsTotal > 0 && testsFailed > 0) {
    console.warn(
      `[verify:cycle-success] WARN baseline/pre-existing test failures present: failed=${testsFailed} newFailures=${newFailures}`,
    );
  }
  console.log(`[verify:cycle-success] PASS cycle=${cycleId}`);
}

try {
  validate(parseArgs(process.argv.slice(2)));
} catch (err) {
  console.error(`[verify:cycle-success] ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
