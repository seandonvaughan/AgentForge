// packages/cli/src/commands/claude-setup.ts
//
// W7 — `agentforge claude setup`: make a forged project operable from inside
// a Claude Code session.
//
//   1. Merges an `agentforge` entry into the project's `.mcp.json` so Claude
//      Code discovers the AgentForge MCP server (preview/status/events/
//      invoke/kb/memory tools).
//   2. Re-emits `.claude/agents/<id>.md` mirrors from the committed
//      `.agentforge/agents/*.yaml` when missing — `.claude/` is gitignored,
//      so fresh clones have the YAMLs but not the Claude Code mirrors.
//
// Both steps are idempotent; existing user config is preserved (merge, never
// overwrite other servers).

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { load } from 'js-yaml';
import { emitClaudeCodeAgents, type ClaudeCodeAgentSpec } from '@agentforge/core';

interface ClaudeSetupOptions {
  projectRoot: string;
  /** Override the MCP server entry path (mostly for tests). */
  mcpServerPath?: string;
}

/**
 * Locate the AgentForge MCP server entry. Walks up from this module looking
 * for the monorepo layout (packages/mcp-server/dist/index.js), then falls
 * back to the same layout under the target project root (self-hosted dev).
 */
export function resolveMcpServerPath(projectRoot: string, fromDir?: string): string | null {
  const relative = join('packages', 'mcp-server', 'dist', 'index.js');
  let dir = fromDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const inProject = join(projectRoot, relative);
  return existsSync(inProject) ? inProject : null;
}

interface SetupResult {
  mcpJsonPath: string;
  mcpServerPath: string | null;
  mcpUpdated: boolean;
  agentsEmitted: string[];
}

export async function runClaudeSetup(options: ClaudeSetupOptions): Promise<SetupResult> {
  const projectRoot = resolve(options.projectRoot);
  const result: SetupResult = {
    mcpJsonPath: join(projectRoot, '.mcp.json'),
    mcpServerPath: options.mcpServerPath ?? resolveMcpServerPath(projectRoot),
    mcpUpdated: false,
    agentsEmitted: [],
  };

  // ── 1. Merge .mcp.json ────────────────────────────────────────────────────
  if (result.mcpServerPath) {
    let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(result.mcpJsonPath)) {
      try {
        mcpConfig = JSON.parse(readFileSync(result.mcpJsonPath, 'utf8')) as typeof mcpConfig;
      } catch {
        throw new Error(`${result.mcpJsonPath} exists but is not valid JSON — fix or remove it first.`);
      }
    }
    const servers = (mcpConfig.mcpServers ??= {});
    const desired = {
      command: 'node',
      args: [result.mcpServerPath],
      env: { AGENTFORGE_PROJECT_ROOT: projectRoot },
    };
    if (JSON.stringify(servers['agentforge']) !== JSON.stringify(desired)) {
      servers['agentforge'] = desired;
      writeFileSync(result.mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
      result.mcpUpdated = true;
    }
  }

  // ── 2. Re-emit missing .claude/agents mirrors ─────────────────────────────
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  if (existsSync(agentsDir)) {
    const specs: ClaudeCodeAgentSpec[] = [];
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.yaml')) continue;
      const id = file.replace(/\.yaml$/, '');
      if (existsSync(join(projectRoot, '.claude', 'agents', `${id}.md`))) continue;
      try {
        const parsed = load(readFileSync(join(agentsDir, file), 'utf8')) as {
          name?: string;
          model?: string;
          description?: string;
          system_prompt?: string;
        };
        if (!parsed?.system_prompt) continue;
        const model = parsed.model;
        specs.push({
          id,
          description: parsed.description ?? `AgentForge agent ${id}`,
          systemPrompt: parsed.system_prompt,
          ...(model === 'fable' || model === 'opus' || model === 'sonnet' || model === 'haiku'
            ? { model }
            : {}),
        });
      } catch {
        // skip unparseable agent yaml — setup must not hard-fail on one file
      }
    }
    if (specs.length > 0) {
      const emitted = await emitClaudeCodeAgents({ projectRoot, agents: specs });
      result.agentsEmitted = emitted.written;
    }
  }

  return result;
}

export function registerClaudeCommand(program: Command): void {
  const claude = program
    .command('claude')
    .description('Claude Code integration helpers');

  claude
    .command('setup')
    .description('Wire this project for Claude Code sessions: register the AgentForge MCP server in .mcp.json and re-emit missing .claude/agents mirrors from .agentforge/agents YAMLs')
    .option('--project-root <path>', 'Project root', process.cwd())
    .action(async (opts: ClaudeSetupOptions) => {
      try {
        const result = await runClaudeSetup(opts);
        if (!result.mcpServerPath) {
          console.warn('[claude setup] MCP server build not found (packages/mcp-server/dist/index.js) — run `corepack pnpm build` first; .mcp.json left untouched.');
        } else {
          console.log(
            result.mcpUpdated
              ? `[claude setup] Registered agentforge MCP server in ${result.mcpJsonPath}`
              : `[claude setup] ${result.mcpJsonPath} already up to date`,
          );
        }
        console.log(
          result.agentsEmitted.length > 0
            ? `[claude setup] Emitted ${result.agentsEmitted.length} missing .claude/agents mirror(s)`
            : '[claude setup] .claude/agents mirrors already present',
        );
        console.log('[claude setup] Done. Open a Claude Code session in this project to use the agentforge MCP tools.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
