#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllCommands } from './commands/registry.js';

const CLI_VERSION = readPackageVersion();
export function createCliProgram(): Command {
const program = new Command();
program
  .name('agentforge')
  .description('AgentForge package-canonical CLI (run/cost/cycle/workspaces are package-native; team generation/reforge run through package team services)')
  .version(CLI_VERSION);

registerAllCommands(program);

return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const program = createCliProgram();
  await program.parseAsync(argv);
}

if (isDirectCliEntry(import.meta.url, process.argv[1])) {
  void runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isDirectCliEntry(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return fileURLToPath(metaUrl) === resolve(argvEntry);
}
