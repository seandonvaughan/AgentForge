#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function findAgentForgeRoot(start) {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, '.agentforge')) &&
      existsSync(join(current, 'packages', 'mcp-server', 'dist', 'index.js'))
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
    if (existsSync(join(root, 'packages', 'mcp-server', 'dist', 'index.js'))) {
      return root;
    }
  }

  return findAgentForgeRoot(process.cwd());
}

const projectRoot = resolveProjectRoot();
if (!projectRoot) {
  process.stderr.write(
    [
      '[agentforge-codex] Could not locate AgentForge project root.',
      'Set AGENTFORGE_PROJECT_ROOT to the AgentForge repo and run corepack pnpm build.',
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
await import(pathToFileURL(serverPath).href);
