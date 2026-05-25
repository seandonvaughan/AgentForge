import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import type { ModelTier } from '@agentforge/shared';
import { resolveProviderModelProfile } from './model-profiles.js';
import { isCodexRuntimeAvailable } from './execution-service-mode.js';
import { buildCodexSpawnCommand } from './transports/codex-cli-transport.js';

const VALID_TIERS = new Set<ModelTier>(['opus', 'sonnet', 'haiku']);
const VALID_CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

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

export interface CodexDoctorCheck {
  id: string;
  category?: string;
  status?: string;
  summary?: string;
  remediation?: string | null;
}

export interface CodexReadinessReport {
  projectRoot: string;
  codexCliAvailable: boolean;
  codexDoctorChecked: boolean;
  codexDoctorOk: boolean | null;
  codexDoctorStatus?: string;
  codexDoctorVersion?: string;
  codexDoctorChecks?: CodexDoctorCheck[];
  codexDoctorMessage?: string;
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
  checkDoctor?: boolean;
  doctorJson?: string;
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
  const doctor = options.checkDoctor === false || !codexCliAvailable
    ? { checked: false, ok: null as boolean | null, status: undefined as string | undefined, version: undefined as string | undefined, checks: undefined as CodexDoctorCheck[] | undefined, message: undefined as string | undefined }
    : checkCodexDoctor(options.doctorJson);
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
  if (doctor.checked && doctor.ok === false) {
    warnings.push(doctor.message ?? `codex doctor reported ${doctor.status ?? 'a failing status'}.`);
  }
  for (const check of doctor.checks ?? []) {
    if (check.status === 'warning') {
      warnings.push(`codex doctor warning (${check.id}): ${check.summary ?? 'warning'}`);
    }
    if (check.status === 'error' || check.status === 'fail' || check.status === 'failed') {
      warnings.push(`codex doctor failure (${check.id}): ${check.summary ?? 'failure'}`);
    }
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
    codexDoctorChecked: doctor.checked,
    codexDoctorOk: doctor.ok,
    ...(doctor.status ? { codexDoctorStatus: doctor.status } : {}),
    ...(doctor.version ? { codexDoctorVersion: doctor.version } : {}),
    ...(doctor.checks ? { codexDoctorChecks: doctor.checks } : {}),
    ...(doctor.message ? { codexDoctorMessage: doctor.message } : {}),
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
      && (!doctor.checked || doctor.ok !== false)
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
    windowsHide: true,
    ...(command.env ? { env: command.env } : {}),
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

function checkCodexDoctor(doctorJson?: string): {
  checked: boolean;
  ok: boolean | null;
  status?: string;
  version?: string;
  checks?: CodexDoctorCheck[];
  message?: string;
} {
  let raw = doctorJson;
  if (raw === undefined) {
    const command = buildCodexSpawnCommand(['doctor', '--json']);
    const result = spawnSync(command.command, command.args, {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      ...(command.env ? { env: command.env } : {}),
    });

    if (result.error) {
      return {
        checked: true,
        ok: false,
        message: result.error.message,
      };
    }

    raw = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.status !== 0) {
      return {
        checked: true,
        ok: false,
        message: raw || `codex doctor exited with status ${result.status}`,
      };
    }
  }

  try {
    const parsed = JSON.parse(raw || '{}') as Record<string, unknown>;
    const status = typeof parsed['overallStatus'] === 'string' ? parsed['overallStatus'] : undefined;
    const version = typeof parsed['codexVersion'] === 'string' ? parsed['codexVersion'] : undefined;
    const checksRecord = typeof parsed['checks'] === 'object' && parsed['checks'] !== null
      ? parsed['checks'] as Record<string, unknown>
      : {};
    const checks = Object.values(checksRecord)
      .filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
      .map((value) => ({
        id: typeof value['id'] === 'string' ? value['id'] : 'unknown',
        ...(typeof value['category'] === 'string' ? { category: value['category'] } : {}),
        ...(typeof value['status'] === 'string' ? { status: value['status'] } : {}),
        ...(typeof value['summary'] === 'string' ? { summary: value['summary'] } : {}),
        ...(
          typeof value['remediation'] === 'string' || value['remediation'] === null
            ? { remediation: value['remediation'] as string | null }
            : {}
        ),
      }));
    const ok = status === undefined
      ? true
      : !['error', 'fail', 'failed'].includes(status.toLowerCase());

    return {
      checked: true,
      ok,
      ...(status ? { status } : {}),
      ...(version ? { version } : {}),
      checks,
    };
  } catch (error) {
    return {
      checked: true,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
