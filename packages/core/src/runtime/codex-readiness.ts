import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import yaml from 'js-yaml';
import type { ModelTier } from '@agentforge/shared';
import { resolveProviderModelProfile } from './model-profiles.js';
import { resolveCodexAuth, type CodexAuthStatus } from './codex-auth.js';
import { isCodexRuntimeAvailable } from './execution-service-mode.js';
import {
  buildCodexSpawnCommand,
  resolveCodexSpawnLaunchKind,
  type CodexSpawnLaunchKind,
  type CodexSpawnCommandOptions,
} from './transports/codex-cli-transport.js';

const VALID_TIERS = new Set<ModelTier>(['fable', 'opus', 'sonnet', 'haiku']);
const VALID_CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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

export type CodexExecProbeStatus =
  | 'skipped'
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'spawn-error'
  | 'resolution-error';

export interface CodexExecProbeResult {
  checked: boolean;
  ok: boolean | null;
  status: CodexExecProbeStatus;
  launchKind?: CodexSpawnLaunchKind;
  exitCode?: number | null;
  durationMs?: number;
  message?: string;
}

interface CodexReadinessSpawnResult {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
}

type CodexReadinessSpawnOptions = SpawnSyncOptionsWithStringEncoding & {
  input?: string;
};

type CodexExecProbeRunner = (
  command: string,
  args: string[],
  options: CodexReadinessSpawnOptions,
) => CodexReadinessSpawnResult;

export interface CodexReadinessReport {
  projectRoot: string;
  codexCliAvailable: boolean;
  codexCliLaunchKind?: CodexSpawnLaunchKind;
  codexExecProbeChecked: boolean;
  codexExecProbeOk: boolean | null;
  codexExecProbeStatus: CodexExecProbeStatus;
  codexExecProbeLaunchKind?: CodexSpawnLaunchKind;
  codexExecProbeExitCode?: number | null;
  codexExecProbeDurationMs?: number;
  codexExecProbeMessage?: string;
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
  /** File-based auth state from CODEX_HOME/auth.json (item 4 — no subprocess). */
  codexAuthStatus: CodexAuthStatus;
  codexAuthReason: string;
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
  codexSpawnOptions?: CodexSpawnCommandOptions;
  runCodexExecProbe?: CodexExecProbeRunner;
} = {}): CodexReadinessReport {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const codexSpawnOptions = { ...options.codexSpawnOptions, env };
  const agents = readAgentProfiles(projectRoot, env);
  const codexCliLaunchKind = resolveCodexSpawnLaunchKind(['--version'], codexSpawnOptions);
  const codexCliAvailable = options.codexCliAvailable ?? isCodexRuntimeAvailable(codexSpawnOptions);
  const execProbe = checkCodexExecProbe({
    projectRoot,
    codexCliAvailable,
    codexSpawnOptions,
    env,
    ...(options.runCodexExecProbe ? { runCodexExecProbe: options.runCodexExecProbe } : {}),
  });
  const mcpServerPath = options.mcpServerPath
    ? resolve(options.mcpServerPath)
    : join(projectRoot, 'packages', 'mcp-server', 'dist', 'index.js');
  const mcpServerAvailable = existsSync(mcpServerPath);
  const doctor = options.checkDoctor === false || !codexCliAvailable
    ? { checked: false, ok: null as boolean | null, status: undefined as string | undefined, version: undefined as string | undefined, checks: undefined as CodexDoctorCheck[] | undefined, message: undefined as string | undefined }
    : checkCodexDoctor(options.doctorJson, codexSpawnOptions);
  const login = options.checkLogin === false
    ? { checked: false, ok: null as boolean | null, message: undefined as string | undefined }
    : checkCodexLogin(codexSpawnOptions);
  const codexAuth = resolveCodexAuth(env);

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
  if (execProbe.checked && execProbe.ok === false) {
    warnings.push(
      `codex exec preflight failed (${execProbe.status}` +
        `${execProbe.exitCode !== undefined ? `, exit ${execProbe.exitCode ?? 'null'}` : ''}` +
        `): ${execProbe.message ?? 'no diagnostic output'}`,
    );
  }
  if (doctor.checked && doctor.ok === false) {
    warnings.push(doctor.message ?? `codex doctor reported ${doctor.status ?? 'a failing status'}.`);
  }
  if (doctor.checked && doctor.ok === null && doctor.message) {
    warnings.push(doctor.message);
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
    ...(codexCliLaunchKind ? { codexCliLaunchKind } : {}),
    codexExecProbeChecked: execProbe.checked,
    codexExecProbeOk: execProbe.ok,
    codexExecProbeStatus: execProbe.status,
    ...(execProbe.launchKind ? { codexExecProbeLaunchKind: execProbe.launchKind } : {}),
    ...(execProbe.exitCode !== undefined ? { codexExecProbeExitCode: execProbe.exitCode } : {}),
    ...(execProbe.durationMs !== undefined ? { codexExecProbeDurationMs: execProbe.durationMs } : {}),
    ...(execProbe.message ? { codexExecProbeMessage: execProbe.message } : {}),
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
    codexAuthStatus: codexAuth.status,
    codexAuthReason: codexAuth.reason,
    agents,
    warnings,
    ready: agents.length > 0
      && agents.every((agent) => agent.valid)
      && codexCliAvailable
      && execProbe.checked
      && execProbe.ok === true
      && (!doctor.checked || doctor.ok !== false)
      && mcpServerAvailable
      && (!login.checked || login.ok === true),
  };
}

