/**
 * `agentforge demo --project <path>`
 *
 * End-to-end scan-only smoke test against an external project.
 * Lets a new user verify their setup works without spending LLM budget.
 *
 * Steps:
 *  1. Validate the target path exists and contains a .git/ directory.
 *  2. Run runFullScan (legacy scanner — fast, no LLM).
 *  3. Print scan summary: files, subsystems (directory_structure), primary language.
 *  4. Run buildSourceCorpus — print file count + total chars.
 *  5. Run forgeTeam (legacy deterministic path unless runtime is available
 *     AND --legacy is NOT set).
 *  6. Read .agentforge/team.yaml and print agent count + 5 sample IDs.
 *  7. Print completion message with next-step hint.
 */

import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import yaml from 'js-yaml';
import {
  runFullScan,
  buildSourceCorpus,
  forgeTeam,
} from '@agentforge/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DemoOptions {
  project: string;
  legacy?: boolean;
}

interface TeamYaml {
  agents?: {
    strategic?: string[];
    implementation?: string[];
    quality?: string[];
    utility?: string[];
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Core logic (exported for direct invocation in tests)
// ---------------------------------------------------------------------------

/**
 * Run the demo command against the given options.
 *
 * Returns exit code: 0 on success, 1 on any error.
 */
export async function runDemo(options: DemoOptions): Promise<number> {
  const projectRoot = resolve(options.project);

  // ── Step 1: validate path and .git presence ──────────────────────────────

  try {
    await access(projectRoot);
  } catch {
    console.error(`Error: project path does not exist: ${projectRoot}`);
    return 1;
  }

  const gitDir = join(projectRoot, '.git');
  try {
    await access(gitDir);
  } catch {
    console.error(
      `Error: ${projectRoot} is not a git repository (no .git/ directory found).\n` +
        `Run \`git init\` in your project first, or pass a valid git repo path with --project.`,
    );
    return 1;
  }

  console.log(`\nAgentForge demo against ${projectRoot}`);
  console.log('─'.repeat(60));

  // ── Step 2: full scan ─────────────────────────────────────────────────────

  console.log('\n[1/4] Running full project scan…');
  let scanResult;
  try {
    scanResult = await runFullScan(projectRoot);
  } catch (error) {
    console.error(
      `Error during project scan: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // ── Step 3: print scan summary ────────────────────────────────────────────

  const { files: fileScan } = scanResult;
  const totalFiles = fileScan.total_files;
  const subsystemCount = fileScan.directory_structure.length;

  // Determine primary language by file count
  const langEntries = Object.entries(fileScan.languages) as [string, number][];
  langEntries.sort((a, b) => b[1] - a[1]);
  const primaryLang = langEntries[0]?.[0] ?? 'unknown';

  console.log(
    `     ${totalFiles} files, ${subsystemCount} subsystems, primary language: ${primaryLang}`,
  );

  // ── Step 4: source corpus ─────────────────────────────────────────────────

  console.log('\n[2/4] Building source corpus…');
  let corpusResult;
  try {
    corpusResult = await buildSourceCorpus({ projectRoot });
  } catch (error) {
    console.error(
      `Error building source corpus: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  console.log(
    `     ${corpusResult.files.length} files, ${corpusResult.totalChars} chars chosen`,
  );

  // ── Step 5: forge team ────────────────────────────────────────────────────

  console.log('\n[3/4] Forging agent team…');

  const useLegacy = determineLegacyMode(options.legacy);

  if (!useLegacy) {
    // Agent-driven path not wired in demo — inform and fall back gracefully
    console.log(
      '     (would run agent-driven forge with runtime — not yet wired in demo path)',
    );
    console.log('     Falling back to deterministic legacy forge…');
  }

  try {
    await forgeTeam(projectRoot, { strategy: 'legacy' });
  } catch (error) {
    console.error(
      `Error forging team: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  // ── Step 6: read team.yaml ────────────────────────────────────────────────

  console.log('\n[4/4] Reading generated team…');

  const teamYamlPath = join(projectRoot, '.agentforge', 'team.yaml');
  let teamData: TeamYaml;
  try {
    const raw = await readFile(teamYamlPath, 'utf-8');
    teamData = yaml.load(raw) as TeamYaml;
  } catch (error) {
    console.error(
      `Error reading .agentforge/team.yaml: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const allAgents: string[] = [
    ...(teamData.agents?.strategic ?? []),
    ...(teamData.agents?.implementation ?? []),
    ...(teamData.agents?.quality ?? []),
    ...(teamData.agents?.utility ?? []),
  ];

  const agentCount = allAgents.length;
  const sampleIds = allAgents.slice(0, 5);

  console.log(`     ${agentCount} agents generated`);
  if (sampleIds.length > 0) {
    console.log(`     Sample agent IDs: ${sampleIds.join(', ')}`);
  }

  // ── Step 7: completion message ────────────────────────────────────────────

  console.log('\n─'.repeat(60));
  console.log('Demo complete.');
  console.log(
    `Run \`cd ${projectRoot} && agentforge cycle\` to start the autonomous loop.`,
  );
  console.log('');

  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether to use the legacy deterministic forge path.
 *
 * Always legacy when:
 *   - `--legacy` flag is set
 *   - No AGENTFORGE_FORGE_STRATEGY=agent-driven env var is set
 *
 * The demo command never attempts to wire up a real runtime; agent-driven
 * output is intentionally deferred to a future milestone.
 */
function determineLegacyMode(legacyFlag: boolean | undefined): boolean {
  if (legacyFlag === true) return true;
  // Only treat as non-legacy if the user has explicitly opted into agent-driven
  // via env var — but even then the demo path still runs legacy forge.
  return true;
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

/**
 * Register the `demo` command on a Commander program instance.
 */
export function registerDemoCommand(program: Command): void {
  program
    .command('demo')
    .description(
      'Run an end-to-end scan-only smoke test against an external project to verify your setup',
    )
    .requiredOption('--project <path>', 'Path to the external project to demo against')
    .option('--legacy', 'Force the deterministic legacy forge path (default: auto-detect)')
    .action(async (opts: DemoOptions) => {
      const exitCode = await runDemo(opts);
      if (exitCode !== 0) {
        process.exitCode = exitCode;
      }
    });
}
