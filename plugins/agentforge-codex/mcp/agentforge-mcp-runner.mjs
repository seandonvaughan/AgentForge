#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function hasBuiltMcpServer(root) {
  return existsSync(join(root, 'packages', 'mcp-server', 'dist', 'index.js'));
}

function hasBuiltCli(root) {
  return existsSync(join(root, 'packages', 'cli', 'dist', 'bin.js'));
}

function findAgentForgeRoot(start) {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, '.agentforge')) &&
      hasBuiltMcpServer(current)
    ) {
      return current;
    }

    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function resolveProjectRoot() {
  const configuredRoot = process.env.AGENTFORGE_PROJECT_ROOT;
  if (configuredRoot) {
    const root = resolve(configuredRoot);
    if (hasBuiltMcpServer(root)) {
      return root;
    }

    process.stderr.write(
      [
        `[agentforge-codex] AGENTFORGE_PROJECT_ROOT is set but not ready: ${root}`,
        `Expected MCP build output: ${join(root, 'packages', 'mcp-server', 'dist', 'index.js')}`,
        'Run from that repo: corepack enable && corepack pnpm install && corepack pnpm build',
        '',
      ].join('\n'),
    );
    return null;
  }

  return findAgentForgeRoot(process.cwd());
}

const projectRoot = resolveProjectRoot();
if (!projectRoot) {
  process.stderr.write(
    [
      '[agentforge-codex] Could not locate AgentForge project root.',
      `Current working directory: ${process.cwd()}`,
      'Set AGENTFORGE_PROJECT_ROOT to the AgentForge repo root.',
      'Then run: corepack enable && corepack pnpm install && corepack pnpm build',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const rootManifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
if (rootManifest.name !== 'agentforge') {
  process.stderr.write(`[agentforge-codex] AGENTFORGE_PROJECT_ROOT is not AgentForge: ${projectRoot}\n`);
  process.exit(1);
}

process.env.AGENTFORGE_PROJECT_ROOT = projectRoot;
process.chdir(projectRoot);

const serverPath = join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');
if (!hasBuiltCli(projectRoot)) {
  process.stderr.write(
    [
      '[agentforge-codex] Warning: AgentForge CLI build output is missing.',
      `Expected CLI build output: ${join(projectRoot, 'packages', 'cli', 'dist', 'bin.js')}`,
      'MCP startup can continue, but af_codex_readiness and af_cycle_preview require the built CLI.',
      'Run: corepack pnpm build',
      '',
    ].join('\n'),
  );
}

await import(pathToFileURL(serverPath).href);