function checkCodexExecProbe(options: {
  projectRoot: string;
  codexCliAvailable: boolean;
  codexSpawnOptions: CodexSpawnCommandOptions;
  runCodexExecProbe?: CodexExecProbeRunner;
  env: NodeJS.ProcessEnv;
}): CodexExecProbeResult {
  if (!options.codexCliAvailable) {
    return {
      checked: false,
      ok: null,
      status: 'skipped',
    };
  }

  let command;
  try {
    command = buildCodexSpawnCommand(buildCodexExecProbeArgs(options.projectRoot), options.codexSpawnOptions);
  } catch (err) {
    return {
      checked: true,
      ok: false,
      status: 'resolution-error',
      message: redactReadinessText(err instanceof Error ? err.message : String(err), options),
    };
  }

  const run = options.runCodexExecProbe ?? spawnSync;
  const startedAt = Date.now();
  const result = run(command.command, command.args, {
    encoding: 'utf8',
    input: 'Reply with exactly: agentforge-codex-readiness-ok',
    timeout: 30_000,
    windowsHide: true,
    ...(command.env ? { env: command.env } : {}),
  });
  const durationMs = Date.now() - startedAt;
  const base = {
    checked: true,
    launchKind: command.launchKind,
    durationMs,
  };

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ...base,
      ok: false,
      status: code === 'ETIMEDOUT' ? 'timed-out' : 'spawn-error',
      ...(result.status !== undefined ? { exitCode: result.status } : {}),
      message: redactReadinessText(result.error.message, options),
    };
  }

  if (result.status !== 0) {
    return {
      ...base,
      ok: false,
      status: 'failed',
      exitCode: result.status,
      message: redactReadinessText(formatCodexProbeOutput(result), options),
    };
  }

  return {
    ...base,
    ok: true,
    status: 'passed',
    exitCode: result.status,
    message: 'codex exec preflight completed.',
  };
}

function buildCodexExecProbeArgs(projectRoot: string): string[] {
  return [
    '--ask-for-approval',
    'never',
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--cd',
    projectRoot,
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
  ];
}

function formatCodexProbeOutput(result: CodexReadinessSpawnResult): string {
  const output = [stringifySpawnOutput(result.stderr), stringifySpawnOutput(result.stdout)]
    .filter(Boolean)
    .join('\n')
    .trim();
  return output || `codex exec exited with status ${result.status ?? 'null'}`;
}

function stringifySpawnOutput(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function redactReadinessText(
  value: string,
  options: { projectRoot: string; env: NodeJS.ProcessEnv },
): string {
  let redacted = value;
  const replacements = [
    [options.projectRoot, '[project-root]'],
    [options.env['CODEX_HOME'], '[codex-home]'],
    [options.env['AGENTFORGE_CODEX_BIN'], '[codex-bin]'],
    [options.env['CODEX_CLI_PATH'], '[codex-bin]'],
    [options.env['OPENAI_API_KEY'], '[redacted-secret]'],
    [options.env['ANTHROPIC_API_KEY'], '[redacted-secret]'],
    [options.env['GITHUB_TOKEN'], '[redacted-secret]'],
    [options.env['GH_TOKEN'], '[redacted-secret]'],
  ] as const;

  for (const [from, to] of replacements) {
    if (from?.trim()) {
      redacted = redacted.split(from).join(to);
    }
  }

  redacted = redacted
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, '[redacted-secret]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, '[redacted-secret]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-secret]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-secret]');

  return redacted.trim().slice(0, 500);
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

function checkCodexLogin(codexSpawnOptions: CodexSpawnCommandOptions): { checked: boolean; ok: boolean | null; message?: string } {
  let command;
  try {
    command = buildCodexSpawnCommand(['login', 'status'], codexSpawnOptions);
  } catch (err) {
    return {
      checked: true,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
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

function checkCodexDoctor(doctorJson: string | undefined, codexSpawnOptions: CodexSpawnCommandOptions): {
  checked: boolean;
  ok: boolean | null;
  status?: string;
  version?: string;
  checks?: CodexDoctorCheck[];
  message?: string;
} {
  let raw = doctorJson;
  if (raw === undefined) {
    let command;
    try {
      command = buildCodexSpawnCommand(['doctor', '--json'], codexSpawnOptions);
    } catch (err) {
      return {
        checked: true,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const result = spawnSync(command.command, command.args, {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      ...(command.env ? { env: command.env } : {}),
    });

    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ETIMEDOUT') {
        return {
          checked: true,
          ok: null,
          message: 'codex doctor timed out after 20000ms; continuing with CLI identity and login checks.',
        };
      }
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
