import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { ModelTier } from '@agentforge/shared';
import { resolveProviderModelProfile } from './model-profiles.js';
import { isCodexRuntimeAvailable } from './execution-service-mode.js';

const VALID_TIERS = new Set<ModelTier>(['opus', 'sonnet', 'haiku']);
const VALID_CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_COMMAND = 'codex';

interface AgentYaml {
  name?: string;
  model?: string;
  effort?: string;
}

export interface CodexReadinessAgent {
  agentId: string;
  name: string;
  tier: ModelTier;
  sourceModel?: string;
  sourceEffort?: string;
  codexModel: string;
  codexEffort: string;
  valid: boolean;
}

export interface CodexReadinessReport {
  projectRoot: string;
  codexCliAvailable: boolean;
  mcpServerAvailable: boolean;
  mcpServerPath: string;
  codexLoginChecked: boolean;
  codexLoginOk: boolean | null;
  codexLoginMessage?: string;
  agents: CodexReadinessAgent[];
  warnings: string[];
  ready: boolean;
}

export function buildCodexReadinessReport(options: {
  projectRoot?: string;
  checkLogin?: boolean;
  codexCliAvailable?: boolean;
  mcpServerPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): CodexReadinessReport {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const agents = readAgentProfiles(projectRoot, env);
  const codexCliAvailable = options.codexCliAvailable ?? isCodexRuntimeAvailable();
  const mcpServerPath = options.mcpServerPath
    ? resolve(options.mcpServerPath)
    : join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');
  const mcpServerAvailable = existsSync(mcpServerPath);
  const login = options.checkLogin === false
    ? { checked: false, ok: null as boolean | null, message: undefined as string | undefined }
    : checkCodexLogin();

  const warnings: string[] = [];
  if (agents.length === 0) {
    warnings.push('No agent YAML files found under .agentforge/agents.');
  }
  for (const agent of agents) {
    if (!VALID_TIERS.has((agent.sourceModel ?? agent.tier) as ModelTier)) {
      warnings.push(`${agent.agentId} uses raw model: ${agent.sourceModel}. Use capability tier opus, sonnet, or haiku.`);
    }
    if (!VALID_CODEX_EFFORTS.has(agent.codexEffort)) {
      warnings.push(`${agent.agentId} resolves to unsupported Codex effort "${agent.codexEffort}".`);
    }
  }
  if (!codexCliAvailable) {
    warnings.push('codex CLI is not available on PATH.');
  }
  if (!mcpServerAvailable) {
    warnings.push(`AgentForge MCP server build output is missing: ${mcpServerPath}. Run corepack pnpm build.`);
  }
  if (login.checked && login.ok === false) {
    warnings.push(login.message ?? 'codex login status failed.');
  }

  return {
    projectRoot,
    codexCliAvailable,
    mcpServerAvailable,
    mcpServerPath,
    codexLoginChecked: login.checked,
    codexLoginOk: login.ok,
    ...(login.message ? { codexLoginMessage: login.message } : {}),
    agents,
    warnings,
    ready: agents.length > 0
      && agents.every((agent) => agent.valid)
      && codexCliAvailable
      && mcpServerAvailable
      && (!login.checked || login.ok === true),
  };
}

function readAgentProfiles(projectRoot: string, env: NodeJS.ProcessEnv): CodexReadinessAgent[] {
  const agentsDir = join(projectRoot, '.agentforge', 'agents');
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));
  } catch {
    return [];
  }

  return files.flatMap((file) => {
    const agentId = file.replace(/\.ya?ml$/i, '');
    try {
      const parsed = yaml.load(readFileSync(join(agentsDir, file), 'utf8')) as AgentYaml | null | undefined;
      const rawTier = parsed?.model ?? 'sonnet';
      const validTier = VALID_TIERS.has(rawTier as ModelTier);
      const tier = validTier ? rawTier as ModelTier : 'sonnet';
      const profile = resolveProviderModelProfile('codex-cli', tier, parsed?.effort, env, projectRoot);
      const codexEffort = profile.effort ?? 'medium';
      return [{
        agentId,
        name: parsed?.name ?? agentId,
        tier,
        sourceModel: rawTier,
        ...(parsed?.effort ? { sourceEffort: parsed.effort } : {}),
        codexModel: profile.modelId,
        codexEffort,
        valid: validTier && VALID_CODEX_EFFORTS.has(codexEffort),
      }];
    } catch {
      return [];
    }
  });
}

function checkCodexLogin(): { checked: boolean; ok: boolean | null; message?: string } {
  const command = buildCodexSpawnCommand(['login', 'status']);
  const result = spawnSync(command.command, command.args, {
    encoding: 'utf8',
    timeout: 10_000,
  });

  if (result.error) {
    return {
      checked: true,
      ok: false,
      message: result.error.message,
    };
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return {
    checked: true,
    ok: result.status === 0,
    ...(output ? { message: output } : {}),
  };
}

function buildCodexSpawnCommand(args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: CODEX_COMMAND, args };
  }

  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', [CODEX_COMMAND, ...args.map(quoteCmdArg)].join(' ')],
  };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9._=:/\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
